from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import httpx
import pytest
from entity_worker.faces import FaceModel
from entity_worker.store import Store
from entity_worker.worker import GatewayGate, Paused, Worker

ROOT=Path(__file__).resolve().parents[1]

def test_gateway_busy_stale_and_unknown_fail_closed():
    gate=GatewayGate('https://gateway.test')
    for status,stamp in [('busy_chat',datetime.now(timezone.utc).isoformat()),('idle','2000-01-01T00:00:00Z')]:
        gate.client=httpx.Client(base_url='https://gateway.test',transport=httpx.MockTransport(lambda request:httpx.Response(200,json=[{'worker_id':'recognition','status':status,'last_heartbeat':stamp}])))
        with pytest.raises(Paused): gate.check()
    gate.client=httpx.Client(base_url='https://gateway.test',transport=httpx.MockTransport(lambda request:httpx.Response(200,json=[])))
    with pytest.raises(Paused): gate.check()


def test_actual_face_model_original_checksum_pts_and_archive_timeline(tmp_path):
    """Real ONNX, ffmpeg and Archive API; in-process HTTP transport, no live device."""
    if not (ROOT/'weights/manifest.json').exists() or not (ROOT/'validation/face-fixture.jpg').exists():
        pytest.skip('official model weights / public fixture not downloaded')
    sys.path.insert(0,str(ROOT.parent/'archive'))
    from app.archive import Archive
    from app.archive_api import install_archive_routes
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    source=tmp_path/'source.mov'
    subprocess.run(['ffmpeg','-nostdin','-v','error','-loop','1','-i',str(ROOT/'validation/face-fixture.jpg'),
        '-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2.2','-r','10','-c:v','libx264',
        '-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest',str(source)],check=True,timeout=30)
    archive=Archive(tmp_path/'archive.sqlite',tmp_path/'originals',reserve_bytes=0)
    archive.put_clip(source,'capture-a',0,'2026-10-09T16:00:00Z',duration_seconds=2.2)
    app=FastAPI(); install_archive_routes(app,archive); api=TestClient(app)
    def transport(request):
        response=api.request(request.method,request.url.path,params=dict(request.url.params),content=request.content,
            headers={'Content-Type':request.headers.get('content-type','application/json')})
        return httpx.Response(response.status_code,content=response.content,headers=dict(response.headers))
    class Idle:
        def check(self): pass
    store=Store(tmp_path/'entities.sqlite')
    model=FaceModel(ROOT/'weights')
    worker=Worker(store,'http://archive.test',model,Idle())
    worker.archive=httpx.Client(base_url='http://archive.test',transport=httpx.MockTransport(transport))
    assert worker.tick()
    timeline=archive.timeline(kind='face')['items']
    assert len(timeline)==3
    assert [event['media_refs'][0]['start_offset_seconds'] for event in timeline]==[0.,1.,2.]
    assert all(event['body']['observations'][0]['entity_id'] for event in timeline)
    ids={event['body']['observations'][0]['entity_id'] for event in timeline}
    assert len(ids)==1
    assert len(store.pending_events())==0
    assert hashlib.sha256(archive.media_path(timeline[0]['media_refs'][0]['media_id']).read_bytes()).hexdigest()==timeline[0]['body']['original_sha256']
    # Backfill arriving later but captured yesterday must be discovered by ingest cursor.
    archive.put_clip(source,'capture-old',0,'2026-10-08T16:00:00Z',duration_seconds=2.2)
    assert worker.tick()
    assert len(archive.timeline(kind='face')['items'])==6
    assert len(store.list_entities())==1


def test_rejected_event_is_durable_visible_and_does_not_block_valid_events(tmp_path):
    from entity_worker.store import canonical
    class Idle:
        def check(self):pass
    store=Store(tmp_path/'entities.sqlite')
    rejected={'event_id':'bad','kind':'face','body':{'sample_id':'repair-me'}}
    accepted={'event_id':'good','kind':'face','body':{'sample_id':'later'}}
    store.complete_job('fixture',[rejected,accepted])
    worker=Worker(store,'http://archive.test',None,Idle())
    def transport(request):
        body=json.loads(request.content)
        if body['event_id']=='bad':
            return httpx.Response(422,json={'detail':{'code':'archive_reference_outside_media'}})
        return httpx.Response(200,json={'persisted':True,'event_id':body['event_id']})
    worker.archive=httpx.Client(base_url='http://archive.test',transport=httpx.MockTransport(transport))
    worker.flush()
    assert store.pending_events()==[]
    assert store.status()['rejected_timeline_events']==1
    assert store.status()['last_timeline_rejection']['error']=='http_422:archive_reference_outside_media'
    store.db.close();store=Store(tmp_path/'entities.sqlite')
    assert json.loads(store.db.execute('SELECT payload FROM rejected_events WHERE id=?',('bad',)).fetchone()[0])==rejected
    assert store.status()['rejected_timeline_events']==1


def test_retryable_archive_failure_remains_pending(tmp_path):
    class Idle:
        def check(self):pass
    store=Store(tmp_path/'entities.sqlite');store.complete_job('fixture',[{'event_id':'pending','body':{}}])
    worker=Worker(store,'http://archive.test',None,Idle())
    worker.archive=httpx.Client(base_url='http://archive.test',transport=httpx.MockTransport(lambda request:httpx.Response(503,json={'detail':{'code':'unavailable'}})))
    with pytest.raises(httpx.HTTPStatusError):worker.flush()
    assert len(store.pending_events())==1
    assert store.status()['rejected_timeline_events']==0


def test_pipeline_changes_get_new_event_ids_but_keep_original_sample_identity(tmp_path):
    class Idle:
        def check(self):pass
    store=Store(tmp_path/'entities.sqlite');first=Worker(store,'http://archive.test',None,Idle(),max_frames=2)
    second=Worker(store,'http://archive.test',None,Idle(),max_frames=3)
    asset={'media_id':'original','capture_id':'capture','captured_at':'2026-10-09T16:00:00Z','sha256':'a'*64}
    data={'embedding':[1.,0.,0.]}
    observation_a=first._observation(asset,'face','same-model',0,0,dict(data),set())
    observation_b=second._observation(asset,'face','same-model',0,0,dict(data),set())
    assert observation_a['sample_id']==observation_b['sample_id']
    assert observation_a['entity_id']==observation_b['entity_id']
    event_a=first._event(asset,'face','same-model',0,0,[observation_a],0)
    event_b=second._event(asset,'face','same-model',0,0,[observation_b],0)
    assert event_a['event_id']!=event_b['event_id']
    store.complete_job('fixture',[event_a,event_b])
    assert len(store.pending_events())==2


def test_unknown_voice_status_is_not_promoted_by_coordinator(tmp_path):
    import shutil
    source=tmp_path/'short.mov'
    subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','color=black:s=32x32:r=1',
        '-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:v','libx264','-threads','1',
        '-pix_fmt','yuv420p','-c:a','aac','-shortest',str(source)],check=True,timeout=30)
    class Idle:
        def check(self):pass
    class UnknownVoice:
        version='unknown-voice-fixture'
        def extract(self,path):
            assert path.exists()
            return [{'start_seconds':0.,'end_seconds':.8,'embedding':None,'cluster_eligible':False,
                'candidate_for_clustering':False,'identity_status':'unknown','quality':{'reason':'too_short'}}]
    store=Store(tmp_path/'entities.sqlite')
    asset={'media_id':'fixture','capture_id':'capture','captured_at':'2026-10-09T16:00:00Z',
        'duration_seconds':1.,'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'size_bytes':source.stat().st_size}
    worker=Worker(store,'http://archive.test',None,Idle(),voices=UnknownVoice())
    worker.download=lambda asset,destination:shutil.copyfile(source,destination)
    assert store.enqueue(asset,worker.pipeline)
    worker.process(store.take_job(0,worker.pipeline))
    event=json.loads(store.pending_events()[0]['payload'])
    observation=event['body']['observations'][0]
    assert observation['identity_status']=='unknown'
    assert observation['entity_id'] is None
    assert event['entity_ids']==[]


def test_discovery_skips_marked_fixture_advances_cursor_and_keeps_later_real_assets(tmp_path):
    class Idle:
        def check(self):pass
    store=Store(tmp_path/'entities.sqlite');worker=Worker(store,'http://archive.test',None,Idle())
    requested=[]
    assets=[
        {'media_id':'public-fixture','ingest_cursor':1,'metadata':{'test_fixture':True}},
        {'media_id':'real-phone','ingest_cursor':2,'metadata':{}},
        {'media_id':'not-a-boolean-marker','ingest_cursor':3,'metadata':{'test_fixture':'true'}},
    ]
    def transport(request):
        after=int(request.url.params['after']);requested.append(after)
        return httpx.Response(200,json={'items':[asset for asset in assets if asset['ingest_cursor']>after],
            'next_cursor':3,'has_more':False,'order':'durable_ingest_order_not_capture_time'})
    worker.archive=httpx.Client(base_url='http://archive.test',transport=httpx.MockTransport(transport))
    worker.discover()
    queued={row[0] for row in store.db.execute('SELECT media_id FROM jobs')}
    assert queued=={'real-phone','not-a-boolean-marker'}
    assert store.config(worker.cursor_key)=='3'
    worker.discover()
    assert requested==[0,3], 'fixture must not trap the ingest cursor or make later phone uploads disappear'
    assert store.db.execute('SELECT count(*) FROM jobs').fetchone()[0]==2

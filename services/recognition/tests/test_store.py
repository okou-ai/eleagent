import json
from pathlib import Path
from entity_worker.store import Store


def sample(db, name, capture='capture-a', model='face-test-v1', vector=None, eligible=True, modality='face', excluded=()):
    return db.assign(name,model,{'media_id':'media-'+name,'capture_id':capture},0,'2026-10-09T16:00:00+00:00',
        {'embedding':vector or [1.,0.,0.], 'modality':modality}, cluster_eligible=eligible, modality=modality,excluded=excluded)


def test_ids_names_and_manual_sample_reassignment_survive_restart(tmp_path):
    path=tmp_path/'entities.sqlite'; db=Store(path)
    a=sample(db,'a'); b=sample(db,'b',capture='capture-b')
    assert a['entity_id']==b['entity_id']
    rename=db.rename(a['entity_id'],'my-label')
    correction=db.reassign('b')
    assert correction['after']!=a['entity_id']
    assert 'correction_id' in rename
    db.db.close(); db=Store(path,recover=True)
    assert db.detail(a['entity_id'])['name']=='my-label'
    assert sample(db,'b',capture='capture-b')['entity_id']==correction['after']
    assert sample(db,'b')['assignment']=='user_corrected'
    assert db.db.execute('SELECT count(*) FROM corrections').fetchone()[0]==2
    assert len(db.pending_events())==2


def test_unknown_voice_and_model_versions_cannot_poison_existing_prototypes(tmp_path):
    db=Store(tmp_path/'entities.sqlite')
    face=sample(db,'face')
    unknown=sample(db,'mixed',model='voice-test-v1',eligible=False,modality='voice')
    assert unknown['entity_id'] is None
    assert db.sample_detail('mixed')['embedding_dimensions']==3
    assert db.db.execute('SELECT count(*) FROM entities').fetchone()[0]==1
    newer=sample(db,'newer',model='face-test-v2')
    assert newer['entity_id']!=face['entity_id']


def test_same_frame_exclusion_and_cross_capture_provisional_object_appearance(tmp_path):
    db=Store(tmp_path/'entities.sqlite')
    first=sample(db,'a')
    second=sample(db,'b',excluded={first['entity_id']})
    assert first['entity_id']!=second['entity_id']
    a=sample(db,'obj-a',model='obj-v1:class-cup',modality='object')
    b=sample(db,'obj-b',capture='capture-b',model='obj-v1:class-cup',modality='object')
    assert a['entity_id']==b['entity_id']
    assert db.detail(a['entity_id'])['scope_capture'] is None


def test_ingest_jobs_survive_restart_and_bound_pending_metadata(tmp_path):
    path=tmp_path/'entities.sqlite'; db=Store(path)
    assert db.enqueue({'media_id':'old','captured_at':'yesterday'},'model',max_pending=1)
    assert not db.enqueue({'media_id':'new'},'model',max_pending=1)
    job=db.take_job(100,'model'); assert job
    db.db.close(); db=Store(path,recover=True)
    assert db.take_job(100,'model')['id']==job['id']
    original={'event_id':'event-1','body':{'entity_id':'old-assignment'}}
    db.complete_job(job['id'],[original])
    assert json.loads(db.pending_events()[0]['payload'])==original
    # Finished jobs and delivered events leave no local copy: the archive keeps events and rejects
    # a different payload under the same event id, so immutability is enforced there.
    db.event_ack('event-1')
    assert db.pending_events()==[] and db.db.execute('SELECT count(*) FROM events').fetchone()[0]==0
    assert db.db.execute('SELECT count(*) FROM jobs').fetchone()[0]==0


def _interleave_writer_and_competitor(first, second, pause_method, first_action, second_action):
    """Hold one write at a real mutation boundary, then start another connection.

    The competitor's BEGIN trace or completion tells us it reached SQLite. No
    sleep is used: a deferred old implementation reads stale state before that
    BEGIN; an immediate transaction waits before reading.
    """
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    entered, release, competitor_started = Event(), Event(), Event()
    original = getattr(first, pause_method)
    def paused(*args, **kwargs):
        if not entered.is_set():
            entered.set()
            assert release.wait(5), 'first writer was not released'
        return original(*args, **kwargs)
    setattr(first, pause_method, paused)
    second.db.set_trace_callback(lambda sql: competitor_started.set() if sql.upper().startswith('BEGIN') else None)
    with ThreadPoolExecutor(max_workers=2) as pool:
        one = pool.submit(first_action)
        try:
            assert entered.wait(5), 'first writer did not reach mutation'
            two = pool.submit(second_action)
            # Existing-sample replay had no write in the old implementation.
            # Its completion is equally useful evidence that it read the sample.
            two.add_done_callback(lambda _: competitor_started.set())
            assert competitor_started.wait(5), 'competitor did not reach SQLite'
        finally:
            release.set()
        return one.result(timeout=5), two.result(timeout=5)


def test_concurrent_reassignments_chain_from_current_owner_and_rebuild_actual_previous_cluster(tmp_path):
    path=tmp_path/'entities.sqlite'; first=Store(path); second=Store(path)
    a=sample(first,'a')['entity_id']
    b=sample(first,'b',vector=[0.,1.,0.])['entity_id']
    c=sample(first,'c',vector=[0.,0.,1.])['entity_id']
    one,two=_interleave_writer_and_competitor(first,second,'_rebuild',
        lambda:first.reassign('a',b),lambda:second.reassign('a',c))
    assert (one['before'],one['after'])==(a,b)
    assert (two['before'],two['after'])==(b,c)
    assert first.sample_detail('a')['entity_id']==c
    prototypes={row['id']:json.loads(row['prototypes']) for row in first.db.execute('SELECT id,prototypes FROM entities')}
    assert prototypes[a]==[]
    assert prototypes[b]==[[0.,1.,0.]], 'intermediate cluster must not retain the moved voice/face'
    assert [1.,0.,0.] in prototypes[c]
    history=[json.loads(row[0]) for row in first.db.execute('SELECT body FROM corrections ORDER BY rowid')]
    assert [(row['before'],row['after']) for row in history]==[(a,b),(b,c)]


def test_concurrent_rename_audit_uses_previous_committed_name(tmp_path):
    path=tmp_path/'entities.sqlite'; first=Store(path); second=Store(path)
    entity=sample(first,'a')['entity_id']
    one,two=_interleave_writer_and_competitor(first,second,'_correction',
        lambda:first.rename(entity,'first-label'),lambda:second.rename(entity,'second-label'))
    assert one['before'] is None
    assert two['before']=='first-label'
    assert first.detail(entity)['name']=='second-label'


def test_worker_assignment_waits_for_user_correction_before_reading_existing_sample_or_prototypes(tmp_path):
    for replay_existing in (True,False):
        path=tmp_path/f'entities-{replay_existing}.sqlite'; first=Store(path); second=Store(path)
        a=sample(first,'a')['entity_id']
        b=sample(first,'b',vector=[0.,1.,0.])['entity_id']
        _,assigned=_interleave_writer_and_competitor(first,second,'_rebuild',
            lambda:first.reassign('a',b),lambda:sample(second,'a' if replay_existing else 'later'))
        assert assigned['entity_id']==b, 'worker must use committed user assignment and rebuilt prototypes'
        if replay_existing:
            assert assigned['assignment']=='user_corrected'
        assert json.loads(first.db.execute('SELECT prototypes FROM entities WHERE id=?',(a,)).fetchone()[0])==[]


def test_unknown_manual_voice_samples_do_not_evict_older_valid_representatives(tmp_path):
    db=Store(tmp_path/'entities.sqlite')
    known=sample(db,'known',model='voice-v1',modality='voice')['entity_id']
    for index in range(8):
        name=f'unknown-{index}'
        db.assign(name,'voice-v1',{'media_id':name,'capture_id':'capture'},0,f'2026-10-10T16:00:0{index}+00:00',
            {'embedding':None,'modality':'voice'},modality='voice',cluster_eligible=False)
        db.reassign(name,known)
    assert json.loads(db.db.execute('SELECT prototypes FROM entities WHERE id=?',(known,)).fetchone()[0])==[[1.,0.,0.]]
    assert db.detail(known)['last_seen']=='2026-10-10T16:00:07+00:00'
    assert sample(db,'later',model='voice-v1',modality='voice')['entity_id']==known


def test_failed_correction_rolls_back_assignment_prototypes_history_and_outbox(tmp_path):
    import pytest
    path=tmp_path/'entities.sqlite'; db=Store(path); other=Store(path)
    a=sample(db,'a')['entity_id'];b=sample(db,'b',vector=[0.,1.,0.])['entity_id']
    original=db._correction
    def fail_after_outbox(*args):
        original(*args)
        raise RuntimeError('fixture transaction failure')
    db._correction=fail_after_outbox
    with pytest.raises(RuntimeError,match='fixture transaction failure'):
        db.reassign('a',b)
    assert other.sample_detail('a')['entity_id']==a
    assert json.loads(other.db.execute('SELECT prototypes FROM entities WHERE id=?',(b,)).fetchone()[0])==[[0.,1.,0.]]
    assert not other.pending_events()
    assert other.db.execute('SELECT count(*) FROM corrections').fetchone()[0]==0
    assert other.rename(a,'still-writable')['after']=='still-writable'

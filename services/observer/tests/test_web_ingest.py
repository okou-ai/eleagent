"""Real codec and archive-contract checks; synthetic media, no model or listening server."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI, Header, HTTPException

OBSERVER = Path(__file__).resolve().parents[1]
ROOT = OBSERVER.parents[1]
sys.path.insert(0, str(OBSERVER))
import app.main as observer_main
from app.main import Settings, create_app
from app.mobile import decode_clip, probe_clip
from app.feeder import ArchiveFeeder

# Both services use an `app` package in separate containers. Give the archive a
# distinct package name in this in-process integration test.
spec = importlib.util.spec_from_file_location('archive_test_app', ROOT / 'services/archive/app/__init__.py',
    submodule_search_locations=[str(ROOT / 'services/archive/app')])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
from archive_test_app.archive import Archive
from archive_test_app.archive_api import install_archive_routes

TOKEN = 'synthetic-local-test-token'


class WebIngestTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.media_dir = tempfile.TemporaryDirectory(prefix='eleagent-codec-test-')
        cls.media = {}
        for name, duration, options in [
            ('mp4', '1.2', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac']),
            ('webm', '1.2', ['-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', '-live', '1']),
            ('long.webm', '7.2', ['-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', '-live', '1']),
        ]:
            path = Path(cls.media_dir.name) / ('synthetic.' + name)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=10',
                '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', duration, '-threads', '1', *options, str(path)], check=True)
            cls.media[name] = path

    @classmethod
    def tearDownClass(cls):
        cls.media_dir.cleanup()

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='eleagent-archive-test-')
        directory = Path(self.temp.name)
        self.archive = Archive(str(directory / 'archive.sqlite3'), str(directory / 'media'), 0)
        archive_app = FastAPI()

        def auth(authorization: str = Header(default='')):
            if authorization != 'Bearer ' + TOKEN:
                raise HTTPException(401)

        install_archive_routes(archive_app, self.archive, auth)
        self.archive_app = archive_app
        self.app = create_app(Settings(api_token=TOKEN, backend='mock', db_path=str(directory / 'observer.sqlite3'),
            archive_url='http://archive.test', archive_token=TOKEN))
        self.service = self.app.state.service
        await self.service.archive.client.aclose()
        self.service.archive.client = httpx.AsyncClient(base_url='http://archive.test',
            transport=httpx.ASGITransport(app=archive_app), headers={'Authorization': 'Bearer ' + TOKEN})
        self.client = httpx.AsyncClient(base_url='http://observer.test', transport=httpx.ASGITransport(app=self.app))

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.service.stop()
        self.archive.close()
        self.temp.cleanup()

    def meta(self, seq=0):
        return {'capture_id': 'web-synthetic-sf-back', 'clip_seq': seq, 'captured_at': '2026-01-05T17:30:00Z',
            'captured_end_at': '2026-01-05T17:30:01.200Z', 'camera': 'back', 'source': 'browser_media_recorder',
            'locations': [{'captured_at': '2026-01-05T17:30:00Z', 'latitude': 37.789, 'longitude': -122.401, 'accuracy_m': 25}],
            'capture_gaps': [{'started_at': '2026-01-05T17:29:00Z', 'ended_at': '2026-01-05T17:30:00Z', 'reason': 'page_hidden'}]}

    async def post(self, format='webm', meta=None, token=TOKEN, path='/'):
        return await self.client.post(path, headers={'Authorization': 'Bearer ' + token},
            data={'meta': json.dumps(meta or self.meta())},
            files={'video': ('clip.' + format, self.media[format].read_bytes(), 'video/webm' if 'webm' in format else 'video/mp4')})

    async def test_container_web_root_does_not_evaluate_checkout_fallback(self):
        # Container modules live at /app/app/main.py, shallower than a repository checkout.
        with patch.object(observer_main, '__file__', '/app/app/main.py'), patch.dict(
                'os.environ', {'SCENE_WEB_ROOT': str(ROOT / 'apps/web')}):
            app = create_app(Settings(api_token=TOKEN, backend='mock',
                db_path=str(Path(self.temp.name) / 'container-observer.sqlite3')))
        try:
            async with httpx.AsyncClient(base_url='http://container.test', transport=httpx.ASGITransport(app=app)) as client:
                response = await client.get('/')
                self.assertEqual(response.status_code, 200)
                self.assertIn('Eleagent', response.text)
        finally:
            await app.state.service.stop()

    async def test_capture_page_is_public_but_root_upload_requires_bearer(self):
        page = await self.client.get('/')
        self.assertEqual(page.status_code, 200)
        self.assertIn('Eleagent', page.text)
        self.assertEqual(page.headers['cache-control'], 'no-store')
        self.assertIn("frame-ancestors 'none'", page.headers['content-security-policy'])
        self.assertEqual((await self.post(token='wrong')).status_code, 401)
        self.assertEqual((await self.client.get('/assets/requirements.txt')).status_code, 404)

    async def test_streaming_webm_without_container_duration_is_archived_and_decoded(self):
        metadata, duration = await probe_clip(self.media['webm'])
        self.assertEqual(metadata['duration_source'], 'packet_timestamps')
        self.assertGreater(duration, 1.1)
        self.assertLess(duration, 1.4)
        response = await self.post()
        self.assertEqual(response.status_code, 200, response.text)
        receipt = response.json()
        self.assertTrue(receipt['archived'])
        self.assertEqual(receipt['sha256'], hashlib.sha256(self.media['webm'].read_bytes()).hexdigest())
        pcm, frames = await decode_clip(self.media['webm'])
        self.assertGreater(len(pcm), 64_000)
        self.assertGreaterEqual(len(frames), 1)
        await self.service.archive.sync_once()
        self.assertEqual(self.service.archive.status()['pending_timeline_events'], 0)
        original = await self.service.archive.client.get('/v1/archive/media/' + receipt['media_id'] + '/original')
        self.assertEqual(original.content, self.media['webm'].read_bytes())
        self.assertEqual(original.headers['content-type'], 'video/webm')

    async def test_lost_response_retry_is_idempotent_and_conflicting_media_is_rejected(self):
        first = await self.post()
        second = await self.post()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()['media_id'], second.json()['media_id'])
        self.assertTrue(second.json()['duplicate'])
        conflict = await self.post('mp4')
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()['detail']['code'], 'clip_conflict')

    async def test_mp4_and_legacy_route_remain_compatible(self):
        response = await self.post('mp4', path='/v1/clips')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()['archived'])
        pcm, frames = await decode_clip(self.media['mp4'])
        self.assertTrue(pcm and frames)

    async def test_first_start_processes_archived_clips_and_restart_preserves_progress(self):
        first = (await self.post('mp4')).json()
        second = (await self.post('mp4', meta=self.meta(seq=1))).json()
        feeder = self.service.feeder

        async def connect_archive(value):
            await value.client.aclose()
            value.client = httpx.AsyncClient(base_url='http://archive.test',
                transport=httpx.ASGITransport(app=self.archive_app),
                headers={'Authorization': 'Bearer ' + TOKEN})

        await connect_archive(feeder)
        await feeder.poll()
        self.assertEqual(feeder.pending_count(), 2)
        self.assertEqual(feeder.next_clip()[0], first['media_id'])
        await feeder.feed_one(*feeder.next_clip())
        self.assertEqual(feeder.fed, 1)
        self.assertGreater(self.service.accepted, 0)
        await feeder.close()
        feeder.db.close()

        # Restart against the same durable state with one clip still pending.
        restarted = ArchiveFeeder(self.service, 'http://archive.test', TOKEN,
            str(Path(self.temp.name) / 'minicpm-feed.sqlite3'))
        self.service.feeder = restarted
        await connect_archive(restarted)
        third = (await self.post('mp4', meta=self.meta(seq=2))).json()
        await restarted.poll()
        pending = {row[0] for row in restarted.db.execute('SELECT media_id FROM pending')}
        self.assertEqual(pending, {second['media_id'], third['media_id']})

    async def test_suspended_overlong_webm_and_invalid_gap_are_rejected(self):
        response = await self.post('long.webm')
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()['detail']['code'], 'clip_duration_out_of_range')
        meta = self.meta()
        meta['capture_gaps'][0]['ended_at'] = '2026-01-04T17:30:00Z'
        response = await self.post(meta=meta)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIsNone(await self.service.archive.get_clip(meta['capture_id'], meta['clip_seq']))


if __name__ == '__main__':
    unittest.main()

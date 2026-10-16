import hashlib
from pathlib import Path
import tempfile
import unittest
from entity_worker.store import Store

class PipelineHandoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / 'state.sqlite')
        self.addCleanup(self.store.db.close)

    def test_completed_jobs_can_be_gone_without_losing_feed_progress(self):
        s = self.store
        s.set_config('ingest_cursor:entities-v1-old1', '477')
        s.set_config('ingest_cursor:entities-v1-old2', '5117')
        s.set_config('speech_cursor', '5200')
        s.set_config('text_cursor', '5201')
        with s.db:
            s.db.execute("INSERT INTO outbox VALUES ('pending-event','{}',NULL)")
        s.inherit_entity_pipeline('entities-v1-new')
        self.assertEqual(s.config('ingest_cursor:entities-v1-new'), '5117')
        self.assertEqual(s.config('speech_cursor'), '5200')
        self.assertEqual(s.config('text_cursor'), '5201')
        self.assertEqual(s.db.execute('SELECT count(*) FROM outbox').fetchone()[0], 1)
        self.assertEqual(s.db.execute('SELECT count(*) FROM jobs').fetchone()[0], 0)

    def test_unfinished_work_moves_once_and_other_workers_are_untouched(self):
        s = self.store
        old, new = 'entities-v1-old', 'entities-v1-new'
        s.set_config('ingest_cursor:' + old, '105')
        for media in ['queued-clip', 'inflight-clip']:
            s.enqueue({'media_id': media, 'ingest_cursor': 104}, old)
        s.enqueue({'media_id': 'queued-clip', 'ingest_cursor': 104}, new)
        s.enqueue({'media_id': 'speech-clip'}, 'speech-v1')
        with s.db:
            s.db.execute("UPDATE jobs SET state='processing',attempts=1 WHERE media_id='inflight-clip'")
        s.inherit_entity_pipeline(new)
        jobs = [dict(r) for r in s.db.execute('SELECT * FROM jobs WHERE model=?', (new,))]
        self.assertEqual({j['media_id'] for j in jobs}, {'queued-clip', 'inflight-clip'})
        self.assertEqual(len(jobs), 2)
        for job in jobs:
            self.assertEqual(job['id'], hashlib.sha256((job['media_id'] + ':' + new).encode()).hexdigest())
            self.assertEqual(job['state'], 'queued')
        self.assertEqual(s.db.execute('SELECT count(*) FROM jobs WHERE model=?', (old,)).fetchone()[0], 0)
        self.assertEqual(s.db.execute("SELECT count(*) FROM jobs WHERE model='speech-v1'").fetchone()[0], 1)
        s.set_config('ingest_cursor:' + new, '108')
        s.inherit_entity_pipeline(new)
        self.assertEqual(s.config('ingest_cursor:' + new), '108')
        self.assertEqual(s.db.execute('SELECT count(*) FROM jobs WHERE model=?', (new,)).fetchone()[0], 2)

    def test_first_install_starts_at_zero_and_rejects_wrong_worker_family(self):
        s = self.store
        s.set_config('speech_cursor', '10000')
        s.inherit_entity_pipeline('entities-v1-first')
        self.assertEqual(s.config('ingest_cursor:entities-v1-first'), '0')
        with self.assertRaises(ValueError):
            s.inherit_entity_pipeline('speech-v1-new')

if __name__ == '__main__':
    unittest.main()

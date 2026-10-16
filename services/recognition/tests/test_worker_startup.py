"""Archive uploads made before model readiness must survive first worker startup."""
from types import SimpleNamespace

import httpx
import pytest

from entity_worker.speech import SpeechWorker
from entity_worker.store import Store
from entity_worker.text_worker import TextWorker


@pytest.mark.parametrize('kind', ['speech', 'text'])
@pytest.mark.parametrize('previous', [None, 'legacy', 'generation'])
def test_startup_consumes_existing_uploads_and_preserves_completed_progress(tmp_path, kind, previous):
    store = Store(tmp_path / 'state.sqlite')
    if previous:
        key = kind + '_cursor' + (':old-model' if previous == 'generation' else '')
        store.set_config(key, '6')
    after_values = []
    def feed(request):
        after = int(request.url.params['after'])
        after_values.append(after)
        items = [{'media_id': f'media_{n}', 'capture_id': 'synthetic-workday',
                  'clip_seq': n - 1, 'ingest_cursor': n, 'metadata': {}}
                 for n in range(after + 1, 8)]
        return httpx.Response(200, json={'items': items, 'next_cursor': 7, 'has_more': False})
    if kind == 'speech':
        worker = SpeechWorker(store, 'http://archive.example.invalid', 'synthetic-token',
                              SimpleNamespace(voice_model='voice-v1', asr_version='asr-v1'))
    else:
        worker = TextWorker(store, 'http://archive.example.invalid', 'synthetic-token', None)
    worker.archive.close()
    worker.archive = httpx.Client(base_url='http://archive.example.invalid', transport=httpx.MockTransport(feed))
    try:
        if kind == 'speech':
            worker.discover()
            count = store.db.execute('SELECT count(*) FROM speech_pending').fetchone()[0]
        else:
            items, cursor = worker.pending()
            assert cursor == 7
            count = len(items)
        assert after_values == [6 if previous else 0]
        assert count == (1 if previous else 7)
    finally:
        worker.archive.close()
        store.db.close()

"""Prompt-boundary checks with synthetic archive events; no private recordings or network writes."""
import asyncio
import copy
import importlib.util
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx


SPEC = importlib.util.spec_from_file_location('situation', Path(__file__).parents[1] / 'app/situation.py')
situation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(situation)
AT = datetime(2026, 10, 14, 10, 0, tzinfo=timezone.utc)
CAPTURE = 'synthetic-back'


def event(kind, offset, text='', clusters=(), end=None, capture=CAPTURE):
    body = {'text': text}
    if kind == 'scene_text':
        body = {'pipeline': 'scene-text-focus-v1', 'texts': [{'text': text, 'confidence': .99}]}
    return {'event_id': f'{kind}-{offset}-{capture}', 'kind': kind, 'capture_id': capture,
            'started_at': (AT + timedelta(seconds=offset)).isoformat(),
            'ended_at': (AT + timedelta(seconds=end if end is not None else offset + 1)).isoformat(),
            'entity_ids': list(clusters), 'body': body}


def memories(memory):
    memory.cluster_map = {'cluster:voice_owner': 'person:owner', 'voice_alex': 'person:alex',
                          'cluster:face_owner': 'person:owner', 'cluster:face_bea': 'person:bea',
                          'cluster:object_cup': 'object:cup', 'cluster:object_book': 'object:book'}
    memory.entities = {eid: {'id': eid, 'kind': eid.split(':')[0], 'name': name, 'text': f'Test memory of {name}'}
                       for eid, name in [('person:owner', 'Owner'), ('person:alex', 'Alex'), ('person:bea', 'Bea'),
                                         ('object:cup', 'Red cup'), ('object:book', 'Blue book')]}
    memory.map_at = time.monotonic()


def client_context(events, fail=()):
    value = situation.Situation(None)
    requests = []

    def respond(request):
        requests.append(request)
        assert request.method == 'GET'
        assert request.url.path == '/v1/archive/events'
        if request.url.params['kind'] in fail:
            return httpx.Response(503)
        # Return the broad prefetch including adversarial extra-capture/future records: build must bound it.
        return httpx.Response(200, json={'items': [e for e in events if e['kind'] == request.url.params['kind']]})

    value.client = httpx.AsyncClient(base_url='https://archive.invalid', transport=httpx.MockTransport(respond))
    memories(value.memory)
    return value, requests


def test_voice_face_and_object_share_existing_recall_metadata_without_mutating_archive():
    async def check():
        events = [event('speech', 0, 'Synthetic utterance.', ['voice_owner']),
                  event('object', 0, clusters=['object_cup']), event('face', 0, clusters=['face_bea'])]
        original = copy.deepcopy(events)
        ctx, requests = client_context(events)
        try:
            await ctx.refresh_capture(CAPTURE, AT)
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert '[voice may be me (the wearer)] Synthetic utterance.' in prompt
            assert 'not evidence of physical presence' in prompt
            assert 'recording, video or call' in prompt
            assert 'current visible or audible evidence' in prompt
            assert {m['id'] for m in meta['memories']} == {'person:owner', 'object:cup', 'person:bea'}
            assert all(set(m) == {'id', 'name'} for m in meta['memories'])
            assert set(meta) == {'prompt_version', 'media_seconds', 'history_entries', 'speech_items', 'ocr_items',
                                 'memories', 'max_new_tokens', 'target_seconds', 'wall_per_media_second',
                                 'backlog_seconds', 'prompt_chars', 'prompt_tokens_estimate'}
            assert events == original
            assert len(requests) == 4
        finally:
            await ctx.close()
    asyncio.run(check())


def test_identity_correction_and_removal_take_effect_without_rewriting_or_refetching_speech():
    async def check():
        ctx, requests = client_context([event('speech', 0, 'Synthetic utterance.', ['voice_owner'])])
        try:
            await ctx.refresh_capture(CAPTURE, AT)
            assert '[voice may be me' in ctx.build(CAPTURE, AT, 5, 0)[0]
            ctx.memory.cluster_map['cluster:voice_owner'] = 'person:alex'
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert '[voice may be Alex]' in prompt
            assert [m['id'] for m in meta['memories']] == ['person:alex']
            del ctx.memory.cluster_map['cluster:voice_owner']
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert '[unknown voice]' in prompt
            assert not meta['memories']
            assert 'Recognized:' not in prompt
            assert len(requests) == 4
        finally:
            await ctx.close()
    asyncio.run(check())


def test_ambiguous_missing_and_non_person_voice_matches_never_assert_a_person():
    ctx = situation.Situation(None)
    memories(ctx.memory)
    ctx.memory.cluster_map['voice_owner_alias'] = 'person:owner'
    assert ctx.memory.speaker({'entity_ids': ['voice_owner', 'voice_alex']}) == ('voice identity uncertain', None)
    for ids in ([], ['voice_unknown'], ['voice_owner', 'voice_unknown'], ['object_cup']):
        assert ctx.memory.speaker({'entity_ids': ids}) == ('unknown voice', None)
    label, person = ctx.memory.speaker({'entity_ids': ['cluster:voice_owner', 'voice_owner_alias']})
    assert label == 'voice may be me (the wearer)'
    assert person['id'] == 'person:owner'


def test_media_time_prevents_future_partial_transcript_and_cross_capture_leaks():
    async def check():
        events = [event('speech', -10, 'Earlier speech.', ['voice_alex']),
                  event('speech', 3, 'Transcript extending beyond this window.', ['voice_owner'], end=8),
                  event('speech', 6, 'Future speech.', ['voice_owner']),
                  event('speech', 1, 'Another recording.', ['voice_owner'], capture='other'),
                  event('scene_text', 6, 'Future text'), event('object', 6, clusters=['object_cup']),
                  event('face', 6, clusters=['face_bea'])]
        ctx, _ = client_context(events)
        try:
            await ctx.refresh_capture(CAPTURE, AT)
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert 'Earlier speech.' in prompt
            for forbidden in ('Transcript extending', 'Future speech', 'Another recording', 'Future text', 'Red cup', 'Bea'):
                assert forbidden not in prompt
            assert meta['speech_items'] == 1
            later = ctx.build(CAPTURE, AT + timedelta(seconds=5), 5, 0)[0]
            assert 'Transcript extending beyond this window.' in later
            assert 'Future speech.' in later
            assert 'Another recording.' not in later
            assert 'Earlier speech.' not in ctx.build('other', AT, 5, 0)[0]
            rewind = ctx.build(CAPTURE, AT - timedelta(minutes=5), 5, 0)[0]
            assert 'Earlier speech.' not in rewind
        finally:
            await ctx.close()
    asyncio.run(check())


def test_late_transcript_appears_on_refresh_and_partial_failures_preserve_other_inputs():
    async def check():
        events = [event('scene_text', 0, 'Synthetic sign')]
        ctx, _ = client_context(events, fail={'face'})
        async def graph_unavailable():
            raise ConnectionError('synthetic unavailable graph')
        ctx.memory.refresh = graph_unavailable
        try:
            await ctx.refresh_capture(CAPTURE, AT)
            assert ctx.build(CAPTURE, AT, 5, 0)[2]['speech_items'] == 0
            events.append(event('speech', 0, 'Delayed ASR.', ['voice_alex']))
            await ctx.refresh_capture(CAPTURE, AT)
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert '[voice may be Alex] Delayed ASR.' in prompt
            assert 'Synthetic sign' in prompt
            ctx.memory.map_at -= situation.MEMORY_CACHE_SECONDS + 1
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert '[unknown voice] Delayed ASR.' in prompt
            assert not meta['memories']
            ctx.cache[CAPTURE]['at'] -= situation.CACHE_SECONDS + 1
            prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
            assert 'Delayed ASR' not in prompt
            assert meta['speech_items'] == meta['ocr_items'] == 0
        finally:
            await ctx.close()
    asyncio.run(check())


def test_frequent_selfie_faces_do_not_displace_current_speaker_and_objects():
    ctx = situation.Situation(None)
    memories(ctx.memory)
    recalled = ctx.memory.recall({'object_cup': 3, 'object_book': 2}, [ctx.memory.entities['person:alex']],
                                 {'face_owner': 100, 'face_bea': 2})
    assert [m['id'] for m in recalled] == ['person:alex', 'object:cup', 'person:bea']


def test_uncertain_or_ambiguous_recognition_is_not_promoted_to_confirmed_identity():
    ctx = situation.Situation(None)
    meta = {'memories': [{'id': 'person:alex', 'name': 'Alex'}, {'id': 'person:bea', 'name': 'Bea'}]}
    for text in ('maybe: Alex', 'unknown', 'possibly Alex', 'Alex or Bea', 'uncertain: Bea',
                 'not Alex', 'Alex, but not enough evidence', 'Alexander, same voice', 'The voice reminds me of Alex'):
        assert 'recognized_entity_id' not in ctx.record(CAPTURE, AT, f'Recognized: {text}', meta, 0)
    fields = ctx.record(CAPTURE, AT, 'Recognized: Alex, the same low voice and accent', meta, 0)
    assert fields['recognized_entity_id'] == 'person:alex'


def test_rewind_clears_future_working_memory():
    ctx = situation.Situation(None)
    ctx.record(CAPTURE, AT + timedelta(seconds=10), 'Event: new: reading a synthetic book', {}, 0)
    prompt, _, meta = ctx.build(CAPTURE, AT, 5, 0)
    assert 'reading a synthetic book' not in prompt
    assert meta['history_entries'] == 0


def test_graph_refresh_publishes_map_and_entities_together():
    class Result:
        def __init__(self, rows):
            self.rows = rows
        async def single(self):
            return self.rows[0]
        def __aiter__(self):
            async def rows():
                for row in self.rows:
                    yield row
            return rows()

    class Graph:
        fail = True
        def session(self):
            return self
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def run(self, query, **params):
            assert not any(verb in query for verb in ('SET ', 'CREATE ', 'MERGE ', 'DELETE '))
            if 'SleepState' in query:
                return Result([{'m': json.dumps({'cluster:voice_owner': 'person:alex'})}])
            if self.fail:
                raise ConnectionError('synthetic graph read failed')
            return Result([{'id': 'person:alex', 'kind': 'person', 'name': 'Alex', 'text': 'Synthetic person'}])

    async def check():
        memory = situation.Memory(None)
        memories(memory)
        memory.driver = Graph()
        memory.map_at -= 61
        try:
            await memory.refresh()
        except ConnectionError:
            pass
        assert memory.resolve('voice_owner')['id'] == 'person:owner'
        memory.driver.fail = False
        await memory.refresh()
        assert memory.resolve('voice_owner')['id'] == 'person:alex'
        assert 'person:owner' not in memory.entities
    asyncio.run(check())

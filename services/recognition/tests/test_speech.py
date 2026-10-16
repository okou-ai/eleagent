from datetime import datetime, timedelta, timezone
import numpy as np
from entity_worker.speech import SR, build_turns, echoes_glossary, locate, media_refs, windows_for, DEFAULT_GLOSSARY
from entity_worker.store import Store


def test_windows_and_turns_split_speakers_at_votes_and_keep_unknown_separate():
    regions = [(0, 2 * SR), (int(2.3 * SR), int(8.3 * SR)), (9 * SR, int(9.6 * SR))]
    windows = windows_for(regions)
    assert windows[0] == (0, 0, 2 * SR) and windows[-1] == (2, 9 * SR, int(9.6 * SR))
    assert len(windows) == 7
    labels = ['a', 'a', 'a', 'a', 'b', 'b', None]
    turns = build_turns(regions, windows, labels)
    assert [t['speaker'] for t in turns] == ['a', 'b', None]
    assert turns[0]['start'] == 0 and turns[-1]['start'] == 9 * SR


def test_locate_and_media_refs_map_stitched_audio_back_to_originals():
    t0 = datetime(2026, 10, 10, 3, 0, tzinfo=timezone.utc)
    spans = [{'begin': 0, 'end': 5 * SR, 't0': t0, 'media_id': 'm1', 'origin': .02, 'duration': 5.03},
             {'begin': int(5.2 * SR), 'end': int(10.2 * SR), 't0': t0 + timedelta(seconds=5.2), 'media_id': 'm2', 'origin': 0., 'duration': 5.}]
    at, media, offset = locate(spans, int(6.2 * SR))
    assert media == 'm2' and abs(offset - 1) < 1e-6 and at == t0 + timedelta(seconds=6.2)
    refs = media_refs(spans, 4 * SR, int(6.2 * SR))
    assert [(r['media_id'], r['start_offset_seconds'], r['end_offset_seconds']) for r in refs] == [('m1', 4.02, 5.02), ('m2', 0.0, 1.0)]


def test_glossary_echo_is_detected():
    glossary = ['roadmap', 'milestone', 'planning', 'review']
    assert echoes_glossary('Roadmap milestone planning review.', glossary)
    assert not echoes_glossary('The roadmap review is scheduled for Thursday.', glossary)


def test_match_entity_reuses_speaker_after_samples_and_records_speech_atomically(tmp_path):
    db = Store(tmp_path / 'speech.sqlite')
    v = np.array([1., 0., 0.]); w = np.array([0., 1., 0.])
    first = db.match_entity('campp', 'voice', v, '2026-10-10T03:00:00+00:00')
    assert first['assignment'] == 'provisional_new'
    sample = {'sample_id': 's1', 'entity_id': first['entity_id'], 'model': 'campp', 'media_id': 'm1', 'capture_id': 'c',
              'offset': 1., 'started_at': '2026-10-10T03:00:01.000000+00:00', 'assignment': 'provisional_new',
              'data': {'modality': 'voice', 'text': 'Hello', 'start_seconds': 1., 'end_seconds': 4., 'embedding': [2., 0., 0.]}}
    event = {'event_id': 'speech_1', 'kind': 'speech', 'body': {'text': 'Hello'}}
    db.record_speech([sample], [event])
    db.record_speech([sample], [event])
    assert db.db.execute('SELECT count(*) FROM samples').fetchone()[0] == 1
    assert db.db.execute('SELECT count(*) FROM outbox').fetchone()[0] == 1
    again = db.match_entity('campp', 'voice', np.array([.9, .1, 0.]), '2026-10-10T03:01:00+00:00')
    assert again['entity_id'] == first['entity_id'] and again['assignment'] == 'provisional_match'
    other = db.match_entity('campp', 'voice', w, '2026-10-10T03:01:00+00:00')
    assert other['entity_id'] != first['entity_id']
    assert db.match_entity('campp', 'voice', v, '2026-10-10T03:02:00+00:00', excluded={first['entity_id']})['entity_id'] not in (first['entity_id'],)
    assert [e for e, _ in db.recent_entities('campp', 'voice', '2026-10-10T02:59:00+00:00')] == [first['entity_id']]
    detail = db.detail(first['entity_id'])
    assert detail['samples'][0]['observation']['text'] == 'Hello'


def test_media_refs_never_exceed_media_duration():
    t0 = datetime(2026, 10, 10, 3, 0, tzinfo=timezone.utc)
    spans = [{'begin': 0, 'end': int(5.0021 * SR), 't0': t0, 'media_id': 'm1', 'origin': 0., 'duration': 5.0016}]
    ref = media_refs(spans, int(4.5 * SR), int(5.0021 * SR))[0]
    assert ref['end_offset_seconds'] <= 5.0016 and ref['start_offset_seconds'] <= ref['end_offset_seconds']


def test_prune_empty_entities_keeps_entities_with_samples_or_names(tmp_path):
    db = Store(tmp_path / 'prune.sqlite')
    used = db.match_entity('campp', 'voice', np.array([1., 0., 0.]), '2026-10-10T03:00:00+00:00')['entity_id']
    db.record_speech([{'sample_id': 's1', 'entity_id': used, 'model': 'campp', 'media_id': 'm', 'capture_id': 'c', 'offset': 0.,
        'started_at': '2026-10-10T03:00:00+00:00', 'assignment': 'provisional_new', 'data': {'modality': 'voice', 'text': 'x'}}], [])
    empty = db.match_entity('campp', 'voice', np.array([0., 1., 0.]), '2026-10-10T03:00:00+00:00', excluded={used})['entity_id']
    named = db.match_entity('campp', 'voice', np.array([0., 0., 1.]), '2026-10-10T03:00:00+00:00', excluded={used, empty})['entity_id']
    db.rename(named, 'Morgan')
    assert db.prune_empty_entities('campp') == [empty]
    assert {e['id'] for e in db.list_entities()} == {used, named}

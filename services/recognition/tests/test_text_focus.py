"""Focus OCR must not seek the following clip's frame at the current clip's EOF."""
from datetime import datetime, timedelta, timezone

from entity_worker.text_worker import TextWorker


def test_focus_candidates_exclude_adjacent_clip_boundary():
    start = datetime(2026, 4, 14, 16, tzinfo=timezone.utc)
    events = []
    for offset, confidence in [(0, .8), (4, .85), (5, .99)]:
        events.append({
            'started_at': (start + timedelta(seconds=offset)).isoformat(),
            'body': {'observations': [{
                'label': 'bottle', 'entity_id': 'synthetic-bottle', 'confidence': confidence,
                'frame_width': 640, 'frame_height': 360, 'bbox': [100, 50, 250, 200],
            }]},
        })
    candidates, matched = TextWorker.focus_box('the bottle', events, start, 5)
    assert matched
    assert {candidate[2] for candidate in candidates} == {0, 4}

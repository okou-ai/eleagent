"""Conservative selection of existing OCR observations; no text reconstruction."""
import math
import unicodedata

PIPELINE = 'scene-text-v2'
MAX_GAP_US = 20_000_000


def signature(event):
    """Exact ordered blocks, normalizing only canonical Unicode and whitespace.

    Block boundaries, case, punctuation and numbers remain significant. Matching
    the recognized content does not assert a shared physical screen or text area.
    """
    return tuple(' '.join(unicodedata.normalize('NFC', block['text']).split())
                 for block in event['body'].get('texts') or []
                 if isinstance(block.get('text'), str) and block['text'].strip())


def finite_number(value, default=0.0):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def observation_quality(event):
    """Favor confident coverage; retain the first observation on an exact tie."""
    blocks = event['body'].get('texts') or []
    weighted_chars, chars = 0.0, 0
    for block in blocks:
        text = block.get('text')
        if not isinstance(text, str):
            continue
        count = len(''.join(unicodedata.normalize('NFC', text).split()))
        confidence = min(1.0, max(0.0, finite_number(block.get('confidence'))))
        weighted_chars += count * confidence
        chars += count
    return (weighted_chars, weighted_chars / chars if chars else 0.0)


def representative_groups(events, max_gap_us=MAX_GAP_US):
    """Select one complete existing frame per consecutive exact-content run.

    The anchor, not the changing best frame, owns the identity.
    Times are observation times, not evidence of continuous visibility or gaze.
    Non-v2 and successful empty observations break continuity.
    """
    groups, current = [], None
    for event in sorted(events, key=lambda e: (e['start_us'], e['event_id'])):
        if event['body'].get('pipeline') != PIPELINE:
            current = None
            continue
        text = signature(event)
        if not text:
            current = None
            continue
        matches = (current is not None
                   and event.get('capture_id') == current['events'][0].get('capture_id')
                   and 0 <= event['start_us'] - current['events'][-1]['start_us'] <= max_gap_us
                   and current['signature'] == text)
        if not matches:
            current = {'anchor_event_id': event['event_id'], 'signature': text,
                       'best': event, 'events': []}
            groups.append(current)
        current['events'].append(event)
        if observation_quality(event) > observation_quality(current['best']):
            current['best'] = event
    return groups

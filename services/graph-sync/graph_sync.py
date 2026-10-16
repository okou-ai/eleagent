"""Sync archive timeline + entity store into the Neo4j scene graph (v2: consolidated).

Every node is (:Entity {id, kind, ...}). Links ([:LINK {text, created_at, updated_at}], one per pair, plain
natural language) belong to the memory layer and are written by the sleep agent; this sync writes none.
Structural facts are node properties: fragments carry `episode_id` and `cluster_id`.
The archive is the only source: clips plus timeline events (MiniCPM, speech with voiceprints, face/object detections
with their vectors, readings, location, motion). SQLite supplies only retention decisions and source retirement receipts; perceptual content still comes from the archive.
Incremental consolidation, committed with archive cursors under the shared sleep/sync lock:
  tier 0  per-frame face/object detections -> one `*_appearance` node per (episode, cluster);
          unassigned detections are only counted on the episode.
  tier 1  clips -> `episode` nodes split at event boundaries; clips, MiniCPM observations, location
          and motion are folded into episode properties; transcripts live on `speech_segment`.
Raw media and per-frame records stay in the archive / entity store; the graph is a rebuildable index.
"""
import hashlib, json, math, os, sqlite3, sys, time, uuid
from collections import Counter, defaultdict
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from neo4j import GraphDatabase
from ocr_representative import PIPELINE as OCR_PIPELINE, finite_number, representative_groups

ARCHIVE_DB = os.environ.get('ARCHIVE_DB', '/archive/archive.sqlite3')
ENTITY_DB = os.environ.get('ENTITY_STATE_PATH', '/entities/entities.sqlite')
LOCK_QUERY = "MERGE (s:SyncState {id:'cursors'}) SET s.locked_at=$now RETURN s"
TEST_PREFIXES = ('archive-probe-', 'entity-acceptance-')
VECTOR_DIMS = {'face_vec': 128, 'voice_vec': 192, 'object_vec': 384}
DERIVED_KINDS = ['episode', 'face_appearance', 'object_appearance', 'speech_segment', 'text_appearance']
LEGACY_KINDS = ['clip', 'observation', 'transcript', 'location', 'motion', 'face_detection', 'object_detection']
CROP_CAP = 12  # crop references kept per appearance (spread over its frames) for the sleep agent to look at
GAP_US, MAX_US, MIN_US, WINDOW_US = 20_000_000, 600_000_000, 30_000_000, 60_000_000
MOVE_M, SCENE_JACCARD, OBS_CAP, SAMPLE_ID_CAP = 100.0, 0.1, 60, 500
LOCAL_TIMEZONE = ZoneInfo(os.environ.get('ELEAGENT_TIMEZONE', 'America/Los_Angeles'))
# Consolidated by the nightly sleep agent in the sleep service: captures it absorbed and
# cluster -> memory entity id ('' = forgotten). Refreshed at the start of every sync.
SLEEP = {'captures': set(), 'map': {}}
NOW = datetime.now(timezone.utc).isoformat()

SCHEMA = [
    'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
    'CREATE CONSTRAINT sync_state_id IF NOT EXISTS FOR (s:SyncState) REQUIRE s.id IS UNIQUE',
    'CREATE CONSTRAINT sleep_state_id IF NOT EXISTS FOR (s:SleepState) REQUIRE s.id IS UNIQUE',
    'CREATE INDEX entity_kind IF NOT EXISTS FOR (e:Entity) ON (e.kind)',
    'CREATE INDEX entity_time IF NOT EXISTS FOR (e:Entity) ON (e.t_start_us)',
    'CREATE INDEX entity_capture IF NOT EXISTS FOR (e:Entity) ON (e.capture_id)',
    'CREATE INDEX entity_media IF NOT EXISTS FOR (e:Entity) ON (e.media_id)',
    'CREATE INDEX entity_sample IF NOT EXISTS FOR (e:Entity) ON (e.sample_id)',
    'CREATE INDEX entity_cluster IF NOT EXISTS FOR (e:Entity) ON (e.cluster_id)',
    'CREATE FULLTEXT INDEX entity_text IF NOT EXISTS FOR (e:Entity) ON EACH [e.text, e.summary]',
] + [f"""CREATE VECTOR INDEX {name} IF NOT EXISTS FOR (e:Entity) ON e.{name}
         OPTIONS {{indexConfig: {{`vector.dimensions`: {dims}, `vector.similarity_function`: 'cosine'}}}}""" for name, dims in VECTOR_DIMS.items()]


def us(iso):
    if not iso:
        return None
    instant = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    return (instant - datetime(1970, 1, 1, tzinfo=timezone.utc)) // timedelta(microseconds=1)


def iso(t_us):
    return datetime.fromtimestamp(t_us / 1e6, timezone.utc).isoformat()


def is_test(capture_id):
    return bool(capture_id) and capture_id.startswith(TEST_PREFIXES)


def meters(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def jaccard(a, b):
    return len(a & b) / len(a | b) if a | b else 1.0


def segment(clips, clusters_by_media, locations):
    """Split one session's clips (sorted dicts with media_id/start_us/end_us) into episodes.

    Boundaries: gap > 20 s; episode longer than 10 min; moved > 100 m since the episode began;
    visible clusters of this and the next clip both barely overlap (< 0.1 Jaccard) with the last
    minute. Movement/scene splits need >= 30 s in the current episode. Speaker turns never split.
    """
    def location_at(t):
        before = [loc for loc in locations if loc[0] <= t]
        return before[-1][1:] if before else None
    episodes, current = [], None
    for i, clip in enumerate(clips):
        split = current is None
        if not split:
            last = current[-1]
            length = clip['end_us'] - current[0]['start_us']
            mature = clip['start_us'] - current[0]['start_us'] >= MIN_US
            here, origin = location_at(clip['start_us']), location_at(current[0]['start_us'])
            recent = set().union(*(clusters_by_media.get(c['media_id'], set()) for c in current if c['start_us'] >= clip['start_us'] - WINDOW_US))
            now_set = clusters_by_media.get(clip['media_id'], set())
            nxt = clusters_by_media.get(clips[i + 1]['media_id'], set()) if i + 1 < len(clips) else None
            scene = (len(recent) >= 2 and len(now_set) >= 2 and jaccard(now_set, recent) < SCENE_JACCARD
                     and nxt is not None and len(nxt) >= 1 and jaccard(nxt, recent) < SCENE_JACCARD)
            split = (clip['start_us'] - last['end_us'] > GAP_US or length > MAX_US
                     or (mature and here and origin and meters(here, origin) > MOVE_M) or (mature and scene))
        if split:
            current = []
            episodes.append(current)
        current.append(clip)
    return episodes


def mean_vector(vectors, dims):
    vectors = [v for v in vectors if v and len(v) == dims]
    if not vectors:
        return None
    total = [sum(column) for column in zip(*vectors)]
    norm = math.sqrt(sum(x * x for x in total))
    return [x / norm for x in total] if norm else None


def box_xywh(d):
    return d.get('bbox_xywh') or ([d['bbox'][0], d['bbox'][1], d['bbox'][2] - d['bbox'][0], d['bbox'][3] - d['bbox'][1]] if d.get('bbox') else None)


def crops(rows):
    """Where to look in the archive to see this appearance: clip, offset and box of frames spread over its time."""
    rows = [r for r in sorted(rows, key=lambda r: r['t_us']) if r['media_id'] and box_xywh(r['data']) and r['data'].get('frame_width')]
    if len(rows) > CROP_CAP:
        rows = [rows[round(i * (len(rows) - 1) / (CROP_CAP - 1))] for i in range(CROP_CAP)]
    return [{'media_id': r['media_id'], 'offset': r['offset'], 'box': [round(v, 1) for v in box_xywh(r['data'])],
             'w': r['data']['frame_width'], 'h': r['data']['frame_height']} for r in rows]


def detections(archive, capture_id, after_event=0, through_event=9223372036854775807):
    """Face/object detections of one capture, from the recognizers' archive events (one event per sampled frame)."""
    out = []
    for r in archive.execute("""SELECT rowid AS source_rowid, kind, start_us, model, body_json, refs_json FROM archive_events
            WHERE capture_id=? AND rowid>? AND rowid<=? AND kind IN ('face', 'object')""", (capture_id, after_event, through_event)):
        body, refs = json.loads(r['body_json']), json.loads(r['refs_json'] or '[]')
        ref = refs[0] if refs else {}
        for o in body.get('observations') or []:
            out.append({'source_rowid': r['source_rowid'], 'id': o.get('sample_id'), 'entity_id': o.get('entity_id'), 'model': r['model'], 'media_id': ref.get('media_id'),
                        'offset': ref.get('start_offset_seconds'), 't_us': r['start_us'], 'assignment': o.get('assignment'),
                        'data': {**o, 'modality': r['kind']}})
    return out


def clusters_from_events(archive, after_event, through_event, retired_sample_ids=()):
    """Clusters referenced by new source rows only; old archive IDs never resurrect on a timer."""
    out = {}
    for r in archive.execute("""SELECT kind,start_us,end_us,model,body_json FROM archive_events
            WHERE rowid>? AND rowid<=? AND kind IN ('face','object','speech')""", (after_event, through_event)):
        kind, model, body = r['kind'], r['model'] or '', json.loads(r['body_json'])
        if kind == 'speech':
            if 'campplus' not in model:
                continue
            ids = [body.get('speaker_entity_id')]
        else:
            ids = [o.get('entity_id') for o in body.get('observations') or []
                   if kind != 'object' or o.get('sample_id') not in retired_sample_ids]
        for eid in filter(None, ids):
            c = out.setdefault(eid, {'modality': 'voice' if kind == 'speech' else kind,
                                    'first': r['start_us'], 'last': r['end_us'], 'model': model.split('|')[-1]})
            c['first'], c['last'] = min(c['first'], r['start_us']), max(c['last'], r['end_us'])
    return out


def appearances(samples):
    """Group assigned face/object samples of one episode by cluster into appearance records."""
    groups = defaultdict(list)
    for s in samples:
        if s['entity_id']:
            groups[(s['data'].get('modality'), cluster_ref(s['entity_id']) or 'unresolved:' + s['entity_id'])].append(s)
    out = []
    for (_, canonical), rows in groups.items():
        rows = list({r['id'] or (r['media_id'], r['offset'], r['entity_id']): r for r in rows}.values())
        entity_id = rows[0]['entity_id']
        modality = rows[0]['data'].get('modality')
        def quality(r):
            d = r['data']
            box = d.get('bbox_xywh') or ([d['bbox'][0], d['bbox'][1], d['bbox'][2] - d['bbox'][0], d['bbox'][3] - d['bbox'][1]] if d.get('bbox') else [0, 0, 0, 0])
            return (d.get('confidence') or d.get('detection_score') or 0) * max(1.0, box[2] * box[3])
        best = max(rows, key=quality)
        name = 'face_vec' if modality == 'face' else 'object_vec'
        labels = Counter(r['data'].get('label') for r in rows if r['data'].get('label'))
        times = [r['t_us'] for r in rows]
        out.append({'entity_id': entity_id, 'canonical': canonical, 'modality': modality, 'frames': len({(r['media_id'], r['offset']) for r in rows}), 't_start_us': min(times), 't_end_us': max(times),
                    'best': best, 'label': labels.most_common(1)[0][0] if labels else None,
                    'user_corrected': any(r['assignment'] == 'user_corrected' for r in rows),
                    'sample_ids': [r['id'] for r in sorted(rows, key=lambda r: r['t_us'])][:SAMPLE_ID_CAP],
                    'crops': crops(rows),
                    'vector_name': name, 'vector': mean_vector([r['data'].get('embedding') for r in rows], VECTOR_DIMS[name])})
    return out


def text_key(text):
    """Normalisation used to recognise the same text read again (case, spaces and punctuation ignored)."""
    return ''.join(ch for ch in text.lower() if ch.isalnum())


def read_texts(events, after_event=0):
    """Keep legacy text keys; new OCR selects a frame, then preserves its separate blocks."""
    groups = {}
    for e in events:
        if e['body'].get('pipeline') == OCR_PIPELINE or e.get('source_rowid', 1) <= after_event:
            continue
        ref = e['refs'][0] if e['refs'] else {}
        for t in e['body'].get('texts') or []:
            key = text_key(t.get('text') or '')
            if len(key) < 2:
                continue
            g = groups.setdefault(key, {'texts': Counter(), 'carriers': Counter(), 'reads': 0, 't0': e['start_us'], 't1': e['start_us'], 'refs': [], 'box': t.get('bbox_2d')})
            g['texts'][t['text']] += 1; g['carriers'][t.get('carrier') or 'other'] += 1; g['reads'] += 1
            g['t0'], g['t1'] = min(g['t0'], e['start_us']), max(g['t1'], e['start_us'])
            if ref and len(g['refs']) < 10:
                g['refs'].append(ref)
    for group in representative_groups(events):
        best, observed = group['best'], group['events']
        if not any(e.get('source_rowid', 1) > after_event for e in observed):
            continue
        refs = best.get('refs') or []
        all_refs = [ref for event in observed for ref in event.get('refs') or []]
        for index, block in enumerate(best['body'].get('texts') or []):
            text = block.get('text')
            if not isinstance(text, str) or not text.strip():
                continue
            key = 'v2:%s:%d' % (group['anchor_event_id'], index)
            groups[key] = {
                'texts': Counter({text: 1}), 'carriers': Counter({block.get('carrier') or 'other': 1}),
                # This block was chosen from one actual sample. The wider group's
                # sampled span is recorded separately, not asserted as block visibility.
                'reads': 1, 't0': best['start_us'], 't1': best['start_us'],
                'refs': refs, 'box': block.get('bbox_2d'),
                'extra_props': {
                    'pipeline': OCR_PIPELINE, 'reading_strategy': 'exact-representative-frame-v1',
                    'ocr_group_id': 'ocr:' + group['anchor_event_id'],
                    'representative_event_id': best['event_id'], 'representative_block_index': index,
                    'confidence': finite_number(block.get('confidence')),
                    'frame_quality': finite_number(best['body'].get('frame_quality')),
                    'frame_size': json.dumps(best['body'].get('frame_size')),
                    'model': best.get('model'),
                    'group_observations': len(observed),
                    'group_first_observed_us': observed[0]['start_us'],
                    'group_last_observed_us': observed[-1]['start_us'],
                    'group_source_event_ids': json.dumps([event['event_id'] for event in observed]),
                    'group_source_refs': json.dumps(all_refs),
                },
            }
    return groups


def fold_observations(texts):
    """Distinct observations in order, evenly thinned to at most OBS_CAP (consecutive repeats dropped)."""
    distinct = []
    for text in texts:
        key = ' '.join(text.split()).lower()
        if key and (not distinct or distinct[-1][0] != key):
            distinct.append((key, text.strip()))
    kept = [t for _, t in distinct]
    if len(kept) > OBS_CAP:
        kept = [kept[round(i * (len(kept) - 1) / (OBS_CAP - 1))] for i in range(OBS_CAP)]
    return kept


def average(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return round(sum(values) / len(values), 3) if values else None


def flatten_map(mapping):
    out = {}
    for key in mapping:
        value, seen = key, set()
        while value in mapping:
            if value in seen:
                raise ValueError('cycle in SleepState.cluster_map')
            seen.add(value)
            value = mapping[value]
            if not value:
                break
        out[key] = value
    return out


def cluster_ref(entity_id):
    """A remembered identity or an unresolved source-specific identity; never group None together."""
    cid = 'cluster:' + entity_id
    return SLEEP['map'].get(cid, cid) or None


def decoded_list(value):
    if isinstance(value, str):
        return json.loads(value or '[]')
    return value or []


def stable_episodes(capture_id, proposed, existing):
    """Already materialized media keep their physical episode, including late observations.

    New clips use the existing segmenter. Remembered/deleted episodes are not restored
    unless there is new source material in that episode; build_session enforces that.
    """
    media_owner = {mid: e for e in existing for mid in decoded_list(e.get('media_ids'))}
    existing_by_id = {e['id']: e for e in existing}
    groups = {}
    for segment_clips in proposed:
        anchor = 'episode:%s:%d' % (capture_id, segment_clips[0]['start_us'])
        for clip in segment_clips:
            old = media_owner.get(clip['media_id'])
            if old:
                key = old['id']
            else:
                key = anchor
                previous = existing_by_id.get(key)
                if previous and clip['end_us'] - previous['t_start_us'] > MAX_US:
                    anchor = key = 'episode:%s:%d' % (capture_id, clip['start_us'])
            groups.setdefault(key, []).append(clip)
    return sorted(groups.items(), key=lambda row: row[1][0]['start_us'])


def build_session(archive, capture_id, clusters, *, after_event=0, after_media=0,
                  through_event=9223372036854775807, through_media=9223372036854775807,
                  retired_sample_ids=(), existing_episodes=()):
    """Read old context for segmentation, but materialize only newly committed source rows."""
    clips = [dict(r) for r in archive.execute(
        'SELECT rowid AS source_rowid, media_id, start_us, end_us, duration_seconds, metadata_json FROM archive_media WHERE capture_id=? AND rowid<=? ORDER BY start_us, clip_seq', (capture_id, through_media))]
    if not clips:
        raise ValueError('archive sources arrived before capture media; cursor retained for retry')
    for c in clips:
        c['facing'] = json.loads(c['metadata_json'] or '{}').get('camera_facing', 'unknown')
    events = [dict(r) for r in archive.execute("""SELECT rowid AS source_rowid, event_id, kind, start_us, end_us, started_at, model, body_json, refs_json
        FROM archive_events WHERE capture_id=? AND rowid<=? AND kind IN ('minicpm','speech','location','motion','scene_text') ORDER BY start_us""", (capture_id, through_event))]
    for e in events:
        e['body'], e['refs'] = json.loads(e['body_json']), json.loads(e['refs_json'] or '[]')
    samples = detections(archive, capture_id, through_event=through_event)
    clusters_by_media = defaultdict(set)
    for s in samples:
        if s['entity_id']:
            clusters_by_media[s['media_id']].add(s['entity_id'])
    locations = [(e['start_us'], e['body'].get('latitude'), e['body'].get('longitude')) for e in events
                 if e['kind'] == 'location' and e['body'].get('latitude') is not None]
    episode_pairs = stable_episodes(capture_id, segment(clips, clusters_by_media, locations), existing_episodes)
    episodes = [ep for _, ep in episode_pairs]
    all_events = events
    events = [e for e in events if e['source_rowid'] > after_event]
    samples = [r for r in samples if r['source_rowid'] > after_event and
               (r['data']['modality'] != 'object' or r['id'] not in retired_sample_ids)]
    media_ids = {c['media_id'] for c in clips}
    missing_media = {r['media_id'] for r in samples if r['media_id'] and r['media_id'] not in media_ids}
    missing_media |= {r.get('media_id') for e in events for r in e['refs']
                      if r.get('media_id') and r['media_id'] not in media_ids}
    if missing_media:
        raise ValueError('new archive observation references missing media; cursor retained for retry')
    nodes = []
    session_id = 'session:' + capture_id
    nodes.append({'id': session_id, 'kind': 'session', 'props': {'capture_id': capture_id, 't_start_us': clips[0]['start_us'],
                  't_end_us': max(c['end_us'] for c in clips), 't_start': iso(clips[0]['start_us'])}})
    spans = [(ep[0]['start_us'], max(c['end_us'] for c in ep)) for ep in episodes]
    episode_ids = [eid for eid, _ in episode_pairs]

    def episode_of(t):
        for idx, (a, b) in enumerate(spans):
            if a <= t <= b:
                return idx
        return min(range(len(spans)), key=lambda idx: min(abs(t - spans[idx][0]), abs(t - spans[idx][1])))

    all_text_by_episode = defaultdict(list)
    for event in all_events:
        if event['kind'] == 'scene_text':
            all_text_by_episode[episode_of(event['start_us'])].append(event)
    by_episode = defaultdict(lambda: defaultdict(list))
    for e in events:
        by_episode[episode_of(e['start_us'])][e['kind']].append(e)
    media_episode = {c['media_id']: idx for idx, ep in enumerate(episodes) for c in ep}
    sample_groups = defaultdict(list)
    for s in samples:
        if s['media_id'] in media_episode:
            sample_groups[media_episode[s['media_id']]].append(s)
    for idx, ep in enumerate(episodes):
        eid, (start, end), grouped = episode_ids[idx], spans[idx], by_episode[idx]
        if not grouped and not sample_groups[idx] and not any(c['source_rowid'] > after_media for c in ep):
            continue
        observations = fold_observations([(e['body'].get('generated_text') or '') for e in grouped['minicpm']])
        apps = appearances(sample_groups[idx])
        unassigned = Counter(s['data'].get('modality') for s in sample_groups[idx] if not s['entity_id'])
        speakers = Counter()
        for e in grouped['speech']:
            speaker = e['body'].get('speaker_entity_id')
            if speaker in clusters:
                speakers[speaker] += e['body'].get('duration_seconds') or 0
        locs = [e['body'] for e in grouped['location']]
        motion = [e['body'].get('summary', {}) for e in grouped['motion']]
        facing = Counter(c['facing'] for c in ep).most_common(1)[0][0]
        minutes = (end - start) / 60e6
        faces = sum(1 for a in apps if a['modality'] == 'face')
        objects = Counter(a['label'] for a in apps if a['modality'] == 'object')
        read = read_texts(all_text_by_episode[idx], after_event)
        first_visual = next((o.split('\n')[0].split(':', 1)[-1].strip() for o in observations), '')
        summary = (f"{datetime.fromtimestamp(start / 1e6, LOCAL_TIMEZONE):%H:%M}–{datetime.fromtimestamp(end / 1e6, LOCAL_TIMEZONE):%H:%M} ({minutes:.1f} minutes) "
                   f"{facing or 'unknown'} camera · {len(grouped['speech'])} speech segments"
                   f"{' (' + ', '.join(f'voice {k[-6:]} {v:.0f}s' for k, v in speakers.most_common(3)) + ')' if speakers else ''}"
                   f" · {faces} faces" + (f" · objects: {', '.join(f'{k}×{v}' for k, v in objects.most_common(5))}" if objects else '')
                   + (f" · text regions {len(read)}" if read else '') + (f" · {first_visual[:80]}" if first_visual else ''))
        nodes.append({'id': eid, 'kind': 'episode', 'props': {
            'capture_id': capture_id, 't_start_us': start, 't_end_us': end, 't_start': iso(start), 'duration_s': round((end - start) / 1e6, 1),
            'clip_count': len(ep), 'media_ids': json.dumps([c['media_id'] for c in ep]), 'camera_facing': facing,
            'speech_count': len(grouped['speech']), 'speakers': json.dumps([{'cluster': k, 'seconds': round(v, 1)} for k, v in speakers.most_common()]),
            'observation_count': len(grouped['minicpm']), 'observations': json.dumps(observations, ensure_ascii=False), 'text': '\n'.join(observations),
            'unassigned_faces': unassigned.get('face', 0), 'unassigned_objects': unassigned.get('object', 0),
            'lat': average([l.get('latitude') for l in locs]), 'lon': average([l.get('longitude') for l in locs]),
            'accuracy_m': average([l.get('accuracy_m') for l in locs]), 'pressure_hpa': average([l.get('pressure_hpa') for l in locs]),
            'location_fixes': len(locs), 'motion_batches': len(motion),
            'camera_pitch_deg_mean': average([m.get('camera_pitch_deg_mean') for m in motion]),
            'facing_down_fraction': average([m.get('facing_down_fraction') for m in motion]),
            'level_fraction': average([m.get('level_fraction') for m in motion]),
            'user_acceleration_rms_mps2': average([m.get('user_acceleration_rms_mps2') for m in motion]),
            'text_count': len(read), 'summary': summary, 'created_by': 'consolidation'}})
        for a in apps:
            suffix = (a['canonical'].removeprefix('cluster:') if a['canonical'].startswith('cluster:')
                      else a['modality'] + ':' + a['canonical'])
            aid = 'appearance:%s:%s' % (eid.removeprefix('episode:'), suffix)
            best = a['best']
            props = {'capture_id': capture_id, 'episode_id': eid, 't_start_us': a['t_start_us'], 't_end_us': a['t_end_us'], 't_start': iso(a['t_start_us']),
                     'frames': a['frames'], 'label': a['label'], 'source_id': best['id'], 'media_id': best['media_id'], 'offset_start': best['offset'],
                     'sample_ids': json.dumps(a['sample_ids']), 'crops': json.dumps(a['crops']), 'model': best['model'], 'cluster_id': cluster_ref(a['entity_id']),
                     'cluster_assignment': 'user' if a['user_corrected'] else 'model'}
            if a['vector']:
                props[a['vector_name']] = a['vector']
            nodes.append({'id': aid, 'kind': a['modality'] + '_appearance', 'props': props})
        for key, g in read.items():
            tid = 'text:%s:%d:%s' % (capture_id, start, hashlib.sha1(key.encode()).hexdigest()[:12])
            ref = g['refs'][0] if g['refs'] else {}
            nodes.append({'id': tid, 'kind': 'text_appearance', 'props': {
                'capture_id': capture_id, 'episode_id': eid, 't_start_us': g['t0'], 't_end_us': g['t1'], 't_start': iso(g['t0']),
                'text': g['texts'].most_common(1)[0][0], 'summary': g['texts'].most_common(1)[0][0], 'carrier': g['carriers'].most_common(1)[0][0],
                'reads': g['reads'], 'bbox_2d': json.dumps(g['box']) if g['box'] else None, 'media_id': ref.get('media_id'),
                'offset_start': ref.get('start_offset_seconds'), 'media_ids': json.dumps([r['media_id'] for r in g['refs']]),
                **g.get('extra_props', {})}})
        for e in grouped['speech']:
            body = e['body']
            vec = body.get('embedding')
            ref = e['refs'][0] if e['refs'] else {}
            sid = 'speech:' + e['event_id']
            speaker = body.get('speaker_entity_id')
            corrected = False
            nodes.append({'id': sid, 'kind': 'speech_segment', 'props': {
                'capture_id': capture_id, 'episode_id': eid, 't_start_us': e['start_us'], 't_end_us': e['end_us'], 't_start': e['started_at'],
                'text': body.get('text'), 'summary': body.get('text'), 'duration_s': body.get('duration_seconds'), 'sample_id': body.get('sample_id'),
                'asr_model': body.get('asr_model'), 'model': e['model'], 'media_id': ref.get('media_id'), 'offset_start': ref.get('start_offset_seconds'),
                'media_ids': json.dumps([r['media_id'] for r in e['refs']]),
                'voice_vec': vec if vec and len(vec) == VECTOR_DIMS['voice_vec'] else None,
                'cluster_id': cluster_ref(speaker) if speaker in clusters else None,
                'cluster_assignment': ('user' if corrected else 'model') if speaker in clusters else None,
                'speaker_similarity': None if corrected else body.get('speaker_similarity')}})
    return nodes if len(nodes) > 1 else []


def ro(path):
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA temp_store=MEMORY')  # the container filesystem is read-only; sorts must not spill to disk
    return db


def union_values(*values, cap=None):
    seen, result = set(), []
    for value in values:
        for item in decoded_list(value):
            key = json.dumps(item, sort_keys=True, separators=(',', ':'))
            if key not in seen:
                seen.add(key)
                result.append(item)
    if cap and len(result) > cap:
        result = [result[round(i * (len(result) - 1) / (cap - 1))] for i in range(cap)]
    return result


def merge_props(old, incoming, kind):
    """Append a source delta without rebuilding forgotten history or overwriting user notes."""
    props = {**old, **{k: v for k, v in incoming.items() if v is not None}}
    for field, fn in [('t_start_us', min), ('t_end_us', max)]:
        values = [p[field] for p in (old, incoming) if p.get(field) is not None]
        if values:
            props[field] = fn(values)
    if props.get('t_start_us') is not None:
        props['t_start'] = iso(props['t_start_us'])
    if kind in ('object_appearance', 'face_appearance'):
        n0, n1 = int(old.get('frames') or 0), int(incoming.get('frames') or 0)
        # Archive event IDs/cursors provide delivery idempotence. Within a source batch,
        # appearances() removes duplicate sample IDs and counts distinct sampled frames.
        props['frames'] = n0 + n1
        props['sample_ids'] = json.dumps(union_values(old.get('sample_ids'), incoming.get('sample_ids'), cap=SAMPLE_ID_CAP))
        props['crops'] = json.dumps(union_values(old.get('crops'), incoming.get('crops'), cap=CROP_CAP))
        for vk in ('object_vec', 'face_vec'):
            a, b = old.get(vk), incoming.get(vk)
            if a and b and len(a) == len(b):
                combined = [x * n0 + y * n1 for x, y in zip(a, b)]
                norm = math.sqrt(sum(x * x for x in combined))
                if norm:
                    props[vk] = [x / norm for x in combined]
        if old.get('cluster_assignment') == 'user':
            props['cluster_assignment'] = 'user'
    elif kind == 'episode':
        for key in ('speech_count', 'observation_count', 'unassigned_faces', 'unassigned_objects',
                    'location_fixes', 'motion_batches', 'text_count'):
            props[key] = int(old.get(key) or 0) + int(incoming.get(key) or 0)
        for key, weight in [('lat', 'location_fixes'), ('lon', 'location_fixes'), ('accuracy_m', 'location_fixes'),
                            ('pressure_hpa', 'location_fixes'), ('camera_pitch_deg_mean', 'motion_batches'),
                            ('facing_down_fraction', 'motion_batches'), ('level_fraction', 'motion_batches'),
                            ('user_acceleration_rms_mps2', 'motion_batches')]:
            if old.get(key) is not None and incoming.get(key) is not None:
                a, b = int(old.get(weight) or 0), int(incoming.get(weight) or 0)
                if a + b:
                    props[key] = (old[key] * a + incoming[key] * b) / (a + b)
        obs = fold_observations(decoded_list(old.get('observations')) + decoded_list(incoming.get('observations')))
        props['observations'], props['text'] = json.dumps(obs, ensure_ascii=False), '\n'.join(obs)
        speakers = Counter()
        for row in decoded_list(old.get('speakers')) + decoded_list(incoming.get('speakers')):
            speakers[row['cluster']] += row['seconds']
        props['speakers'] = json.dumps([{'cluster': k, 'seconds': v} for k, v in speakers.most_common()])
        mids = union_values(old.get('media_ids'), incoming.get('media_ids'))
        props['media_ids'], props['clip_count'] = json.dumps(mids), len(mids)
        props['duration_s'] = round((props['t_end_us'] - props['t_start_us']) / 1e6, 1)
        first = obs[0].split('\n')[0] if obs else ''
        props['summary'] = f"{props['duration_s'] / 60:.1f} minutes · {props['speech_count']} speech segments · text regions {props['text_count']}" + (f' · {first[:80]}' if first else '')
    elif kind == 'text_appearance' and incoming.get('pipeline') != OCR_PIPELINE:
        props['reads'] = int(old.get('reads') or 0) + int(incoming.get('reads') or 0)
        props['media_ids'] = json.dumps(union_values(old.get('media_ids'), incoming.get('media_ids')))
    return props


def write_nodes(tx, nodes):
    """Upsert deltas in the same transaction as the source cursors; preserve memory/user state."""
    # A previously named/remembered canonical may have a legacy raw-ID appearance.
    # Reuse it; never delete another node's LINKs just to force an ID migration.
    keys = [{'id': n['id'], 'episode': n['props']['episode_id'], 'cluster': n['props']['cluster_id'], 'kind': n['kind']}
            for n in nodes if n['kind'] in ('object_appearance', 'face_appearance') and n['props'].get('cluster_id')]
    reused = {}
    if keys:
        for row in tx.run("""UNWIND $keys AS k MATCH (e:Entity {episode_id:k.episode,cluster_id:k.cluster,kind:k.kind})
                RETURN k.id AS incoming,min(e.id) AS existing""", keys=keys):
            reused[row['incoming']] = row['existing']
    for node in nodes:
        node['id'] = reused.get(node['id'], node['id'])
    for i in range(0, len(nodes), 300):
        chunk = nodes[i:i + 300]
        old = {r['p']['id']: r['p'] for r in tx.run(
            'MATCH (e:Entity) WHERE e.id IN $ids RETURN properties(e) AS p', ids=[n['id'] for n in chunk])}
        rows = []
        for node in chunk:
            previous = old.get(node['id'], {})
            if previous.get('layer') == 'memory':
                raise ValueError('perception sync must not overwrite a memory node')
            if previous.get('kind') and previous['kind'] != node['kind']:
                raise ValueError('entity kind changed at a stable source ID')
            props = merge_props(previous, node['props'], node['kind'])
            for key in ('id', 'kind', 'created_at', 'synced_at', 'updated_at'):
                props.pop(key, None)
            rows.append({'id': node['id'], 'kind': node['kind'], 'props': props})
        tx.run("""UNWIND $rows AS r MERGE (e:Entity {id:r.id})
            ON CREATE SET e.created_at=$now
            SET e += r.props, e.kind=r.kind, e.synced_at=$now""", rows=rows, now=NOW)


def archived_object_samples(archive, after_event, through_event):
    """JSON1 extracts IDs without sending embeddings through the coordinator."""
    return {r[0] for r in archive.execute("""SELECT DISTINCT json_extract(o.value,'$.sample_id')
        FROM archive_events AS e, json_each(e.body_json,'$.observations') AS o
        WHERE e.kind='object' AND e.rowid>? AND e.rowid<=?
          AND json_extract(o.value,'$.sample_id') IS NOT NULL""", (after_event, through_event))}


def graph_protection(tx, mapping, state=None, now=None):
    rows = list(tx.run("""MATCH (e:Entity)
        WHERE e.layer='memory' OR e.name IS NOT NULL OR e.cluster_assignment='user'
           OR NOT coalesce(e.user_notes,'') IN ['', '[]', '{}']
           OR EXISTS { MATCH (e)-[:LINK]-() }
        RETURN e.id AS id,e.cluster_id AS cluster_id,e.kind AS kind,e.layer AS layer"""))
    protected = set()
    memories = {r['id'] for r in rows if r['layer'] == 'memory'}
    for row in rows:
        for cid in (row['id'], row['cluster_id']):
            if cid and cid.startswith('cluster:'):
                protected.add(cid.removeprefix('cluster:'))
    # Forgotten ('') entries do not pin weak objects forever.
    protected.update(k.removeprefix('cluster:') for k, v in mapping.items() if v in memories and k.startswith('cluster:'))
    # The sleep model runs outside the graph transaction. Keep its source prototypes
    # alive until that exact snapshot is applied or its guarded lease expires.
    if state and state.get('sleep_token'):
        expires = state.get('sleep_expires_at')
        if not expires or us(expires) > us((now or datetime.now(timezone.utc)).isoformat()):
            protected.update(state.get('sleep_protected_ids') or [])
    return protected


def apply_retirement(tx, batch):
    """Remove only unprotected raw detail covered by the acknowledged SQLite episode."""
    if not batch:
        return 0
    rows = [{'cid': 'cluster:' + r['entity_id'], 'until': us(r['last_seen'])} for r in batch['retired']]
    result = tx.run("""UNWIND $rows AS r
        MATCH (e:Entity {kind:'object_appearance',cluster_id:r.cid})
        WHERE e.t_end_us <= r.until AND e.layer IS NULL AND e.name IS NULL
          AND coalesce(e.user_notes,'') IN ['', '[]', '{}'] AND coalesce(e.cluster_assignment,'model') <> 'user'
          AND NOT EXISTS { MATCH (e)-[:LINK]-() }
        WITH DISTINCT e DETACH DELETE e RETURN count(*) AS n""", rows=rows).single()
    removed = result['n'] if result else 0
    result = tx.run("""UNWIND $rows AS r MATCH (e:Entity {id:r.cid,kind:'object_cluster'})
        WHERE e.layer IS NULL AND e.name IS NULL AND coalesce(e.user_notes,'') IN ['', '[]', '{}']
          AND NOT EXISTS { MATCH (e)-[:LINK]-() }
          AND NOT EXISTS { MATCH (f:Entity {cluster_id:e.id}) }
        WITH DISTINCT e DETACH DELETE e RETURN count(*) AS n""", rows=rows).single()
    return removed + (result['n'] if result else 0)


def sync(driver, *, archive_path=None, entity_path=None, retention_api=None):
    if retention_api is None:
        from entity_worker import retention as retention_api
    archive, entities = ro(archive_path or ARCHIVE_DB), sqlite3.connect(entity_path or ENTITY_DB, timeout=30)
    counts, batch = Counter(), None
    try:
        with driver.session() as session:
            for statement in SCHEMA:
                session.run(statement).consume()
            # This durable marker closes the SQLite-commit / graph-rollback gap.
            # Sleep refuses to read/apply while it exists. A failed coordinator
            # leaves the same token for the next minute to resume its pending batch.
            with session.begin_transaction() as claim:
                state = claim.run(LOCK_QUERY, now=NOW).single()['s']
                if state.get('version') not in (None, 2):
                    raise ValueError('legacy graph version requires explicit migration before retention')
                token = state.get('maintenance_token') or uuid.uuid4().hex
                claim.run("MATCH (s:SyncState {id:'cursors'}) SET s.maintenance_token=$token", token=token).consume()
                claim.commit()
            tx = session.begin_transaction()
            try:
                # This exact state row is also locked by sleep reads/apply. No timer overlap
                # or stale pre-lock map can write after a completed consolidation.
                state = tx.run(LOCK_QUERY, now=NOW).single()['s']
                if state.get('maintenance_token') != token:
                    raise RuntimeError('maintenance already completed by another coordinator; retry next interval')
                if state.get('version') not in (None, 2):
                    raise ValueError('legacy graph version requires explicit migration before retention')
                archive.execute('BEGIN')
                top = {k: archive.execute(f'SELECT coalesce(max(rowid),0) FROM archive_{table}').fetchone()[0]
                       for k, table in [('media', 'media'), ('event', 'events')]}
                cur = {k: int(state.get(k) or 0) for k in ('media', 'event')}
                if any(cur[k] > top[k] for k in cur):
                    raise ValueError('archive cursor moved backwards; refuse implicit historical replay')
                sleep = tx.run("OPTIONAL MATCH (s:SleepState {id:'sleep'}) RETURN s.captures AS caps,s.cluster_map AS cmap").single()
                SLEEP['captures'] = set(sleep['caps'] or [])
                SLEEP['map'] = flatten_map(json.loads(sleep['cmap'] or '{}'))
                targets = sorted(set(v for v in SLEEP['map'].values() if v))
                if targets:
                    found_targets = {r['id'] for r in tx.run('MATCH (e:Entity) WHERE e.id IN $ids RETURN e.id AS id', ids=targets)}
                    if found_targets != set(targets):
                        raise ValueError('SleepState mapping has missing targets; graph left unchanged')
                maintenance_now = datetime.now(timezone.utc)
                protected = graph_protection(tx, SLEEP['map'], state, maintenance_now)
                counts['source_new_events'] = archive.execute('SELECT count(*) FROM archive_events WHERE rowid>? AND rowid<=?', (cur['event'], top['event'])).fetchone()[0]
                counts['source_new_media'] = archive.execute('SELECT count(*) FROM archive_media WHERE rowid>? AND rowid<=?', (cur['media'], top['media'])).fetchone()[0]
                seed_after = 0 if state.get('retention_version') != 1 else cur['event']
                confirmations = archived_object_samples(archive, seed_after, top['event'])
                counts['retention_archive_confirmed'] = retention_api.confirm_archived(entities, confirmations)
                counts['retention_retried'] = int(retention_api.pending(entities) is not None)
                batch = retention_api.prepare(entities, now=maintenance_now, graph_protected_ids=protected)
                counts['retention_active_objects'] = entities.execute("SELECT count(*) FROM entities WHERE modality='object'").fetchone()[0]
                row = entities.execute("SELECT value FROM config WHERE key='retention:state'").fetchone()
                arrival = json.loads(row[0]).get('arrival_points', []) if row else []
                counts['retention_warmup'] = int(not any(p['at'] <= maintenance_now.timestamp() - 300 for p in arrival))
                counts['retention_retired'] = len(batch['retired']) if batch else 0
                counts['retention_vectors_removed'] = batch.get('counts', {}).get('vectors_removed', 0) if batch else 0
                already_applied = bool(batch and state.get('retention_batch') == batch['id'])
                counts['retention_already_applied'] = int(already_applied)
                # A late new sample can have an earlier source timestamp than the
                # retired episode. Never run that old time-based deletion again
                # after its graph commit, even if the SQLite ACK was lost.
                counts['retention_deleted_graph_nodes'] = 0 if already_applied else apply_retirement(tx, batch)
                new_sample_ids = confirmations if seed_after == cur['event'] else archived_object_samples(archive, cur['event'], top['event'])
                retired = retention_api.retired_samples(entities, new_sample_ids)
                found = clusters_from_events(archive, cur['event'], top['event'], retired)
                clusters = {eid: c['modality'] for eid, c in found.items()}
                cluster_nodes = []
                for eid, c in found.items():
                    if 'cluster:' + eid in SLEEP['map']:
                        continue
                    cluster_nodes.append({'id': 'cluster:' + eid, 'kind': c['modality'] + '_cluster', 'props': {
                        'model': c['model'], 't_start': iso(c['first']), 't_start_us': c['first'], 't_end_us': c['last'], 'source_id': eid}})
                write_nodes(tx, cluster_nodes)
                touched = {r[0] for r in archive.execute('SELECT DISTINCT capture_id FROM archive_media WHERE rowid>? AND rowid<=?', (cur['media'], top['media']))}
                touched |= {r[0] for r in archive.execute('SELECT DISTINCT capture_id FROM archive_events WHERE rowid>? AND rowid<=? AND capture_id IS NOT NULL', (cur['event'], top['event']))}
                for capture_id in sorted(c for c in touched if c and not is_test(c)):
                    existing = [r['p'] for r in tx.run("MATCH (e:Entity {capture_id:$c,kind:'episode'}) RETURN properties(e) AS p", c=capture_id)]
                    nodes = build_session(archive, capture_id, clusters, after_event=cur['event'], after_media=cur['media'],
                                          through_event=top['event'], through_media=top['media'], retired_sample_ids=retired,
                                          existing_episodes=existing)
                    write_nodes(tx, nodes)
                    counts.update(n['kind'] for n in nodes)
                    counts['sessions'] += 1
                tx.run("""MATCH (s:SyncState {id:'cursors'})
                    SET s += $top,s.synced_at=$now,s.version=2,s.retention_version=1,
                        s.retention_batch=$batch
                    REMOVE s.maintenance_token""", top=top, now=NOW,
                    batch=batch['id'] if batch else state.get('retention_batch'))
                tx.commit()
            except BaseException:
                # A lost commit response can mean the server already committed.
                # Preserve that original error; the durable pending batch/cursor
                # makes the next interval safe regardless of the commit outcome.
                try:
                    if not tx.closed():
                        tx.rollback()
                except Exception:
                    pass
                raise
            finally:
                tx.close()
        # An uncertain commit/ACK never loses the pending SQLite batch. Retrying the
        # same batch sees the atomically advanced graph cursor and removes zero twice.
        if batch:
            retention_api.ack(entities, batch['id'])
        counts['retention_pending'] = int(retention_api.pending(entities) is not None)
        return dict(counts)
    finally:
        archive.rollback()
        archive.close()
        entities.close()


def publish_counts(driver, maintenance=None):
    """Graph size gauges: entities by kind and the number of links."""
    from prometheus_client import Gauge
    global GRAPH_ENTITIES, GRAPH_LINKS, RETENTION_ACTIVE, RETENTION_PENDING
    if 'GRAPH_ENTITIES' not in globals():
        GRAPH_ENTITIES = Gauge('scene_graph_entities', 'Graph entities by kind', ['kind'])
        GRAPH_LINKS = Gauge('scene_graph_links', 'Graph links (one natural-language link per entity pair)')
        RETENTION_ACTIVE = Gauge('scene_retention_active_objects', 'Active object recognition prototypes')
        RETENTION_PENDING = Gauge('scene_retention_pending', 'SQLite retention batch awaiting graph acknowledgement')
    with driver.session() as session:
        entities = session.run('MATCH (e:Entity) RETURN e.kind AS kind, count(*) AS n').data()
        links = session.run('MATCH ()-[l:LINK]->() RETURN count(l) AS n').single()['n']
    GRAPH_ENTITIES.clear()
    for row in entities:
        GRAPH_ENTITIES.labels(row['kind'] or 'none').set(row['n'])
    GRAPH_LINKS.set(links)
    if maintenance:
        RETENTION_ACTIVE.set(maintenance.get('retention_active_objects', 0))
        RETENTION_PENDING.set(maintenance.get('retention_pending', 0))


def main():
    global NOW
    sys.path.insert(0, os.environ.get('RECOGNITION_SOURCE_DIR', str(Path(__file__).resolve().parent.parent / 'recognition')))
    from entity_worker import metrics
    metrics.serve()
    driver = GraphDatabase.driver(os.environ.get('GRAPH_URL', 'bolt://neo4j:7687'), auth=None)
    interval = float(sys.argv[1]) if len(sys.argv) > 1 else 0
    while True:
        NOW = datetime.now(timezone.utc).isoformat()
        t = time.time()
        try:
            counts = sync(driver)
            metrics.job('graph_sync', 'ok', time.time() - t)
            publish_counts(driver, counts)
            print(json.dumps({'status': 'synced', 'seconds': round(time.time() - t, 1), 'written': counts}, ensure_ascii=False), flush=True)
        except Exception as error:
            metrics.job('graph_sync', 'error', time.time() - t)
            print(json.dumps({'status': 'retry_pending', 'error': type(error).__name__, 'detail': str(error)[:200]}), flush=True)
        if not interval:
            return
        time.sleep(interval)


if __name__ == '__main__':
    main()

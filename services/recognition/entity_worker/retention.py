"""Bound the object working set without changing the entity schema.

Only the worker's archive receipts (or a checked archive backfill) may confirm
samples. Samples remain as lightweight replay/provenance records; they are not
an unbounded vector store and are deliberately not deleted by this module.
This module is stdlib-only so the graph synchronizer can use it directly.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
import time
import uuid

STATE_KEY = 'retention:state'
PENDING_KEY = 'retention:pending'
META_KEY = '_retention'


@dataclass(frozen=True)
class Policy:
    interval_seconds: int = 60
    recent_seconds: int = 300
    minimum_frames: int = 3
    minimum_span_seconds: int = 5
    budget: int = 2000
    retire_limit: int = 512
    strip_limit: int = 1000
    # Also bound the work of setting the retired provenance on sample rows.
    retire_sample_limit: int = 4096

    def __post_init__(self):
        if (self.interval_seconds < 1 or self.recent_seconds < self.interval_seconds
                or self.minimum_frames < 1 or self.minimum_span_seconds < 0
                or self.recent_seconds > self.interval_seconds * 7
                or min(self.budget, self.retire_limit, self.strip_limit, self.retire_sample_limit) < 1):
            raise ValueError('invalid_retention_policy')


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _at(value):
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError('retention_time_requires_timezone')
        return value.timestamp()
    result = time.time() if value is None else float(value)
    if not math.isfinite(result):
        raise ValueError('invalid_retention_time')
    return result


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec='microseconds')


def _rows(cursor):
    keys = [column[0] for column in cursor.description]
    return [dict(zip(keys, row)) for row in cursor]


@contextmanager
def _transaction(db):
    if db.in_transaction:
        raise ValueError('retention_requires_own_sqlite_transaction')
    db.execute('BEGIN IMMEDIATE')
    try:
        yield
        db.commit()
    except BaseException:
        db.rollback()
        raise


def _config(db, key, default=None):
    row = db.execute('SELECT value FROM config WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _set_config(db, key, value):
    db.execute('INSERT OR REPLACE INTO config(key,value) VALUES (?,?)', (key, _json(value)))


def pending(db):
    """Return the exact durable batch until the graph commit is acknowledged."""
    return _config(db, PENDING_KEY)


def ack(db, batch_id):
    """Acknowledge only the batch whose graph transaction has committed."""
    with _transaction(db):
        batch = pending(db)
        if not batch or batch['id'] != batch_id:
            return False
        db.execute('DELETE FROM config WHERE key=?', (PENDING_KEY,))
        state = _config(db, STATE_KEY, {})
        state['last_acked_batch'] = batch_id
        _set_config(db, STATE_KEY, state)
        return True


def confirm_archived(db, sample_ids):
    """Seed checked archive receipts, in short independent SQLite transactions.

    Never infer archival from an empty outbox or from media existence alone.
    This is intended for one checked backfill and subsequently receipt IDs.
    """
    ids = tuple(dict.fromkeys(sample_ids))
    changed = 0
    for start in range(0, len(ids), 256):
        part = ids[start:start + 256]
        with _transaction(db):
            cursor = db.execute("""UPDATE samples SET data=json_set(data,'$._retention.archive_confirmed',1)
                WHERE id IN (%s) AND json_extract(data,'$.modality')='object'
                AND coalesce(json_extract(data,'$._retention.archive_confirmed'),0)!=1"""
                % ','.join('?' for _ in part), part)
            changed += cursor.rowcount
    return changed


def retired_samples(db, sample_ids):
    """Identify retired original observations during graph replay, not future IDs."""
    ids = tuple(dict.fromkeys(sample_ids))
    result = set()
    for start in range(0, len(ids), 512):
        part = ids[start:start + 512]
        result.update(row[0] for row in db.execute("""SELECT id FROM samples
            WHERE id IN (%s) AND entity_id IS NULL AND json_type(data,'$._retention.retired_entity_id')='text'"""
            % ','.join('?' for _ in part), part))
    return result


def _delivery_protection(db):
    """Protect in-flight/rejected observations and media still owned by a job."""
    sample_ids, entity_ids, media_ids = set(), set(), set()
    for table in ('outbox', 'events', 'rejected_events'):
        for (payload,) in db.execute('SELECT payload FROM ' + table):
            event = json.loads(payload)
            entity_ids.update(value for value in event.get('entity_ids', ()) if isinstance(value, str))
            for observation in event.get('body', {}).get('observations', ()):
                if observation.get('sample_id'):
                    sample_ids.add(observation['sample_id'])
                if observation.get('entity_id'):
                    entity_ids.add(observation['entity_id'])
            media_ids.update(ref['media_id'] for ref in event.get('media_refs', ()) if ref.get('media_id'))
    media_ids.update(row[0] for row in db.execute('SELECT media_id FROM jobs'))
    return sample_ids, entity_ids, media_ids


def prepare(db, *, now=None, archived_sample_ids=None, graph_protected_ids=(), policy=None):
    """Atomically compact SQLite and persist a graph batch, or return its retry.

    The graph owner must hold its synchronization lock while obtaining graph
    protection and invoking this function. It must commit the graph before ack.
    No new observations are rejected when the working-set target is exceeded.
    """
    policy = policy or Policy()
    current = _at(now)
    if archived_sample_ids is not None:
        confirm_archived(db, archived_sample_ids)
    with _transaction(db):
        previous = pending(db)
        if previous is not None:
            return previous
        state = _config(db, STATE_KEY, {})
        if current < state.get('last_run', -math.inf) + policy.interval_seconds:
            return None
        maximum_rowid = db.execute('SELECT coalesce(max(rowid),0) FROM samples').fetchone()[0]
        points = state.get('arrival_points', [])
        points.append({'at': current, 'max_rowid': maximum_rowid})
        older = [point for point in points if point['at'] <= current - policy.recent_seconds]
        cutoff = max(older, key=lambda point: point['at']) if older else None
        # Preserve one old point plus the recent points. At one-minute cadence
        # this is six points; unusual faster calls safely restart the warm-up.
        newer = [point for point in points if point['at'] > current - policy.recent_seconds]
        points = ([cutoff] if cutoff else []) + newer
        state.update(last_run=current, arrival_points=points[-8:])
        _set_config(db, STATE_KEY, state)
        if cutoff is None:
            return None
        arrival_cutoff = cutoff['max_rowid']
        source_cutoff = current - policy.recent_seconds
        entities = {row['id']: row for row in _rows(db.execute(
            "SELECT id,name,first_seen,last_seen,scope_capture FROM entities WHERE modality='object'"))}
        rows = _rows(db.execute("""SELECT rowid,id,entity_id,model,media_id,capture_id,offset,started_at,assignment,
            coalesce(json_extract(data,'$._retention.archive_confirmed'),0) AS archived,
            CASE WHEN json_type(data,'$.embedding')='array' AND json_array_length(data,'$.embedding')>0
                 THEN 1 ELSE 0 END AS has_vector
            FROM samples WHERE json_extract(data,'$.modality')='object'"""))
        delivery_samples, delivery_entities, delivery_media = _delivery_protection(db)
        protected = set(graph_protected_ids) | delivery_entities
        for (body,) in db.execute('SELECT body FROM corrections'):
            correction = json.loads(body)
            protected.update(value for key, value in correction.items()
                if key in ('entity_id', 'before', 'after') and isinstance(value, str) and value in entities)
        protected.update(e for e, row in entities.items() if row['name'] is not None or row['scope_capture'] is not None)
        by_entity = {e: [] for e in entities}
        for row in rows:
            row['time'] = _at(row['started_at'])
            row['pending'] = row['id'] in delivery_samples or row['media_id'] in delivery_media
            row['recent'] = row['rowid'] > arrival_cutoff or row['time'] >= source_cutoff
            if row['entity_id'] in by_entity:
                by_entity[row['entity_id']].append(row)
                if (row['recent'] or row['pending'] or row['archived'] != 1
                        or row['assignment'] == 'user_corrected'):
                    protected.add(row['entity_id'])
        stats = {}
        for entity_id, samples in by_entity.items():
            if not samples:
                # Empty entities may be a worker's unfinished enrollment.
                protected.add(entity_id)
                continue
            times = [row['time'] for row in samples]
            stats[entity_id] = {'frames': len({(row['media_id'], row['offset']) for row in samples}),
                'captures': len({row['capture_id'] for row in samples}), 'first': min(times), 'last': max(times)}
        weak = {e for e, value in stats.items() if e not in protected and
            (value['frames'] < policy.minimum_frames or value['last'] - value['first'] < policy.minimum_span_seconds)}
        survivors = set(entities) - weak
        budget_retire = set()
        if len(survivors) > policy.budget:
            optional = sorted(survivors - protected,
                key=lambda e: (min(stats[e]['captures'], 3), min(stats[e]['frames'], 32), stats[e]['last'], e))
            budget_retire.update(optional[:max(0, len(survivors) - policy.budget)])
        candidates = sorted(weak | budget_retire,
            key=lambda e: (e not in weak, stats[e]['last'], e))
        selected, selected_rows = [], 0
        for e in candidates:
            if len(selected) >= policy.retire_limit:
                break
            size = len(by_entity[e])
            if selected and selected_rows + size > policy.retire_sample_limit:
                continue
            selected.append(e)
            selected_rows += size
            if selected_rows >= policy.retire_sample_limit:
                break
        selected_set = set(selected)
        retired = []
        for entity_id in selected:
            samples = by_entity[entity_id]
            retired.append({'entity_id': entity_id, 'first_seen': _iso(stats[entity_id]['first']),
                'last_seen': _iso(stats[entity_id]['last']),
                'sample_rowid_max': max(row['rowid'] for row in samples)})
            db.execute("""UPDATE samples SET entity_id=NULL,
                data=json_set(data,'$._retention.retired_entity_id',?) WHERE entity_id=?""", (entity_id, entity_id))
            db.execute('DELETE FROM entities WHERE id=?', (entity_id,))
        # _rebuild still sees all metadata, so first/last timestamps, support and
        # capture witnesses remain exact. Only old, confirmed working vectors go.
        keep_vectors = set()
        for entity_id, samples in by_entity.items():
            if entity_id in selected_set:
                continue
            representatives = sorted((row for row in samples if row['has_vector']),
                key=lambda row: (row['started_at'], row['id']), reverse=True)[:8]
            keep_vectors.update(row['id'] for row in representatives)
        strip = [row for row in rows if row['has_vector'] and row['id'] not in keep_vectors
            and row['archived'] == 1 and not row['pending'] and not row['recent']]
        strip.sort(key=lambda row: (row['time'], row['rowid']))
        strip = strip[:policy.strip_limit]
        db.executemany("UPDATE samples SET data=json_remove(data,'$.embedding') WHERE id=?", [(row['id'],) for row in strip])
        if not retired and not strip:
            return None
        batch = {'version': 1, 'id': 'retention_' + uuid.uuid4().hex, 'created_at': _iso(current),
            'watermark': _iso(max((row['time'] for row in rows), default=current)),
            'sample_rowid_watermark': maximum_rowid, 'arrival_sample_rowid_cutoff': arrival_cutoff,
            'retired': retired, 'counts': {'entities_before': len(entities),
                'entities_after': len(entities) - len(retired), 'retired': len(retired),
                'weak_retired': len(selected_set & weak), 'budget_retired': len(selected_set & budget_retire),
                'retirement_candidates_remaining': len(candidates) - len(retired),
                'protected_entities': len(set(entities) & protected), 'target': policy.budget,
                'vectors_removed': len(strip), 'sample_rows_deleted': 0,
                'retired_sample_rows': selected_rows,
                'oversized_entity_retirements': sum(len(by_entity[e]) > policy.retire_sample_limit for e in selected)}}
        _set_config(db, PENDING_KEY, batch)
        return batch

"""Durable originals and their timeline, independent of the expiring live store.

An upload is acknowledged only after its exact bytes and SQLite index are durable.
A crash between file rename and DB commit can leave an orphan file; a retry with
the same capture/sequence and hash adopts it. Nothing is automatically deleted.
All wall-clock times are UTC; offsets are seconds from the original media start.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import threading
import uuid


MAX_CLIP_BYTES = 16_000_000
MAX_EVENT_BYTES = 256_000
IDENTIFIER = re.compile(r'^[a-zA-Z0-9_.:-]{1,160}$')


class ArchiveError(Exception):
    def __init__(self, code, status_code=409):
        super().__init__(code)
        self.code, self.status_code = code, status_code


def utc(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError as exc:
            raise ArchiveError('archive_invalid_timestamp', 422) from exc
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ArchiveError('archive_timestamp_requires_timezone', 422)
    return value.astimezone(timezone.utc)


def iso(value):
    return utc(value).isoformat(timespec='microseconds')


def now():
    return datetime.now(timezone.utc)


def micros(value):
    return round(utc(value).timestamp() * 1_000_000)


def identifier(value, field='identifier'):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ArchiveError('archive_invalid_' + field, 422)
    return value


def seconds(value, field='duration', allow_zero=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ArchiveError('archive_invalid_' + field, 422)
    value = float(value)
    if not math.isfinite(value) or (value < 0 if allow_zero else value <= 0):
        raise ArchiveError('archive_invalid_' + field, 422)
    return value


def dump(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (ValueError, TypeError):
        raise ArchiveError('archive_invalid_json', 422)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Archive:
    def __init__(self, db_path, media_root, reserve_bytes=100 * 1024**3):
        self.root = Path(media_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        if reserve_bytes < 0:
            raise ValueError('archive reserve must be nonnegative')
        self.reserve_bytes = reserve_bytes
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS archive_media(
            media_id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, clip_seq INTEGER NOT NULL,
            captured_at TEXT NOT NULL, start_us INTEGER NOT NULL, end_us INTEGER NOT NULL,
            duration_seconds REAL NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
            relative_path TEXT NOT NULL, metadata_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
            archived_at TEXT NOT NULL, UNIQUE(capture_id,clip_seq));
          CREATE INDEX IF NOT EXISTS archive_media_time ON archive_media(start_us,media_id);
          CREATE TABLE IF NOT EXISTS archive_packets(
            capture_id TEXT NOT NULL, seq INTEGER NOT NULL,
            media_id TEXT NOT NULL REFERENCES archive_media(media_id),
            start_offset_seconds REAL NOT NULL, end_offset_seconds REAL NOT NULL,
            PRIMARY KEY(capture_id,seq));
          CREATE TABLE IF NOT EXISTS archive_events(
            event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, capture_id TEXT,
            started_at TEXT NOT NULL, ended_at TEXT NOT NULL, start_us INTEGER NOT NULL,
            end_us INTEGER NOT NULL, model TEXT, body_json TEXT NOT NULL,
            refs_json TEXT NOT NULL, entities_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
            fingerprint TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS archive_events_time ON archive_events(start_us,event_id);
          CREATE INDEX IF NOT EXISTS archive_events_capture ON archive_events(capture_id,start_us);
          CREATE TABLE IF NOT EXISTS archive_event_entities(
            event_id TEXT NOT NULL REFERENCES archive_events(event_id), entity_id TEXT NOT NULL,
            PRIMARY KEY(event_id,entity_id));
          CREATE INDEX IF NOT EXISTS archive_entity_events ON archive_event_entities(entity_id,event_id);
        ''')
        self.db.commit()

    def _asset(self, row):
        if row is None:
            return None
        result = {k: row[k] for k in ('media_id', 'capture_id', 'clip_seq', 'captured_at',
                  'duration_seconds', 'sha256', 'size_bytes', 'archived_at')}
        result.update(metadata=json.loads(row['metadata_json']), receipt=json.loads(row['receipt_json']),
                      original_url='/v1/archive/media/' + row['media_id'] + '/original',
                      time_semantics='client_capture_wall_clock_plus_media_offset',
                      media_persisted=True)
        return result

    def get_clip(self, capture_id, clip_seq):
        with self.lock:
            return self._asset(self.db.execute('SELECT * FROM archive_media WHERE capture_id=? AND clip_seq=?',
                                              (capture_id, clip_seq)).fetchone())

    def get_media(self, media_id):
        with self.lock:
            return self._asset(self.db.execute('SELECT * FROM archive_media WHERE media_id=?', (media_id,)).fetchone())

    def ingest_feed(self, after=0, limit=100):
        """Append-order feed: historical phone replay cannot be missed by workers."""
        if type(after) is not int or after < 0 or not 1 <= limit <= 100:
            raise ArchiveError('archive_invalid_cursor', 422)
        with self.lock:
            rows = self.db.execute('SELECT rowid AS ingest_cursor,* FROM archive_media '
                'WHERE rowid>? ORDER BY rowid LIMIT ?', (after, limit + 1)).fetchall()
            items = [{**self._asset(row), 'ingest_cursor': row['ingest_cursor']} for row in rows[:limit]]
            return {'items': items, 'has_more': len(rows) > limit,
                    'next_cursor': items[-1]['ingest_cursor'] if items else after,
                    'order': 'durable_ingest_order_not_capture_time'}

    def media_path(self, media_id):
        with self.lock:
            row = self.db.execute('SELECT relative_path,size_bytes FROM archive_media WHERE media_id=?', (media_id,)).fetchone()
            if row is None:
                raise ArchiveError('archive_media_not_found', 404)
            path = (self.root / row[0]).resolve()
            if not path.is_relative_to(self.root) or not path.is_file():
                raise ArchiveError('archive_media_unavailable', 503)
            if path.stat().st_size != row['size_bytes']:
                raise ArchiveError('archive_media_size_mismatch', 503)
            return path

    def capture_state(self, capture_id):
        with self.lock:
            row = self.db.execute('SELECT MAX(clip_seq) FROM archive_media WHERE capture_id=?', (capture_id,)).fetchone()
            packet = self.db.execute('''SELECT p.seq,m.captured_at,p.start_offset_seconds
                FROM archive_packets p JOIN archive_media m USING(media_id)
                WHERE p.capture_id=? ORDER BY p.seq DESC LIMIT 1''', (capture_id,)).fetchone()
            return {'capture_id': capture_id, 'next_clip_seq': row[0] + 1 if row[0] is not None else 0,
                    'next_packet_seq': packet['seq'] + 1 if packet else 0,
                    'last_packet_captured_at': iso(utc(packet['captured_at']) + timedelta(seconds=packet['start_offset_seconds'])) if packet else None}

    def put_clip(self, path, capture_id, clip_seq, captured_at, duration_seconds,
                 metadata=None, packet_spans=None, receipt=None):
        identifier(capture_id, 'capture_id')
        if type(clip_seq) is not int or not 0 <= clip_seq <= 2147483647:
            raise ArchiveError('archive_invalid_clip_seq', 422)
        captured_at = iso(captured_at)
        duration = seconds(duration_seconds)
        if duration > 60:
            raise ArchiveError('archive_duration_too_long', 422)
        metadata, receipt = metadata or {}, receipt or {}
        if not isinstance(metadata, dict) or not isinstance(receipt, dict):
            raise ArchiveError('archive_invalid_metadata', 422)
        spans = []
        for span in packet_spans or []:
            seq = span.get('seq')
            if type(seq) is not int or seq < 0:
                raise ArchiveError('archive_invalid_packet_seq', 422)
            start = seconds(span.get('start_offset_seconds'), 'offset', allow_zero=True)
            end = seconds(span.get('end_offset_seconds'), 'offset')
            # AAC decoder padding can extend a packet slightly beyond the MOV's
            # nominal duration. Preserve that fact rather than invent timestamps.
            if end <= start or start >= duration or end > duration + .15:
                raise ArchiveError('archive_packet_outside_media', 422)
            spans.append((seq, start, end))
        if len({s[0] for s in spans}) != len(spans) or len(spans) > 128:
            raise ArchiveError('archive_invalid_packet_mapping', 422)
        metadata_json, receipt_json = dump(metadata), dump(receipt)
        if len(metadata_json.encode()) + len(receipt_json.encode()) > 64_000:
            raise ArchiveError('archive_metadata_too_large', 413)
        source = Path(path)
        size = source.stat().st_size
        if not 0 < size <= MAX_CLIP_BYTES:
            raise ArchiveError('archive_clip_size_out_of_range', 413)
        digest = hashlib.sha256()
        with source.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        sha = digest.hexdigest()
        media_id = 'media_' + hashlib.sha256((capture_id + ':' + str(clip_seq)).encode()).hexdigest()[:32]
        content_type = str(metadata.get('content_type', 'video/quicktime')).split(';', 1)[0].strip().lower()
        extensions = {'video/quicktime': '.mov', 'video/mp4': '.mp4', 'video/webm': '.webm'}
        if content_type not in extensions:
            raise ArchiveError('archive_unsupported_media_type', 422)
        relative = f'{captured_at[:10]}/{media_id}{extensions[content_type]}'
        final_path = self.root / relative
        with self.lock:
            previous = self.get_clip(capture_id, clip_seq)
            if previous:
                if previous['sha256'] != sha or previous['captured_at'] != captured_at:
                    raise ArchiveError('archive_clip_conflict')
                # Receiving an identical retry is safe even after a server restart.
                # Mapping/receipt are immutable; callers must reuse persisted state.
                self.media_path(previous['media_id'])
                return {**previous, 'duplicate': True}
            for seq, _, _ in spans:
                if self.db.execute('SELECT 1 FROM archive_packets WHERE capture_id=? AND seq=?', (capture_id, seq)).fetchone():
                    raise ArchiveError('archive_packet_mapping_conflict')
            available = shutil.disk_usage(self.root).free
            if available - size < self.reserve_bytes:
                raise ArchiveError('archive_disk_reserve_reached', 507)
            archived_at = iso(now())
            try:
                final_path.parent.mkdir(parents=True, exist_ok=True)
                if final_path.exists():
                    # An unindexed original may remain after an interrupted commit.
                    if final_path.stat().st_size != size or hashlib.sha256(final_path.read_bytes()).hexdigest() != sha:
                        raise ArchiveError('archive_orphan_file_conflict')
                else:
                    temporary = None
                    try:
                        with tempfile.NamedTemporaryFile(dir=final_path.parent, prefix='.upload-', delete=False) as target:
                            temporary = Path(target.name)
                            with source.open('rb') as stream:
                                shutil.copyfileobj(stream, target, 1024 * 1024)
                            target.flush()
                            os.fsync(target.fileno())
                        os.replace(temporary, final_path)
                        fsync_directory(final_path.parent)
                        fsync_directory(self.root)
                    finally:
                        if temporary is not None:
                            temporary.unlink(missing_ok=True)
                with self.db:
                    self.db.execute('INSERT INTO archive_media VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (media_id, capture_id, clip_seq, captured_at, micros(captured_at),
                         micros(captured_at) + round(duration * 1_000_000), duration, sha, size,
                         relative, metadata_json, receipt_json, archived_at))
                    self.db.executemany('INSERT INTO archive_packets VALUES (?,?,?,?,?)',
                                       [(capture_id, seq, media_id, start, end) for seq, start, end in spans])
                    self.record_event('capture_segment', {
                        'capture_id': capture_id, 'clip_seq': clip_seq, 'sha256': sha,
                        'size_bytes': size, 'duration_seconds': duration,
                        'clock_source': 'client_wall_clock_not_server_synchronized',
                        'time_semantics': 'original_media_interval_not_model_event_alignment'},
                        event_id='segment_' + media_id[6:], capture_id=capture_id,
                        started_at=captured_at, ended_at=utc(captured_at) + timedelta(seconds=duration),
                        media_refs=[{'media_id': media_id, 'start_offset_seconds': 0,
                                     'end_offset_seconds': duration, 'alignment': 'original_media_interval'}])
            except OSError as exc:
                raise ArchiveError('archive_disk_full' if exc.errno == errno.ENOSPC else 'archive_storage_unavailable',
                                   507 if exc.errno == errno.ENOSPC else 503) from exc
            except sqlite3.Error as exc:
                raise ArchiveError('archive_index_unavailable', 503) from exc
            return {**self.get_media(media_id), 'duplicate': False}

    def resolve_packets(self, capture_id, first_seq, last_seq):
        with self.lock:
            rows = self.db.execute('''SELECT p.*,m.duration_seconds,m.captured_at FROM archive_packets p
                JOIN archive_media m USING(media_id) WHERE p.capture_id=? AND p.seq BETWEEN ? AND ? ORDER BY p.seq''',
                                   (capture_id, first_seq, last_seq)).fetchall()
            result = []
            for row in rows:
                start, end = row['start_offset_seconds'], min(row['end_offset_seconds'], row['duration_seconds'])
                # Merge only contiguous offsets and sequences from the same asset.
                if (result and result[-1]['media_id'] == row['media_id']
                        and result[-1]['last_seq'] + 1 == row['seq']
                        and abs(result[-1]['end_offset_seconds'] - start) < 1e-6):
                    result[-1]['end_offset_seconds'] = end
                    result[-1]['decoded_end_offset_seconds'] = row['end_offset_seconds']
                    result[-1]['last_seq'] = row['seq']
                else:
                    result.append({'media_id': row['media_id'], 'capture_id': capture_id,
                        'start_offset_seconds': start, 'end_offset_seconds': end,
                        'decoded_end_offset_seconds': row['end_offset_seconds'],
                        'first_seq': row['seq'], 'last_seq': row['seq'],
                        'original_url': '/v1/archive/media/' + row['media_id'] + '/original',
                        'alignment': 'input_packet_interval_not_model_event_localization'})
            return result

    def resolve_interval(self, capture_id, started_at, ended_at):
        start, end = micros(started_at), micros(ended_at)
        with self.lock:
            rows = self.db.execute('''SELECT * FROM archive_media WHERE capture_id=? AND end_us>? AND start_us<?
                                    ORDER BY start_us''', (capture_id, start, end)).fetchall()
            return [{'media_id': row['media_id'], 'capture_id': capture_id,
                     'start_offset_seconds': max(0, (start - row['start_us']) / 1_000_000),
                     'end_offset_seconds': min(row['duration_seconds'], (end - row['start_us']) / 1_000_000),
                     'original_url': '/v1/archive/media/' + row['media_id'] + '/original',
                     'alignment': 'wall_clock_overlap_not_model_event_localization'} for row in rows]

    def record_event(self, kind, body, event_id=None, capture_id=None, started_at=None,
                     ended_at=None, model=None, entity_ids=None, media_refs=None, source_packets=None):
        identifier(kind, 'event_kind')
        event_id = identifier(event_id or 'event_' + uuid.uuid4().hex, 'event_id')
        if capture_id is not None:
            identifier(capture_id, 'capture_id')
        if not isinstance(body, dict):
            raise ArchiveError('archive_invalid_event_body', 422)
        body = dict(body)
        with self.lock:
            previous_time = self.db.execute('SELECT started_at FROM archive_events WHERE event_id=?', (event_id,)).fetchone()
        started_at = iso(started_at or body.get('context_from') or body.get('captured_at')
                         or body.get('detected_at') or body.get('received_at')
                         or (previous_time[0] if previous_time else now()))
        ended_at = iso(ended_at or body.get('context_to') or started_at)
        if micros(ended_at) < micros(started_at):
            raise ArchiveError('archive_event_time_reversed', 422)
        if model is not None and (not isinstance(model, str) or len(model) > 256):
            raise ArchiveError('archive_invalid_model', 422)
        entity_ids = sorted(set(identifier(value, 'entity_id') for value in (entity_ids or [])))
        if len(entity_ids) > 256:
            raise ArchiveError('archive_too_many_entities', 422)
        # Idempotency is about the submitted event. A retry must not re-resolve
        # previously missing source mappings and silently change its provenance.
        fingerprint = hashlib.sha256(dump([kind, capture_id, started_at, ended_at, model,
                                           body, media_refs, entity_ids, source_packets]).encode()).hexdigest()
        refs = []
        with self.lock:
            previous = self.db.execute('SELECT fingerprint FROM archive_events WHERE event_id=?', (event_id,)).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    raise ArchiveError('archive_event_conflict')
                return {'event_id': event_id, 'duplicate': True, 'persisted': True}
            # Preserve exact packet membership, including holes, instead of
            # claiming that every original between two wall-clock times was used.
            source_packets = source_packets if source_packets is not None else body.get('source_packets')
            if media_refs is None and source_packets is not None:
                requested = set()
                for packet in source_packets:
                    source_capture = identifier(packet.get('capture_id'), 'capture_id')
                    seq = packet.get('seq')
                    if type(seq) is not int or seq < 0:
                        raise ArchiveError('archive_invalid_packet_seq', 422)
                    requested.add((source_capture, seq))
                if len(requested) > 4096:
                    raise ArchiveError('archive_too_many_source_packets', 413)
                media_refs = []
                mapped = 0
                for source_capture, seq in sorted(requested):
                    packet_refs = self.resolve_packets(source_capture, seq, seq)
                    mapped += bool(packet_refs)
                    for ref in packet_refs:
                        previous = media_refs[-1] if media_refs else None
                        if (previous and previous['media_id'] == ref['media_id']
                                and previous['last_seq'] + 1 == ref['first_seq']
                                and abs(previous['end_offset_seconds'] - ref['start_offset_seconds']) < 1e-6):
                            previous.update(end_offset_seconds=ref['end_offset_seconds'],
                                decoded_end_offset_seconds=ref['decoded_end_offset_seconds'], last_seq=ref['last_seq'])
                        else:
                            media_refs.append(ref)
                body['archive_coverage'] = {'requested_packets': len(requested), 'mapped_packets': mapped,
                                            'complete': bool(requested) and mapped == len(requested)}
            for supplied in media_refs or []:
                ref = dict(supplied)
                asset = self.get_media(ref.get('media_id'))
                if asset is None:
                    raise ArchiveError('archive_reference_media_not_found', 422)
                start = seconds(ref.get('start_offset_seconds', 0), 'offset', allow_zero=True)
                end = seconds(ref.get('end_offset_seconds', asset['duration_seconds']), 'offset', allow_zero=True)
                if start > end or end > asset['duration_seconds'] + 1e-6:
                    raise ArchiveError('archive_reference_outside_media', 422)
                if capture_id is not None and capture_id != asset['capture_id']:
                    raise ArchiveError('archive_reference_capture_mismatch', 422)
                ref.update(start_offset_seconds=start, end_offset_seconds=end,
                           capture_id=asset['capture_id'], original_url=asset['original_url'])
                refs.append(ref)
            body_json, refs_json, entities_json = dump(body), dump(refs), dump(entity_ids)
            if sum(len(v.encode()) for v in (body_json, refs_json, entities_json)) > MAX_EVENT_BYTES:
                raise ArchiveError('archive_event_too_large', 413)
            with self.db:
                self.db.execute('INSERT INTO archive_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (event_id, kind, capture_id, started_at, ended_at, micros(started_at), micros(ended_at), model,
                     body_json, refs_json, entities_json, iso(now()), fingerprint))
                self.db.executemany('INSERT INTO archive_event_entities VALUES (?,?)', [(event_id, value) for value in entity_ids])
            return {'event_id': event_id, 'duplicate': False, 'persisted': True}

    def _event(self, row):
        return {**{k: row[k] for k in ('event_id', 'kind', 'capture_id', 'started_at', 'ended_at', 'model', 'recorded_at')},
                'body': json.loads(row['body_json']), 'media_refs': json.loads(row['refs_json']),
                'entity_ids': json.loads(row['entities_json'])}

    def get_event(self, event_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM archive_events WHERE event_id=?', (event_id,)).fetchone()
            return self._event(row) if row else None

    def timeline(self, capture_id=None, started_at=None, ended_at=None, kind=None,
                 entity_id=None, text=None, after=None, limit=100):
        if not 1 <= limit <= 100:
            raise ArchiveError('archive_invalid_limit', 422)
        clauses, values = [], []
        for field, value in (('capture_id', capture_id), ('kind', kind)):
            if value is not None:
                clauses.append('e.' + field + '=?')
                values.append(value)
        if started_at is not None:
            clauses.append('e.end_us>=?')
            values.append(micros(started_at))
        if ended_at is not None:
            clauses.append('e.start_us<=?')
            values.append(micros(ended_at))
        if entity_id is not None:
            clauses.append('EXISTS(SELECT 1 FROM archive_event_entities x WHERE x.event_id=e.event_id AND x.entity_id=?)')
            values.append(entity_id)
        if text:
            clauses.append('instr(lower(e.body_json),lower(?))>0')
            values.append(text)
        with self.lock:
            if after is not None:
                cursor = self.db.execute('SELECT start_us,event_id FROM archive_events WHERE event_id=?', (after,)).fetchone()
                if cursor is None:
                    raise ArchiveError('archive_cursor_not_found', 422)
                clauses.append('(e.start_us>? OR (e.start_us=? AND e.event_id>?))')
                values.extend((cursor[0], cursor[0], cursor[1]))
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            rows = self.db.execute('SELECT e.* FROM archive_events e' + where + ' ORDER BY e.start_us,e.event_id LIMIT ?',
                                   (*values, limit + 1)).fetchall()
            return {'items': [self._event(row) for row in rows[:limit]], 'has_more': len(rows) > limit,
                    'next_cursor': rows[min(len(rows), limit) - 1]['event_id'] if rows else after,
                    'retention': 'indefinite_no_automatic_deletion'}

    def list_media(self, capture_id=None, started_at=None, ended_at=None, after=None, limit=100):
        if not 1 <= limit <= 100:
            raise ArchiveError('archive_invalid_limit', 422)
        clauses, values = [], []
        if capture_id is not None:
            clauses.append('capture_id=?')
            values.append(capture_id)
        if started_at is not None:
            clauses.append('end_us>=?')
            values.append(micros(started_at))
        if ended_at is not None:
            clauses.append('start_us<=?')
            values.append(micros(ended_at))
        with self.lock:
            if after is not None:
                cursor = self.db.execute('SELECT start_us,media_id FROM archive_media WHERE media_id=?', (after,)).fetchone()
                if cursor is None:
                    raise ArchiveError('archive_cursor_not_found', 422)
                clauses.append('(start_us>? OR (start_us=? AND media_id>?))')
                values.extend((cursor[0], cursor[0], cursor[1]))
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            rows = self.db.execute('SELECT * FROM archive_media' + where + ' ORDER BY start_us,media_id LIMIT ?',
                                   (*values, limit + 1)).fetchall()
            return {'items': [self._asset(row) for row in rows[:limit]], 'has_more': len(rows) > limit,
                    'next_cursor': rows[min(len(rows), limit) - 1]['media_id'] if rows else after}

    def status(self):
        with self.lock:
            row = self.db.execute('SELECT COUNT(*),COALESCE(SUM(size_bytes),0),MAX(archived_at) FROM archive_media').fetchone()
            event_count = self.db.execute('SELECT COUNT(*) FROM archive_events').fetchone()[0]
        free = shutil.disk_usage(self.root).free
        return {'enabled': True, 'media_count': row[0], 'stored_bytes': row[1], 'last_archived_at': row[2],
                'event_count': event_count, 'free_bytes': free, 'reserve_bytes': self.reserve_bytes,
                'accepting_media': free > self.reserve_bytes + MAX_CLIP_BYTES,
                'retention': 'indefinite_no_automatic_deletion',
                'clock_source': 'client_wall_clock_not_server_synchronized',
                'capture_transport': 'successive_movie_segments_with_possible_capture_gaps'}

    def close(self):
        with self.lock:
            self.db.close()

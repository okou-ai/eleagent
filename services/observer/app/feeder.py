"""MiniCPM reads from the archive, not from the upload request.

Every archived clip gets observed, however late it was uploaded. The archive's append-order feed is tailed
into a durable pending table (local SQLite, survives restarts); the next clip is decoded and handed to the
window loop only when the loop has nothing queued, so MiniCPM never runs more than one clip ahead.

Order: the capture with the newest pending clip first (the one being recorded), oldest clip first within a
capture (working memory needs time order); older captures' backlog uses the remaining capacity.
A clip already handed to the window loop is not replayed after a restart (at most one window is lost).
"""
import asyncio
import base64
import contextlib
import logging
import sqlite3
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import HTTPException

from .mobile import decode_clip
from .protocol import Packet
from .night_pause import NightPause

POLL_SECONDS = 1
LIVE_ARRIVAL_SECONDS = 120
SKIP_CAPTURE_PREFIXES = ('archive-probe',)
log = logging.getLogger(__name__)


class ArchiveFeeder:
    def __init__(self, service, url, path):
        self.service = service
        self.night_pause = NightPause('minicpm')
        self.client = httpx.AsyncClient(base_url=url.rstrip('/'), trust_env=False,
            timeout=httpx.Timeout(30, connect=3))
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS feed_cursor (id INTEGER PRIMARY KEY CHECK (id = 0), cursor INTEGER NOT NULL)')
        self.db.execute('''CREATE TABLE IF NOT EXISTS pending (media_id TEXT PRIMARY KEY, capture_id TEXT NOT NULL,
            clip_seq INTEGER NOT NULL, captured_at TEXT NOT NULL, duration REAL NOT NULL, archived_at TEXT NOT NULL)''')
        self.db.commit()
        self.next_seq = {}   # capture_id -> next packet seq (window-loop numbering only)
        self.spans = {}      # (capture_id, seq) -> (media_id, start_offset, end_offset)
        self.fed = self.failed = 0
        self.last_error = None
        self.last_poll_at = time.time()  # wall clock of the last complete feed poll
        self.task = None

    def start(self):
        from . import metrics
        metrics.register_gauges(lambda: [
            ('scene_minicpm_backlog_seconds', 'Archived media not yet observed by MiniCPM', ['service'],
             [((metrics.SERVICE,), self.backlog_seconds())]),
            ('scene_minicpm_backlog_clips', 'Archived clips not yet observed by MiniCPM', ['service'],
             [((metrics.SERVICE,), self.pending_count())]),
            # The backlog only counts clips already pulled from the feed; these two show whether pulling still runs.
            ('scene_minicpm_feeder_running', 'MiniCPM archive feeder loop is alive (1) or stopped (0)', ['service'],
             [((metrics.SERVICE,), 1 if self.task and not self.task.done() else 0)]),
            ('scene_minicpm_feed_poll_age_seconds', 'Seconds since the feeder last read the archive feed', ['service'],
             [((metrics.SERVICE,), time.time() - self.last_poll_at)])])
        self.task = asyncio.create_task(self.run())
        self.task.add_done_callback(self.stopped)

    def stopped(self, task):
        if not task.cancelled() and task.exception():
            log.error('MiniCPM archive feeder stopped', exc_info=task.exception())

    async def close(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(BaseException):
                await self.task
        await self.client.aclose()

    def backlog_seconds(self):
        return self.db.execute('SELECT COALESCE(SUM(duration), 0) FROM pending').fetchone()[0]

    def live_backlog_seconds(self):
        # Only media still arriving (archived in the last 2 min) has to be caught up quickly; an old backlog is
        # observed with the normal output budget on the capacity left over.
        since = (datetime.now(timezone.utc) - timedelta(seconds=LIVE_ARRIVAL_SECONDS)).isoformat()
        return self.db.execute('SELECT COALESCE(SUM(duration), 0) FROM pending WHERE archived_at >= ?', (since,)).fetchone()[0]

    def pending_count(self):
        return self.db.execute('SELECT COUNT(*) FROM pending').fetchone()[0]

    async def feed_page(self, after):
        response = await self.client.get('/v1/archive/feed', params={'after': after, 'limit': 100})
        response.raise_for_status()
        return response.json()

    async def poll(self):
        row = self.db.execute('SELECT cursor FROM feed_cursor WHERE id = 0').fetchone()
        # A fresh worker must include clips uploaded before it finished starting.
        # Existing workers retain their durable cursor and pending work on restart.
        cursor = row[0] if row is not None else 0
        while True:
            page = await self.feed_page(cursor)
            items = [item for item in page['items'] if not item['capture_id'].startswith(SKIP_CAPTURE_PREFIXES)]
            with self.db:
                self.db.executemany('INSERT OR IGNORE INTO pending VALUES (?,?,?,?,?,?)', [
                    (item['media_id'], item['capture_id'], item['clip_seq'], item['captured_at'],
                     float(item['duration_seconds']), item['archived_at']) for item in items])
                self.db.execute('INSERT INTO feed_cursor VALUES (0, ?) '
                    'ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor', (page['next_cursor'],))
            if self.service.situation:
                for item in items:
                    # Arrival rate of new media sets the output budget (keep up with what is being recorded).
                    self.service.situation.budget.arrived(float(item['duration_seconds']))
            cursor = page['next_cursor']
            if not page['has_more']:
                self.last_poll_at = time.time()
                return

    def next_clip(self):
        row = self.db.execute('SELECT capture_id FROM pending ORDER BY captured_at DESC LIMIT 1').fetchone()
        if row is None:
            return None
        return self.db.execute('SELECT media_id, capture_id, clip_seq, captured_at, duration FROM pending WHERE capture_id = ? '
                               'ORDER BY clip_seq LIMIT 1', (row[0],)).fetchone()

    async def decode(self, media_id):
        with tempfile.TemporaryDirectory(prefix='scene-feed-') as directory:
            path = Path(directory) / 'input.mov'
            async with self.client.stream('GET', f'/v1/archive/media/{media_id}/original') as response:
                response.raise_for_status()
                with path.open('wb') as target:
                    async for chunk in response.aiter_bytes(1 << 20):
                        target.write(chunk)
            return await decode_clip(path)

    def packets(self, media_id, capture_id, captured_at, duration, pcm, frames):
        last = self.service.receipts.last(capture_id)
        seq = max(self.next_seq.get(capture_id, 0), last[0] + 1 if last else 0)
        count = max(1, len(pcm) // 64_000)
        packets = []
        for index in range(count):
            offset = index * 64_000
            end = len(pcm) if index == count - 1 else offset + 64_000
            packets.append(Packet(capture_id=capture_id, seq=seq + index,
                captured_at=captured_at + timedelta(seconds=offset / 64_000),
                input={'audio': base64.b64encode(pcm[offset:end]).decode(),
                       'video_frames': [base64.b64encode(frame).decode() for frame in
                                        frames[index:(None if index == count - 1 else index + 1)]]}))
            # Decoded AAC can run a few ms past the container duration; references stay inside the clip.
            self.spans[(capture_id, seq + index)] = (media_id, min(offset / 64_000, duration), min(end / 64_000, duration))
        self.next_seq[capture_id] = seq + count
        while len(self.spans) > 4096:
            self.spans.pop(next(iter(self.spans)))
        return packets

    def media_refs(self, source_packets):
        """Exact original-media coverage of a window, for the archive event."""
        refs = []
        for packet in source_packets or []:
            span = self.spans.get((packet.get('capture_id'), packet.get('seq')))
            if span is None:
                return None
            media_id, start, end = span
            if refs and refs[-1]['media_id'] == media_id and abs(refs[-1]['end_offset_seconds'] - start) < 1e-6:
                refs[-1]['end_offset_seconds'] = end
            else:
                refs.append({'media_id': media_id, 'start_offset_seconds': start, 'end_offset_seconds': end})
        return refs or None

    async def feed_one(self, media_id, capture_id, clip_seq, captured_at, duration):
        try:
            try:
                pcm, frames = await self.decode(media_id)
            except httpx.HTTPStatusError as exc:
                if not 400 <= exc.response.status_code < 500:
                    raise
                raise ValueError(f'archive_media_{exc.response.status_code}')
            at = datetime.fromisoformat(captured_at)
            for packet in self.packets(media_id, capture_id, at, duration, pcm, frames):
                self.service.accept(packet)
            self.fed += 1
        except httpx.HTTPError:
            raise  # Archive unreachable or 5xx: the clip stays pending and run() retries it.
        except Exception as exc:
            # Undecodable, too short or out-of-order clip: it stays archive-only. Any other error skips only this
            # clip as well, so one bad clip can never stop the feeder.
            self.failed += 1
            if isinstance(exc, HTTPException) and isinstance(exc.detail, dict):
                code = exc.detail.get('code', 'decode_failed')
            elif isinstance(exc, (HTTPException, ValueError)):
                code = str(exc)
            else:
                code = 'unexpected_' + type(exc).__name__
                log.exception('MiniCPM feeder skipped %s after an unexpected error', media_id)
            try:
                # gap(reason, ...) owns 'reason'; the skip cause goes in 'detail'.
                self.service.gap('minicpm_clip_skipped', capture_id=capture_id, clip_seq=clip_seq, media_id=media_id,
                                 detail=code[:80], captured_at=captured_at)
            except Exception:
                log.exception('MiniCPM feeder could not record the skipped clip %s', media_id)
        with self.db:
            self.db.execute('DELETE FROM pending WHERE media_id = ?', (media_id,))

    async def run(self):
        last_poll = 0
        while True:
            try:
                if time.monotonic() - last_poll >= POLL_SECONDS:
                    await self.poll()
                    last_poll = time.monotonic()
                # Uploads and archive polling continue during the GPU handoff. No pending
                # clip is taken until the lease is released; an already-fed clip drains.
                idle = (self.service.state == 'idle' and self.service.queue.empty()
                        and self.service.window_buffered_packets == 0)
                if self.night_pause.paused(idle=idle):
                    await asyncio.sleep(0.2)
                    continue
                clip = self.next_clip() if self.service.queue.empty() else None
                if clip:
                    await self.feed_one(*clip)
                    continue
                self.last_error = None
            except (httpx.HTTPError, sqlite3.Error) as exc:
                self.last_error = type(exc).__name__
                await asyncio.sleep(5)
            except Exception as exc:
                # Never let an unexpected error end the loop silently: log it and keep tailing the feed.
                self.last_error = type(exc).__name__
                log.exception('MiniCPM feeder loop error')
                await asyncio.sleep(5)
            await asyncio.sleep(0.2)

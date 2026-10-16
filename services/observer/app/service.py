from collections import OrderedDict
import asyncio
import contextlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from .backend import MockMiniCPM, RealtimeMiniCPM, WindowedMiniCPM, error_details, protocol_error
from .protocol import TurnAssembler, PIN
from .mobile import MobileIngest
from .archive_client import RemoteArchive
from .situation import Situation
from .feeder import ArchiveFeeder
from pathlib import Path

def iso_now():
    return datetime.now(timezone.utc).isoformat()

@dataclass
class BufferedPacket:
    packet: object
    received_monotonic: float

class Receipts:
    """Last packet sequence and capture time per capture, kept in memory (the archive holds the durable
    `next_packet_seq` per capture, restored when a capture is first seen after a restart)."""
    def __init__(self, keep=64):
        self.items, self.keep = OrderedDict(), keep

    def last(self, capture_id):
        return self.items.get(capture_id)

    def record(self, packet):
        self.items[packet.capture_id] = (packet.seq, packet.captured_at.isoformat())
        self.items.move_to_end(packet.capture_id)
        while len(self.items) > self.keep:
            self.items.popitem(last=False)


class SceneService:
    def __init__(self, settings, backend_factory=None):
        self.settings = settings
        self.receipts = Receipts()
        self.archive = (RemoteArchive(settings.archive_url, settings.archive_token,
            str(Path(settings.db_path).with_name('archive-outbox.sqlite3'))) if settings.archive_url else None)
        adapter = WindowedMiniCPM if settings.backend == 'windowed' else RealtimeMiniCPM
        adapter_options = ({'max_new_tokens': settings.max_new_tokens,
                            'compact_observation': settings.compact_observation}
                           if settings.backend == 'windowed' else {})
        self.factory = backend_factory or (MockMiniCPM if settings.backend == 'mock' else lambda: adapter(
            settings.minicpm_url, settings.upstream_start_timeout, self.upstream_progress, settings.minicpm_proxy,
            **adapter_options))
        self.queue = asyncio.Queue(maxsize=settings.queue_size)
        self.activity = asyncio.Event()
        self.clients = 0
        self.mobile = MobileIngest(self)
        self.latest_path = Path(settings.db_path).with_name('latest-observation.json')
        self.latest_observation = self.load_latest()
        self.state = 'idle'
        self.backend_phase = 'idle'
        self.backend_error = None
        self.sessions_started = 0
        self.session_started_at = None
        self.last_backend_input_at = None
        self.last_received_at = None
        self.received_audio_seconds = self.received_media_bytes = self.received_video_frames = 0
        self.sent_audio_seconds = self.sent_media_bytes = self.sent_video_frames = 0
        self.last_received = self.last_processed = self.last_output = None
        self.last_model_listen_at = None
        self.last_model_activity_context_to = None
        self.output_context = None
        self.window_buffered_packets = 0
        self.window_buffered_audio_seconds = 0
        self.windows_sent = self.windows_completed = self.empty_windows = 0
        self.accepted = self.duplicates = self.dropped = self.processed = 0
        self.gaps = []
        self.history = []
        self.tasks = []
        self.epoch = None
        self.context_from = self.context_to = None
        self.frames = 0
        self.assembler = TurnAssembler()
        self.situation = Situation.from_env(settings) if settings.backend == 'windowed' and settings.archive_url else None
        self.feeder = (ArchiveFeeder(self, settings.archive_url, settings.archive_token,
            str(Path(settings.db_path).with_name('minicpm-feed.sqlite3'))) if settings.archive_url else None)

    async def start(self):
        self.tasks = [asyncio.create_task(self.perception_loop())]
        if self.situation:
            self.situation.start()
        if self.feeder:
            self.feeder.start()
        if self.archive:
            self.tasks.append(asyncio.create_task(self.archive.run()))

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.feeder:
            await self.feeder.close()
        if self.situation:
            await self.situation.close()
        if self.archive:
            await self.archive.close()

    def gap(self, reason, **metadata):
        from . import metrics
        metrics.event('pipeline_gap', reason)
        body = {'reason': reason, 'detected_at': iso_now(), **metadata}
        self.gaps.append(body)
        self.gaps = self.gaps[-100:]
        if self.archive:
            self.archive.enqueue('pipeline_gap', body, capture_id=metadata.get('capture_id'),
                started_at=metadata.get('captured_at') or metadata.get('context_from') or body['detected_at'],
                ended_at=metadata.get('context_to') or metadata.get('captured_at') or body['detected_at'])

    def upstream_progress(self, phase):
        self.backend_phase = phase

    def discard(self, item, reason):
        self.dropped += 1
        packet = item.packet
        self.gap(reason, capture_id=packet.capture_id, seq=packet.seq,
                 captured_at=packet.captured_at.isoformat())

    def purge_stale(self):
        fresh = []
        while not self.queue.empty():
            item = self.queue.get_nowait()
            self.queue.task_done()
            if time.monotonic() - item.received_monotonic > self.settings.max_packet_age_seconds:
                self.discard(item, 'media_expired_before_inference')
            else:
                fresh.append(item)
        for item in fresh:
            self.queue.put_nowait(item)

    def accept(self, packet):
        last = self.receipts.last(packet.capture_id)
        if last and packet.seq <= last[0]:
            self.duplicates += 1
            return {'type': 'ack', 'seq': packet.seq, 'status': 'duplicate_or_stale'}
        if last and packet.captured_at < datetime.fromisoformat(last[1]):
            raise ValueError('capture timestamps must not move backwards within capture_id')
        self.purge_stale()
        if self.queue.full():
            # A live stream keeps its newest media; queued acks never promise inference.
            old = self.queue.get_nowait()
            self.queue.task_done()
            self.discard(old, 'queue_full_oldest_dropped')
        if last and packet.seq > last[0] + 1:
            self.gap('sequence_gap', capture_id=packet.capture_id, from_seq=last[0] + 1, to_seq=packet.seq - 1)
        if last:
            old = datetime.fromisoformat(last[1])
            if (packet.captured_at - old).total_seconds() > 3:
                self.gap('capture_time_gap', capture_id=packet.capture_id,
                         previous_at=last[1], current_at=packet.captured_at.isoformat())
        self.receipts.record(packet)
        if self.situation:
            self.situation.seen(packet.capture_id, packet.captured_at)
        self.queue.put_nowait(BufferedPacket(packet, time.monotonic()))
        self.activity.set()
        self.accepted += 1
        self.last_received = packet.captured_at.isoformat()
        self.last_received_at = iso_now()
        self.received_audio_seconds += packet.duration
        self.received_media_bytes += packet.media_bytes
        self.received_video_frames += len(packet.input.get('video_frames', []))
        # A queued ack is not durable media storage or successful inference.
        return {'type': 'ack', 'seq': packet.seq, 'status': 'queued', 'media_persisted': False}

    def save_turn(self, turn):
        body = {'id': 'obs_' + uuid.uuid4().hex, 'source_mode': self.settings.backend,
                'synthetic': self.settings.backend == 'mock', 'model': 'MiniCPM-o-4.5',
                'protocol_revision': PIN, 'model_session': self.epoch,
                'received_at': iso_now(), 'context_from': self.context_from, 'context_to': self.context_to,
                'time_semantics': 'input_context_range_not_exact_event_alignment',
                'visual': None, 'speech': None, 'sounds': None,
                'structured_modalities_available': False, **turn}
        if self.output_context:
            body.update(self.output_context)
        sent = body.pop('sent_monotonic', None)
        meta = body.get('situation_meta')
        if self.situation and meta:
            seconds = time.monotonic() - sent if sent else None
            meta['inference_seconds'] = round(seconds, 3) if seconds else None
            sources = body.get('source_packets') or [{}]
            try:
                at = datetime.fromisoformat(body.get('context_from'))
            except (TypeError, ValueError):
                at = datetime.now(timezone.utc)
            body['situation'] = self.situation.record(sources[0].get('capture_id'), at,
                                                      body.get('generated_text', ''), meta, seconds)
        if self.archive:
            sources = body.get('source_packets', [])
            captures = {p['capture_id'] for p in sources}
            refs = self.feeder.media_refs(sources) if self.feeder else None
            if body.get('context_to'):
                # How long after capture the observation was made (late uploads are still observed).
                body['observed_lag_seconds'] = round((datetime.now(timezone.utc) - datetime.fromisoformat(body['context_to'])).total_seconds(), 1)
            self.archive.enqueue('minicpm', body, capture_id=next(iter(captures)) if len(captures) == 1 else None,
                started_at=body.get('context_from'), ended_at=body.get('context_to'), model=body['model'],
                **({'media_refs': refs} if refs else {}))
        self.last_output = body['received_at']
        self.last_processed = body['context_to']
        self.record_latest(body)

    def load_latest(self):
        try:
            return json.loads(self.latest_path.read_text())
        except (OSError, ValueError):
            return None

    def record_latest(self, body):
        """Keep the newest observation for the capture page; it survives restarts and the nightly GPU handoff."""
        text = (body.get('generated_text') or '').strip()
        if not text:
            return
        self.latest_observation = {'id': body['id'], 'text': text[:2000], 'captured_from': body.get('context_from'),
                                   'captured_to': body.get('context_to'), 'observed_at': body['received_at']}
        temporary = self.latest_path.with_suffix('.tmp')
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as output:
                json.dump(self.latest_observation, output)
            os.replace(temporary, self.latest_path)
        except OSError:
            pass  # Display state only; perception must not fail because it could not be saved.

    async def receive(self, backend):
        while True:
            event = await backend.pull()
            kind = event.get('kind')
            # Do not persist provider error messages, media echoes or arbitrary fields.
            safe = {k: v for k, v in event.items() if k in ('type', 'kind', 'response_id', 'session_id')}
            if event.get('type') in ('error', 'session.closed'):
                safe.update(protocol_error(event, 'streaming').details)
            self.history.append(safe)
            self.history = self.history[-12:]
            if event.get('_source_context'):
                self.output_context = event['_source_context']
            turns = self.assembler.consume(event)
            for turn in turns:
                self.save_turn(turn)
            if event.get('type') == 'response.done':
                self.windows_completed += 1
                if not turns:
                    self.empty_windows += 1
                    self.gap('window_returned_no_text', window_id=(self.output_context or {}).get('window_id'))
            if event.get('type') == 'response.output.delta' and kind == 'listen':
                self.last_model_listen_at = iso_now()
            if event.get('type') == 'response.output.delta':
                self.last_model_activity_context_to = self.context_to
            if event.get('type') == 'session.closed':
                raise protocol_error(event, 'streaming')
            if event.get('type') == 'error':
                raise protocol_error(event, 'streaming')

    async def send(self, backend, rotation_deadline=None):
        if self.settings.backend == 'windowed':
            return await self.send_windows(backend, rotation_deadline)
        while True:
            try:
                item = await asyncio.wait_for(self.queue.get(), timeout=self.settings.idle_seconds)
            except TimeoutError:
                return
            packet = item.packet
            try:
                if time.monotonic() - item.received_monotonic > self.settings.max_packet_age_seconds:
                    self.discard(item, 'media_expired_before_inference')
                    continue
                async with asyncio.timeout(15):
                    await backend.push(packet)
                if self.context_from is None:
                    self.context_from = packet.captured_at.isoformat()
                self.context_to = (packet.captured_at + timedelta(seconds=packet.duration)).isoformat()
                self.processed += 1
                self.frames += 1
                self.last_backend_input_at = iso_now()
                self.sent_audio_seconds += packet.duration
                self.sent_media_bytes += packet.media_bytes
                self.sent_video_frames += len(packet.input.get('video_frames', []))
                # V2 doesn't acknowledge a specific input seq as successfully inferred.
            except BaseException:
                self.gap('upstream_send_unconfirmed', capture_id=packet.capture_id, seq=packet.seq)
                raise
            finally:
                self.queue.task_done()

    def count_sent(self, packet):
        self.processed += 1
        self.sent_audio_seconds += packet.duration
        self.sent_media_bytes += packet.media_bytes
        self.sent_video_frames += len(packet.input.get('video_frames', []))
        self.last_backend_input_at = iso_now()

    async def send_windows(self, backend, rotation_deadline=None):
        """One model request at a time; keep later ingress in the bounded queue."""
        pending = []
        carry = None
        try:
            while True:
                await backend.wait_ready()
                # Chat windows are independent. Rotate only after the previous
                # response is fully consumed, before taking more queued media.
                # A carry packet belongs to an already-started capture boundary;
                # finish it first rather than throwing it away on rotation.
                if rotation_deadline is not None and time.monotonic() >= rotation_deadline and carry is None:
                    self.state = self.backend_phase = 'rotating'
                    self.gap('planned_model_session_rotation', boundary='completed_window')
                    return
                duration = 0
                while duration < self.settings.window_seconds and len(pending) < 8:
                    try:
                        if carry:
                            item, carry = carry, None
                        else:
                            timeout = self.settings.window_flush_seconds if pending else self.settings.idle_seconds
                            item = await asyncio.wait_for(self.queue.get(), timeout=timeout)
                    except TimeoutError:
                        if not pending:
                            return
                        break  # Submit the short final window when capture pauses/stops.
                    if time.monotonic() - item.received_monotonic > self.settings.max_packet_age_seconds:
                        self.discard(item, 'media_expired_before_inference')
                        self.queue.task_done()
                        continue
                    if pending and item.packet.capture_id != pending[0].packet.capture_id:
                        carry = item
                        break
                    pending.append(item)
                    duration += item.packet.duration
                    self.window_buffered_packets = len(pending)
                    self.window_buffered_audio_seconds = round(duration, 3)
                fresh = []
                for item in pending:
                    if time.monotonic() - item.received_monotonic > self.settings.max_packet_age_seconds:
                        self.discard(item, 'media_expired_before_inference')
                        self.queue.task_done()
                    else:
                        fresh.append(item)
                pending = fresh
                if not pending:
                    self.window_buffered_packets = self.window_buffered_audio_seconds = 0
                    continue
                self.window_buffered_packets = len(pending)
                self.window_buffered_audio_seconds = round(sum(item.packet.duration for item in pending), 3)
                try:
                    packets = [item.packet for item in pending]
                    options = {}
                    if self.situation:
                        media = sum(p.duration for p in packets)
                        # Media already waiting beyond the next window is the backlog to drain.
                        queued = sum(item.packet.duration for item in list(self.queue._queue))
                        backlog = max(0.0, queued - self.settings.window_seconds) + (self.feeder.live_backlog_seconds() if self.feeder else 0)
                        prompt, tokens, meta = self.situation.build(packets[0].capture_id, packets[0].captured_at,
                                                                    media, backlog)
                        options = {'prompt': prompt, 'max_new_tokens': tokens, 'meta': meta}
                    async with asyncio.timeout(15):
                        context = await backend.push_window(packets, **options)
                    self.context_from, self.context_to = context['context_from'], context['context_to']
                    self.windows_sent += 1
                    for item in pending:
                        self.count_sent(item.packet)
                except BaseException:
                    self.gap('upstream_window_send_unconfirmed',
                             capture_id=pending[0].packet.capture_id,
                             from_seq=pending[0].packet.seq, to_seq=pending[-1].packet.seq)
                    raise
                finally:
                    for _ in pending:
                        self.queue.task_done()
                    pending = []
                    self.window_buffered_packets = self.window_buffered_audio_seconds = 0
        finally:
            for item in pending + ([carry] if carry else []):
                self.discard(item, 'partial_window_interrupted')
                self.queue.task_done()
            self.window_buffered_packets = self.window_buffered_audio_seconds = 0

    async def perception_loop(self):
        delay = 0.2
        while True:
            self.purge_stale()
            if self.queue.empty():
                self.state = self.backend_phase = 'idle'
                self.activity.clear()
                await self.activity.wait()
                continue
            backend = self.factory()
            send_task = receive_task = None
            self.context_from = self.context_to = None
            self.output_context = None
            self.assembler = TurnAssembler()
            self.epoch = uuid.uuid4().hex
            try:
                self.state = 'connecting'
                self.backend_phase = 'connect'
                await backend.start()
                self.state = 'ready'
                self.backend_phase = 'streaming'
                self.backend_error = None
                self.sessions_started += 1
                self.session_started_at = iso_now()
                delay = 0.2
                rotation_deadline = time.monotonic() + self.settings.session_seconds
                send_task = asyncio.create_task(self.send(backend, rotation_deadline))
                receive_task = asyncio.create_task(self.receive(backend))
                # Model sessions remain bounded even if the upstream removes its cap.
                # Windowed mode gets a bounded grace period to finish its current
                # request; send_windows normally exits at response.done instead.
                guard_seconds = self.settings.session_seconds + (60 if self.settings.backend == 'windowed' else 0)
                done, _ = await asyncio.wait({send_task, receive_task},
                    timeout=guard_seconds, return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    self.state = self.backend_phase = 'rotating'
                    self.gap('model_session_rotation_guard_timeout' if self.settings.backend == 'windowed'
                             else 'planned_model_session_rotation')
                else:
                    for task in done:
                        task.result()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.state = 'reconnecting'
                self.backend_error = {**error_details(exc, self.backend_phase), 'at': iso_now()}
                self.gap('backend_reconnect', **self.backend_error)
            finally:
                for task in (send_task, receive_task):
                    if task:
                        task.cancel()
                await asyncio.gather(*(t for t in (send_task, receive_task) if t), return_exceptions=True)
                turn = self.assembler.flush('transport_or_rotation')
                if turn:
                    self.save_turn(turn)
                if (self.settings.backend == 'windowed' and getattr(backend, 'response_context', None)
                        and not backend.response_done.is_set()):
                    context = backend.response_context
                    self.gap('window_response_interrupted', window_id=context['window_id'],
                             context_from=context['context_from'], context_to=context['context_to'])
                with contextlib.suppress(Exception):
                    await backend.close()
                self.session_started_at = None
            await asyncio.sleep(delay)
            delay = min(10, delay * 2)

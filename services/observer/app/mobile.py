"""Browser and native clip ingress with archive-first durable source retention."""
import asyncio
import base64
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import tempfile

from fastapi import HTTPException
from .protocol import Packet

MAX_CLIP_BYTES = 16_000_000
MAX_DURATION = 6.5


def fail(code, status=409):
    raise HTTPException(status, detail={'code': code})


async def run_media(*args, timeout=10):
    """No shell, no network protocols, bounded subprocess lifetime, reap on cancel."""
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.DEVNULL)
    try:
        async with asyncio.timeout(timeout):
            output, _ = await process.communicate()
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        fail('invalid_clip_media', 422)
    return output


async def probe_clip(path: Path):
    """Probe complete MP4/MOV and streaming WebM clips without trusting client duration.

    MediaRecorder WebM often has no Segment Duration. In that case packet timestamps
    provide the actual media span; reading one second beyond the allowed clip length
    makes an oversized stream fail rather than truncating it into an accepted clip.
    """
    raw = await run_media('ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_entries', 'format=format_name,duration,start_time:stream=codec_type,codec_name,width,height,duration,start_time,time_base,sample_rate',
        '-of', 'json', str(path), timeout=4)
    metadata = json.loads(raw)
    try:
        duration = float(metadata.get('format', {}).get('duration', 'nan'))
    except (ValueError, TypeError):
        duration = float('nan')
    if not math.isfinite(duration):
        raw = await run_media('ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-read_intervals', '%+8', '-show_packets', '-show_entries', 'packet=pts_time,duration_time',
            '-of', 'json', str(path), timeout=4)
        packets = json.loads(raw).get('packets', [])
        spans = []
        for packet in packets:
            start = float(packet.get('pts_time', 'nan'))
            length = float(packet.get('duration_time', 0))
            if math.isfinite(start) and math.isfinite(length) and length >= 0:
                spans.append((start, start + length))
        if not spans:
            fail('clip_duration_unavailable', 422)
        duration = max(end for _, end in spans) - min(start for start, _ in spans)
        metadata['duration_source'] = 'packet_timestamps'
    else:
        metadata['duration_source'] = 'container'
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        fail('clip_duration_out_of_range', 422)
    metadata.setdefault('format', {})['duration'] = str(duration)
    formats = metadata.get('format', {}).get('format_name', '').split(',')
    metadata['content_type'] = 'video/webm' if 'webm' in formats else 'video/mp4' if 'mp4' in formats else 'application/octet-stream'
    return metadata, duration


async def decode_clip(path: Path):
    """Keep the complete decoded audio, including the final fractional second."""
    try:
        metadata, duration = await probe_clip(path)
        streams = metadata.get('streams', [])
        video = next((s for s in streams if s.get('codec_type') == 'video'), None)
        audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
        if not video or not audio:
            fail('clip_requires_audio_and_video', 422)
        if not math.isfinite(duration) or not .2 <= duration <= MAX_DURATION:
            fail('clip_duration_out_of_range', 422)
        if not 1 <= video.get('width', 0) <= 4096 or not 1 <= video.get('height', 0) <= 4096:
            fail('clip_dimensions_out_of_range', 422)
        audio_path = path.parent / 'audio.f32'
        # Select the first available frame, then about one per second. The native
        # decoder applies MOV orientation before resizing, including portrait clips.
        vf = "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',scale=w='min(640,iw)':h=-2"
        await run_media('ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-y',
            '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', str(path),
            '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-t', '6.6',
            '-f', 'f32le', str(audio_path),
            '-map', '0:v:0', '-an', '-vf', vf, '-fps_mode', 'vfr', '-threads', '1',
            '-frames:v', '7', '-q:v', '5', '-t', '6.6', str(path.parent / 'frame-%02d.jpg'),
            timeout=10)
        pcm = audio_path.read_bytes()
        # AAC packets may retain a few encoder-padding samples after container
        # duration. Preserve them; never pad a final second with invented silence.
        if not 12_800 <= len(pcm) <= 422_400 or len(pcm) % 4:
            fail('clip_audio_duration_out_of_range', 422)
        frames = [p.read_bytes() for p in sorted(path.parent.glob('frame-*.jpg'))]
        if not frames or len(frames) > 7 or any(len(f) > 750_000 for f in frames):
            fail('clip_frames_out_of_range', 422)
        return pcm, frames
    except HTTPException:
        raise
    except TimeoutError:
        fail('clip_decode_timeout', 422)
    except (ValueError, KeyError, OSError, json.JSONDecodeError):
        fail('invalid_clip_media', 422)


class MobileIngest:
    """One upload call per clip; no lease. The clip is only archived; MiniCPM picks it up from the archive."""
    def __init__(self, service):
        self.service = service
        self.inflight = set()  # capture ids with an upload in progress
        self.next_clip_seq = OrderedDict()
        self.clips = self.duplicates = self.rejected = 0
        self.last_receipt = self.last_error = None
        self.last_live_capture = None

    def status(self):
        return {'capture_id': self.last_live_capture, 'clip_inflight': bool(self.inflight), 'clips_received': self.clips,
                'duplicate_clips': self.duplicates, 'rejected_clips': self.rejected,
                'last_receipt': self.last_receipt, 'last_error': self.last_error,
                'transport': 'successive_movie_segments_with_possible_capture_gaps'}

    async def ingest(self, video, capture_id, clip_seq, captured_at, captured_end_at=None, camera_facing=None, source="native_camera"):
        """Archive one uploaded clip (a spooled UploadFile) and acknowledge only after the archive committed it."""
        if captured_at.tzinfo is None or (captured_end_at and captured_end_at.tzinfo is None):
            fail('capture_timestamp_requires_timezone', 422)
        captured_at = captured_at.astimezone(timezone.utc)
        if captured_end_at and captured_end_at < captured_at:
            fail('capture_end_before_start', 422)
        if capture_id in self.inflight:
            fail('clip_inflight')
        self.inflight.add(capture_id)
        try:
            with tempfile.TemporaryDirectory(prefix='scene-mobile-') as directory:
                path = Path(directory) / 'input.mov'
                size, digest = 0, hashlib.sha256()
                with path.open('wb') as target:
                    while chunk := await video.read(1 << 20):
                        size += len(chunk)
                        if size > MAX_CLIP_BYTES:
                            fail('clip_too_large', 413)
                        digest.update(chunk)
                        target.write(chunk)
                if not size:
                    fail('empty_clip', 422)
                archive = self.service.archive
                old = await archive.get_clip(capture_id, clip_seq)
                if old:
                    if old['sha256'] != digest.hexdigest() or datetime.fromisoformat(old['captured_at']) != captured_at:
                        fail('clip_conflict')
                    # The previous upload may have committed even if its response was lost.
                    self.duplicates += 1
                    return {**old['receipt'], 'archived': True, 'media_id': old['media_id'],
                            'sha256': old['sha256'], 'duplicate': True}
                try:
                    metadata, duration = await probe_clip(path)
                    streams = metadata.get('streams', [])
                    modalities = {s.get('codec_type') for s in streams}
                    if not modalities.intersection({'audio', 'video'}):
                        fail('clip_requires_audio_or_video', 422)
                    for stream in streams:
                        if stream.get('codec_type') == 'video' and not (
                            1 <= stream.get('width', 0) <= 4096 and 1 <= stream.get('height', 0) <= 4096):
                            fail('clip_dimensions_out_of_range', 422)
                except (ValueError, KeyError, TypeError):
                    fail('invalid_clip_media', 422)
                metadata['capture_clock'] = 'client_wall_clock_at_recording_start_not_hardware_sync'
                metadata['captured_end_at'] = captured_end_at.isoformat() if captured_end_at else None
                metadata['source'] = source
                # Client-reported lens: front-camera clips usually show the phone holder.
                metadata['camera_facing'] = camera_facing or 'unknown'
                metadata['transport'] = 'successive_movie_segments_with_possible_capture_gaps'
                if not {'audio', 'video'} <= modalities:
                    metadata['analysis_skip_reason'] = 'partial_clip_missing_audio_or_video'
                # MiniCPM reads every clip from the archive (feeder.py), however late it was uploaded.
                receipt = {'status': 'archived', 'capture_id': capture_id, 'clip_seq': clip_seq,
                    'packet_count': 0, 'audio_seconds': duration, 'video_frames': 0, 'first_seq': None, 'last_seq': None,
                    'duplicate': False, 'analysis_status': 'pending' if {'audio', 'video'} <= modalities else 'archive_only'}
                stored = await archive.put_clip(path, capture_id=capture_id, clip_seq=clip_seq,
                    captured_at=captured_at.isoformat(), duration_seconds=duration, metadata=metadata,
                    packet_spans=[], receipt=receipt)
                receipt.update(archived=True, media_id=stored['media_id'], sha256=stored['sha256'])
                expected = self.next_clip_seq.get(capture_id)
                if expected is not None and clip_seq > expected:
                    self.service.gap('mobile_clip_sequence_gap', capture_id=capture_id, from_clip_seq=expected, to_clip_seq=clip_seq - 1)
                self.next_clip_seq[capture_id] = max(expected or 0, clip_seq + 1)
                self.next_clip_seq.move_to_end(capture_id)
                while len(self.next_clip_seq) > 64:
                    self.next_clip_seq.popitem(last=False)
                self.last_live_capture = capture_id
                self.clips += 1
                self.last_receipt, self.last_error = receipt, None
                return receipt
        except HTTPException as exc:
            self.rejected += 1
            self.last_error = exc.detail.get('code', 'archive_failed') if isinstance(exc.detail, dict) else 'archive_failed'
            raise
        except TimeoutError:
            self.rejected += 1
            self.last_error = 'clip_probe_timeout'
            fail('clip_probe_timeout', 422)
        finally:
            self.inflight.discard(capture_id)

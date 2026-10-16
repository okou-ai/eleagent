"""Authenticated archive ingest and agent-facing retrieval endpoints."""
import asyncio
from datetime import datetime
import errno
import json
from pathlib import Path
import sqlite3
import tempfile

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from .archive import ArchiveError, MAX_CLIP_BYTES, MAX_EVENT_BYTES


def http_error(exc):
    return HTTPException(exc.status_code, detail={'code': exc.code})


class ClipInfo(BaseModel):
    model_config = ConfigDict(extra='forbid')
    duration_seconds: float = Field(gt=0, le=60)
    metadata: dict = Field(default_factory=dict)
    packet_spans: list[dict] = Field(default_factory=list, max_length=128)
    receipt: dict = Field(default_factory=dict)


class EventInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: str = Field(min_length=1, max_length=160)
    body: dict
    event_id: str | None = None
    capture_id: str | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    model: str | None = Field(default=None, max_length=256)
    entity_ids: list[str] | None = Field(default=None, max_length=256)
    media_refs: list[dict] | None = Field(default=None, max_length=4096)
    source_packets: list[dict] | None = Field(default=None, max_length=4096)


async def bounded_body(request, maximum, timeout=30):
    data = bytearray()
    try:
        async with asyncio.timeout(timeout):
            async for chunk in request.stream():
                if len(data) + len(chunk) > maximum:
                    raise HTTPException(413, detail={'code': 'archive_request_too_large'})
                data.extend(chunk)
    except TimeoutError:
        raise HTTPException(408, detail={'code': 'archive_upload_timeout'})
    return bytes(data)


def install_archive_routes(app, archive):
    router = APIRouter(prefix='/v1/archive')
    extract_lock = asyncio.Semaphore(1)
    frame_lock = asyncio.Semaphore(2)

    async def call(method, *args, **kwargs):
        try:
            return await asyncio.to_thread(method, *args, **kwargs)
        except ArchiveError as exc:
            raise http_error(exc)
        except sqlite3.Error:
            raise HTTPException(503, detail={'code': 'archive_index_unavailable'})
        except OSError as exc:
            raise HTTPException(507 if exc.errno == errno.ENOSPC else 503,
                detail={'code': 'archive_disk_full' if exc.errno == errno.ENOSPC else 'archive_storage_unavailable'})
        except (TypeError, ValueError, KeyError):
            raise HTTPException(422, detail={'code': 'archive_invalid_request'})

    @router.get('/feed')
    async def feed(after: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=100)):
        return await call(archive.ingest_feed, after, limit)

    @router.get('/captures/{capture_id}/state')
    async def capture_state(capture_id: str):
        return await call(archive.capture_state, capture_id)

    @router.get('/captures/{capture_id}/clips/{clip_seq}')
    async def clip_receipt(capture_id: str, clip_seq: int):
        item = await call(archive.get_clip, capture_id, clip_seq)
        if item is None:
            raise HTTPException(404, detail={'code': 'archive_media_not_found'})
        await call(archive.media_path, item['media_id'])
        return item

    @router.post('/clips')
    async def ingest_clip(request: Request,
            capture_id: str = Query(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$'),
            clip_seq: int = Query(ge=0, le=2147483647), captured_at: datetime = Query()):
        raw_info = request.headers.get('x-archive-info', '')
        if len(raw_info) > 16_384:
            raise HTTPException(413, detail={'code': 'archive_metadata_too_large'})
        try:
            info = ClipInfo.model_validate_json(raw_info)
        except ValueError:
            raise HTTPException(422, detail={'code': 'archive_invalid_metadata'})
        # The ingress proxy has already decoded/validated this MOV. The archive
        # stores those exact bytes, preserving codec/orientation metadata supplied
        # by the decoder. This internal endpoint is not an untrusted media parser.
        payload = await bounded_body(request, MAX_CLIP_BYTES)
        if not payload:
            raise HTTPException(422, detail={'code': 'archive_empty_clip'})
        with tempfile.TemporaryDirectory(prefix='scene-archive-ingest-') as directory:
            path = Path(directory) / 'original.mov'
            await call(path.write_bytes, payload)
            return await call(archive.put_clip, path, capture_id, clip_seq, captured_at,
                              **info.model_dump())

    @router.post('/events')
    async def ingest_event(request: Request):
        raw = await bounded_body(request, MAX_EVENT_BYTES, timeout=10)
        try:
            event = EventInput.model_validate_json(raw)
        except ValueError:
            raise HTTPException(422, detail={'code': 'archive_invalid_event'})
        return await call(archive.record_event, **event.model_dump())

    @router.get('/events')
    async def list_events(capture_id: str | None = None, started_at: datetime | None = None,
                          ended_at: datetime | None = None, kind: str | None = None,
                          after: str | None = None, limit: int = Query(default=100, ge=1, le=100)):
        # Read-only recent context for the live loop (ingress) and the focus reader (text worker).
        return await call(archive.timeline, capture_id=capture_id, started_at=started_at,
                          ended_at=ended_at, kind=kind, after=after, limit=limit)

    @router.get('/media')
    async def media(capture_id: str | None = None, started_at: datetime | None = None,
                    ended_at: datetime | None = None, after: str | None = None,
                    limit: int = Query(default=100, ge=1, le=100)):
        return await call(archive.list_media, capture_id=capture_id, started_at=started_at,
                          ended_at=ended_at, after=after, limit=limit)

    @router.get('/media/{media_id}')
    async def media_info(media_id: str):
        item = await call(archive.get_media, media_id)
        if item is None:
            raise HTTPException(404, detail={'code': 'archive_media_not_found'})
        return item

    @router.api_route('/media/{media_id}/original', methods=['GET', 'HEAD'])
    async def original(media_id: str):
        path = await call(archive.media_path, media_id)
        item = await call(archive.get_media, media_id)
        # Starlette implements RFC byte ranges, If-Range and HEAD; do not load the
        # original in memory. Authentication applies equally to partial reads.
        media_type = {'.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime'}.get(path.suffix, 'application/octet-stream')
        return FileResponse(path, media_type=media_type, filename=media_id + path.suffix,
            headers={'Cache-Control': 'private, no-store', 'ETag': '"' + item['sha256'] + '"',
                     'X-Archive-SHA256': item['sha256'], 'X-Archive-Media-ID': media_id})

    @router.get('/media/{media_id}/frame')
    async def frame(media_id: str, t: float = Query(default=0, ge=0),
                    box: str | None = Query(default=None, max_length=80, pattern=r'^[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+$'),
                    ref_w: int | None = Query(default=None, ge=16, le=8192),
                    ref_h: int | None = Query(default=None, ge=16, le=8192),
                    pad: float = Query(default=.25, ge=0, le=2), size: int = Query(default=320, ge=64, le=1280)):
        # Still-image derivative for browsing detections. box=x,y,w,h is expressed in the
        # ref_w x ref_h decoded frame the detector saw; the original is untouched.
        asset = await call(archive.get_media, media_id)
        if asset is None:
            raise HTTPException(404, detail={'code': 'archive_media_not_found'})
        if not t < asset['duration_seconds']:
            raise HTTPException(422, detail={'code': 'archive_frame_outside_media'})
        filters = []
        if box is not None:
            if not ref_w or not ref_h:
                raise HTTPException(422, detail={'code': 'archive_frame_reference_size_required'})
            x, y, w, h = (float(value) for value in box.split(','))
            if w <= 0 or h <= 0:
                raise HTTPException(422, detail={'code': 'archive_frame_invalid_box'})
            left, top = max(0., x - w * pad), max(0., y - h * pad)
            right, bottom = min(float(ref_w), x + w * (1 + pad)), min(float(ref_h), y + h * (1 + pad))
            if right - left < 2 or bottom - top < 2:
                raise HTTPException(422, detail={'code': 'archive_frame_invalid_box'})
            filters += [f'scale={ref_w}:{ref_h}',
                        f'crop={int(right - left)}:{int(bottom - top)}:{int(left)}:{int(top)}']
        filters.append(f"scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease")
        path = await call(archive.media_path, media_id)
        directory = tempfile.TemporaryDirectory(prefix='scene-archive-frame-')
        output = Path(directory.name) / 'frame.jpg'
        process = None
        try:
            async with asyncio.timeout(20):
                async with frame_lock:
                    # Detection offsets are decoded-frame PTS relative to container start;
                    # input seeking uses the same origin. Back off 1 ms so that exact frame is kept.
                    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                        '-protocol_whitelist', 'file,pipe', '-threads', '1', '-ss', f'{max(0., t - .001):.6f}',
                        '-i', str(path), '-map', '0:v:0', '-frames:v', '1', '-vf', ','.join(filters),
                        '-q:v', '4', str(output)]
                    process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL,
                                                                   stderr=asyncio.subprocess.DEVNULL)
                    await process.wait()
                    if process.returncode or not output.exists() or output.stat().st_size == 0:
                        raise HTTPException(422, detail={'code': 'archive_frame_failed'})
            return FileResponse(output, media_type='image/jpeg', background=BackgroundTask(directory.cleanup),
                headers={'Cache-Control': 'private, max-age=604800, immutable', 'X-Archive-Media-ID': media_id,
                         'X-Archive-Frame-Seconds': str(t), 'X-Archive-Derivative': 'decoded_frame_not_original'})
        except BaseException as exc:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            directory.cleanup()
            if isinstance(exc, TimeoutError):
                raise HTTPException(504, detail={'code': 'archive_frame_timeout'}) from exc
            if isinstance(exc, FileNotFoundError):
                raise HTTPException(503, detail={'code': 'archive_ffmpeg_unavailable'}) from exc
            raise

    @router.get('/media/{media_id}/excerpt')
    async def excerpt(media_id: str, start: float = Query(default=0, ge=0),
                      duration: float = Query(default=5, gt=0, le=60),
                      format: str = Query(default='mp4', pattern=r'^(mp4|wav)$')):
        asset = await call(archive.get_media, media_id)
        if asset is None:
            raise HTTPException(404, detail={'code': 'archive_media_not_found'})
        if not start < asset['duration_seconds'] or duration > asset['duration_seconds'] - start + .001:
            raise HTTPException(422, detail={'code': 'archive_excerpt_outside_media'})
        path = await call(archive.media_path, media_id)
        directory = tempfile.TemporaryDirectory(prefix='scene-archive-excerpt-')
        output = Path(directory.name) / ('excerpt.' + format)
        process = None
        try:
            # One short transcode at a time. Source originals remain untouched.
            async with asyncio.timeout(60):
                async with extract_lock:
                    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                        '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', str(path),
                        '-ss', str(start), '-t', str(duration)]
                    if format == 'wav':
                        command += ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', str(output)]
                    else:
                        command += ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264',
                            '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', '-movflags', '+faststart', str(output)]
                    process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL,
                                                                   stderr=asyncio.subprocess.DEVNULL)
                    await process.wait()
                    if process.returncode:
                        raise HTTPException(422, detail={'code': 'archive_excerpt_failed'})
            return FileResponse(output, media_type='audio/wav' if format == 'wav' else 'video/mp4',
                filename=f'{media_id}-{start:g}.{format}', background=BackgroundTask(directory.cleanup),
                headers={'Cache-Control': 'private, no-store', 'X-Archive-Media-ID': media_id,
                         'X-Archive-Start-Seconds': str(start), 'X-Archive-Duration-Seconds': str(duration),
                         'X-Archive-Derivative': 'transcoded_excerpt_not_original'})
        except BaseException as exc:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            directory.cleanup()
            if isinstance(exc, TimeoutError):
                raise HTTPException(504, detail={'code': 'archive_excerpt_timeout'}) from exc
            if isinstance(exc, FileNotFoundError):
                raise HTTPException(503, detail={'code': 'archive_ffmpeg_unavailable'}) from exc
            raise

    app.include_router(router)

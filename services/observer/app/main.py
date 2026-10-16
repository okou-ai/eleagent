import asyncio
import hmac
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi import FastAPI, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from typing import Literal
from starlette.datastructures import UploadFile
import hashlib
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from .service import SceneService
from .mobile import MAX_CLIP_BYTES

class LocationFix(BaseModel):
    model_config = ConfigDict(extra='forbid')
    captured_at: datetime
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=1e6)
    altitude_m: float | None = Field(default=None, ge=-1e5, le=1e5)
    altitude_accuracy_m: float | None = Field(default=None, ge=0, le=1e6)
    heading_deg: float | None = Field(default=None, ge=0, le=360)
    speed_mps: float | None = Field(default=None, ge=0, le=1e4)
    pressure_hpa: float | None = Field(default=None, ge=300, le=1200)
    relative_altitude_m: float | None = Field(default=None, ge=-1e4, le=1e4)




MOTION_FIELDS = ('t_ms', 'alpha', 'beta', 'gamma', 'rr_alpha', 'rr_beta', 'rr_gamma', 'ax', 'ay', 'az', 'gx', 'gy', 'gz')


class MotionBatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    started_at: datetime
    sample_rate_hz: float = Field(gt=0, le=200)
    fields: list[str]
    samples: list[list[float | None]] = Field(min_length=1, max_length=1200)


class CaptureGap(BaseModel):
    model_config = ConfigDict(extra="forbid")
    started_at: datetime
    ended_at: datetime
    reason: Literal["page_hidden", "capture_interrupted", "buffer_full", "user_pause"]


class ClipMeta(BaseModel):
    """The `meta` part of a clip upload: which clip this is, plus the sensors recorded while it was captured."""
    model_config = ConfigDict(extra='forbid')
    capture_id: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    clip_seq: int = Field(ge=0, le=2147483647)
    captured_at: datetime
    captured_end_at: datetime | None = None
    camera: str | None = Field(default=None, pattern=r'^(front|back)$')
    locations: list[LocationFix] = Field(default_factory=list, max_length=120)
    motion: MotionBatch | None = None
    source: Literal["native_camera", "browser_media_recorder"] = "native_camera"
    capture_gaps: list[CaptureGap] = Field(default_factory=list, max_length=8)


def motion_summary(samples):
    """Camera elevation from W3C-style attitude: asin(-cos(beta)cos(gamma)); -90 down, 0 horizon, +90 up."""
    import math
    pitch, accel, spin = [], [], []
    for row in samples:
        t, alpha, beta, gamma, ra, rb, rg, ax, ay, az = row[:10]
        if beta is not None and gamma is not None:
            pitch.append(math.degrees(math.asin(max(-1., min(1., -math.cos(beta) * math.cos(gamma))))))
        if None not in (ax, ay, az):
            accel.append(ax * ax + ay * ay + az * az)
        if None not in (ra, rb, rg):
            spin.append(ra * ra + rb * rb + rg * rg)
    summary = {'samples': len(samples), 'duration_seconds': round((samples[-1][0] or 0) / 1000, 3)}
    if pitch:
        summary.update(camera_pitch_deg_mean=round(sum(pitch) / len(pitch), 1), camera_pitch_deg_min=round(min(pitch), 1),
            camera_pitch_deg_max=round(max(pitch), 1),
            facing_down_fraction=round(sum(p < -45 for p in pitch) / len(pitch), 3),
            level_fraction=round(sum(abs(p) <= 20 for p in pitch) / len(pitch), 3),
            facing_up_fraction=round(sum(p > 45 for p in pitch) / len(pitch), 3))
    if accel:
        summary['user_acceleration_rms_mps2'] = round(math.sqrt(sum(accel) / len(accel)), 3)
    if spin:
        summary['rotation_rate_rms_dps'] = round(math.sqrt(sum(spin) / len(spin)), 1)
    return summary


def bool_env(name, default=False):
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip().lower()
    if value not in ('true', 'false', '1', '0'):
        raise ValueError(name + ' must be true, false, 1 or 0')
    return value in ('true', '1')

@dataclass
class Settings:
    api_token: str
    db_path: str = '/data/scene.sqlite3'
    backend: str = 'mock'
    minicpm_url: str = ''
    queue_size: int = 8
    session_seconds: float = 240
    event_interval: float = 5
    max_packet_age_seconds: float = 8
    idle_seconds: float = 15
    upstream_start_timeout: float = 60
    minicpm_proxy: str | None = None
    window_seconds: float = 5
    window_flush_seconds: float = 2
    max_new_tokens: int = 320
    compact_observation: bool = False
    archive_url: str = ''
    archive_token: str = ''

    @classmethod
    def env(cls):
        return cls(api_token=os.getenv('SCENE_API_TOKEN', ''),
            db_path=os.getenv('SCENE_DB_PATH', '/data/scene.sqlite3'),
            backend=os.getenv('MINICPM_BACKEND', 'realtime'),
            minicpm_url=os.getenv('MINICPM_URL', ''),
            queue_size=int(os.getenv('SCENE_QUEUE_SIZE', '8')),
            session_seconds=float(os.getenv('MINICPM_SESSION_SECONDS', '240')),
            event_interval=float(os.getenv('SCENE_EVENT_INTERVAL', '5')),
            max_packet_age_seconds=float(os.getenv('SCENE_MAX_PACKET_AGE_SECONDS', '8')),
            idle_seconds=float(os.getenv('SCENE_IDLE_SECONDS', '15')),
            upstream_start_timeout=float(os.getenv('MINICPM_START_TIMEOUT', '60')),
            minicpm_proxy=os.getenv('MINICPM_PROXY') or None,
            window_seconds=float(os.getenv('SCENE_WINDOW_SECONDS', '5')),
            window_flush_seconds=float(os.getenv('SCENE_WINDOW_FLUSH_SECONDS', '2')),
            max_new_tokens=int(os.getenv('MINICPM_MAX_NEW_TOKENS', '320')),
            compact_observation=bool_env('MINICPM_COMPACT_OBSERVATION'),
            archive_url=os.getenv('SCENE_ARCHIVE_URL', ''),
            archive_token=os.getenv('SCENE_ARCHIVE_TOKEN', ''))

def create_app(settings=None, backend_factory=None):
    settings = settings or Settings.env()
    if not settings.api_token:
        raise ValueError('Set SCENE_API_TOKEN through owner-managed environment or Docker secret provisioning')
    if len(settings.api_token) < 16 or settings.api_token.startswith('replace-with-'):
        raise ValueError('SCENE_API_TOKEN must be a non-placeholder token of at least 16 characters')
    if settings.backend not in ('mock', 'realtime', 'windowed'):
        raise ValueError('MINICPM_BACKEND must be mock, realtime or windowed')
    if settings.backend != 'mock' and not settings.minicpm_url:
        raise ValueError('MINICPM_URL required for real backend')
    if settings.queue_size < 1:
        raise ValueError('queue capacity must be positive')
    if settings.session_seconds <= 0 or settings.event_interval < 0:
        raise ValueError('invalid timing config')
    if min(settings.max_packet_age_seconds, settings.idle_seconds, settings.upstream_start_timeout) <= 0:
        raise ValueError('packet age, idle and upstream timeouts must be positive')
    if not 1 <= settings.window_seconds <= 6 or settings.window_flush_seconds <= 0:
        raise ValueError('window duration must be 1 to 6 seconds, flush timeout positive')
    if type(settings.max_new_tokens) is not int or not 1 <= settings.max_new_tokens <= 320:
        raise ValueError('max_new_tokens must be an integer from 1 to 320')
    if type(settings.compact_observation) is not bool:
        raise ValueError('compact_observation must be boolean')
    if settings.archive_url and len(settings.archive_token) < 16:
        raise ValueError('SCENE_ARCHIVE_TOKEN is required when archival is enabled')
    Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
    service = SceneService(settings, backend_factory)

    @asynccontextmanager
    async def lifespan(app):
        await service.start()
        try:
            yield
        finally:
            await service.stop()

    app = FastAPI(title='Eleagent Observer', version='0.1.0', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = service
    # Static capture UI and upload share an origin. Archive reads remain internal.
    configured_web_root = os.getenv('SCENE_WEB_ROOT')
    web_root = Path(configured_web_root) if configured_web_root else Path(__file__).resolve().parents[3] / 'apps' / 'web'

    @app.middleware('http')
    async def browser_headers(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = ("default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        response.headers['Permissions-Policy'] = 'camera=(self), microphone=(self), geolocation=(self), screen-wake-lock=(self)'
        return response

    @app.get('/')
    async def capture_page():
        return FileResponse(web_root / 'index.html')

    @app.get('/assets/{name}')
    async def capture_asset(name: str):
        if name not in ('app.js', 'capture-state.js', 'queue.js', 'style.css', 'icon.svg', 'manifest.webmanifest'):
            raise HTTPException(404)
        return FileResponse(web_root / name)


    def auth(authorization: str = Header(default='')):
        if not hmac.compare_digest(authorization.encode(), ('Bearer ' + settings.api_token).encode()):
            raise HTTPException(401, 'Bearer authentication required')

    def location_events(meta):
        for fix in meta.locations:
            if fix.captured_at.tzinfo is None:
                raise HTTPException(422, detail={'code': 'location_time_requires_timezone'})
            at = fix.captured_at.isoformat()
            # Stable IDs make re-uploads of the same clip idempotent.
            event_id = 'location_' + hashlib.sha256(f'{meta.capture_id}|{at}'.encode()).hexdigest()[:32]
            yield ('location', {
                **fix.model_dump(exclude={'captured_at'}), 'captured_at': at,
                'source': 'browser_geolocation' if meta.source == 'browser_media_recorder' else 'native_location',
                'clock_source': 'device_location_fix_timestamp',
            }, dict(event_id=event_id, capture_id=meta.capture_id, started_at=at, ended_at=at, model='browser-geolocation' if meta.source == 'browser_media_recorder' else 'native-location'))

    def motion_event(meta):
        body = meta.motion
        if body is None:
            return None
        if tuple(body.fields) != MOTION_FIELDS or any(len(row) != len(MOTION_FIELDS) or row[0] is None for row in body.samples):
            raise HTTPException(422, detail={'code': 'motion_fields_unsupported'})
        if body.started_at.tzinfo is None:
            raise HTTPException(422, detail={'code': 'motion_time_requires_timezone'})
        offsets = [row[0] for row in body.samples]
        if offsets[0] < 0 or offsets != sorted(offsets) or offsets[-1] > 600_000:
            # The phone buffers motion until a clip is cut, so readings from before a pause (or across a clock
            # adjustment) can ride along. Sensor data must never block the clip: keep, in order, only the
            # readings taken during this clip.
            base = body.started_at.timestamp() * 1000
            clip_from = meta.captured_at.timestamp() * 1000 - 2000
            clip_to = (meta.captured_end_at or meta.captured_at + timedelta(seconds=60)).timestamp() * 1000 + 1000
            rows = sorted(([base + row[0], *row[1:]] for row in body.samples if clip_from <= base + row[0] <= clip_to),
                          key=lambda row: row[0])
            from . import metrics
            metrics.event('motion_trimmed', 'kept' if rows else 'dropped')
            if not rows:
                return None
            first = rows[0][0]
            body = body.model_copy(update={'started_at': datetime.fromtimestamp(first / 1000, tz=timezone.utc),
                                           'samples': [[round(row[0] - first, 3), *row[1:]] for row in rows]})
            offsets = [row[0] for row in body.samples]
        start = body.started_at.isoformat()
        end = (body.started_at + timedelta(milliseconds=offsets[-1])).isoformat()
        event_id = 'motion_' + hashlib.sha256(f'{meta.capture_id}|{start}'.encode()).hexdigest()[:32]
        return ('motion', {
            'summary': motion_summary(body.samples), 'sample_rate_hz': body.sample_rate_hz, 'fields': list(MOTION_FIELDS),
            'samples': body.samples, 'captured_at': start,
            'units': {'t_ms': 'ms from started_at', 'alpha/beta/gamma': 'rad, device attitude (expo-sensors DeviceMotion)',
                      'rr_*': 'deg/s', 'ax..az': 'm/s2 user acceleration', 'gx..gz': 'm/s2 including gravity'},
            'source': 'ios_core_motion_via_expo_sensors',
        }, dict(event_id=event_id, capture_id=meta.capture_id, started_at=start, ended_at=end, model='expo-sensors-device-motion'))

    @app.get('/v1/observations/latest', dependencies=[Depends(auth)])
    async def latest_observation(request: Request):
        """The newest MiniCPM observation, for the capture page. Only the latest one is exposed."""
        latest = service.latest_observation
        if not latest:
            return Response(status_code=204)
        etag = f'"{latest["id"]}"'
        if request.headers.get('if-none-match') == etag:
            return Response(status_code=304, headers={'ETag': etag})
        return JSONResponse(latest, headers={'ETag': etag})

    @app.post('/', dependencies=[Depends(auth)])
    @app.post('/v1/clips', dependencies=[Depends(auth)], include_in_schema=False)
    async def mobile_clip(request: Request):
        """The only upload call: multipart `meta` (JSON: clip identity + sensors recorded during it) and `video` (the clip)."""
        if not service.archive:
            raise HTTPException(503, detail={'code': 'archive_disabled'})
        length = request.headers.get('content-length')
        if length and length.isdigit() and int(length) > MAX_CLIP_BYTES + 2_000_000:
            raise HTTPException(413, detail={'code': 'clip_too_large'})
        try:
            async with asyncio.timeout(60):  # Bound multipart upload time on slow uplinks.
                form = await request.form(max_files=1, max_fields=1, max_part_size=2_000_000)
        except TimeoutError:
            raise HTTPException(408, detail={'code': 'clip_upload_timeout'})
        try:
            video, raw = form.get('video'), form.get('meta')
            if not isinstance(video, UploadFile) or not isinstance(raw, str):
                raise HTTPException(422, detail={'code': 'clip_upload_requires_meta_and_video'})
            try:
                meta = ClipMeta.model_validate_json(raw)
            except ValidationError:
                raise HTTPException(422, detail={'code': 'clip_meta_invalid'})
            # Validate sensor and gap metadata before committing the media.
            for gap in meta.capture_gaps:
                if gap.started_at.tzinfo is None or gap.ended_at.tzinfo is None or gap.ended_at < gap.started_at:
                    raise HTTPException(422, detail={'code': 'capture_gap_time_invalid'})
            events = list(location_events(meta)) + [e for e in [motion_event(meta)] if e]
            receipt = await service.mobile.ingest(video, meta.capture_id, meta.clip_seq, meta.captured_at,
                                                  meta.captured_end_at, meta.camera, meta.source)
            for gap in meta.capture_gaps:
                body = gap.model_dump(mode='json')
                event_id = 'gap_' + hashlib.sha256(f'{meta.capture_id}|{gap.started_at.isoformat()}|{gap.reason}'.encode()).hexdigest()[:32]
                events.append(('pipeline_gap', {**body, 'capture_id': meta.capture_id, 'source': meta.source},
                    dict(event_id=event_id, capture_id=meta.capture_id, started_at=body['started_at'], ended_at=body['ended_at'])))
            for kind, body, refs in events:
                service.archive.enqueue(kind, body, **refs)
            return {**receipt, 'locations': len(meta.locations), 'motion_samples': len(meta.motion.samples) if meta.motion else 0}
        finally:
            await form.close()

    from . import metrics
    metrics.instrument_fastapi(app)
    metrics.serve()
    return app

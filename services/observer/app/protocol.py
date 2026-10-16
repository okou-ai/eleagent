"""Local ingress envelope + pinned MiniCPM API V2 output contract."""
import base64
import math
import struct
from datetime import datetime, timezone
from typing import Any
from pydantic import BaseModel, Field, field_validator, ConfigDict

PIN = '47709a9210dfd71afa76c058e017fc8c4db5c8d2'
MAX_MESSAGE = 2_000_000

class Packet(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: str = 'input.append'
    capture_id: str = Field(min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    seq: int = Field(ge=0, strict=True)
    captured_at: datetime
    input: dict[str, Any]

    @field_validator('type')
    @classmethod
    def check_type(cls, value):
        if value != 'input.append':
            raise ValueError('type must be input.append')
        return value

    @field_validator('captured_at')
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None:
            raise ValueError('captured_at requires timezone')
        return value.astimezone(timezone.utc)

    @field_validator('input')
    @classmethod
    def validate_media(cls, value):
        if set(value) - {'audio', 'video_frames', 'force_listen', 'max_slice_nums'}:
            raise ValueError('unsupported input fields')
        audio = value.get('audio')
        if not isinstance(audio, str) or len(audio) > 200_000:
            raise ValueError('audio must be bounded base64 f32 PCM')
        try:
            raw = base64.b64decode(audio, validate=True)
        except Exception as exc:
            raise ValueError('invalid audio base64') from exc
        if not raw or len(raw) % 4 or len(raw) > 128_000:
            raise ValueError('audio must contain <=2 seconds of 16kHz float32 PCM')
        if any(not math.isfinite(x[0]) for x in struct.iter_unpack('<f', raw)):
            raise ValueError('non-finite PCM samples')
        frames = value.get('video_frames', [])
        if not isinstance(frames, list) or len(frames) > 2:
            raise ValueError('at most two JPEG frames')
        for frame in frames:
            if not isinstance(frame, str) or len(frame) > 1_000_000:
                raise ValueError('frame too large')
            try:
                image = base64.b64decode(frame, validate=True)
            except Exception as exc:
                raise ValueError('invalid JPEG base64') from exc
            if not image.startswith(b'\xff\xd8') or not image.endswith(b'\xff\xd9'):
                raise ValueError('frame must be a JPEG')
        if 'force_listen' in value and not isinstance(value['force_listen'], bool):
            raise ValueError('force_listen must be boolean')
        slices = value.get('max_slice_nums', 1)
        if type(slices) is not int or not 1 <= slices <= 2:
            raise ValueError('max_slice_nums must be 1 or 2 for MVP')
        return value

    @property
    def duration(self):
        return len(base64.b64decode(self.input['audio'])) / 4 / 16000

    @property
    def media_bytes(self):
        return len(base64.b64decode(self.input['audio'])) + sum(
            len(base64.b64decode(frame)) for frame in self.input.get('video_frames', []))

    @property
    def wire(self):
        # capture metadata belongs to OUR envelope, not the official protocol.
        return {'type': 'input.append', 'input': self.input}

class TurnAssembler:
    """Text is MODEL-GENERATED text, never implicitly ASR or structured perception.

    A response ID change, listen, or session.closed flushes partial output. V2
    video mode does not promise response.done per turn. No audio/text 1:1 mapping.
    """
    def __init__(self):
        self.response_id = None
        self.parts = []
        self.events = []
        self.audio_chunks = 0

    def flush(self, boundary):
        if not self.parts:
            self.reset()
            return None
        turn = {'response_id': self.response_id, 'generated_text': ''.join(self.parts),
                'raw_events': self.events, 'generated_audio_chunks': self.audio_chunks,
                'boundary': boundary, 'meaning': 'model_generated_text_not_user_transcript'}
        self.reset()
        return turn

    def reset(self):
        self.response_id, self.parts, self.events, self.audio_chunks = None, [], [], 0

    def consume(self, event):
        output = []
        if event.get('type') == 'response.done':
            # Chat mode provides an authoritative complete text in addition to
            # deltas; it preserves spaces some hosted delta chunks omit.
            text = event.get('text')
            if isinstance(text, str) and text:
                if len(text) > 16000:
                    raise ValueError('final text must be bounded')
                self.parts = [text]
            if event.get('response_id'):
                self.response_id = event['response_id']
            turn = self.flush('response.done')
            return [turn] if turn else []
        if event.get('type') == 'session.closed':
            turn = self.flush('session.closed')
            return [turn] if turn else []
        if event.get('type') != 'response.output.delta':
            return []
        kind = event.get('kind')
        if kind == 'listen':
            turn = self.flush('listen')
            return [turn] if turn else []
        if kind not in ('text', 'audio'):
            return []
        rid = event.get('response_id')
        if self.response_id is not None and rid is not None and self.response_id != rid:
            turn = self.flush('response_id_changed')
            if turn:
                output.append(turn)
        if rid is not None:
            self.response_id = rid
        # Never retain generated audio payload, let alone source audio/video.
        safe = {k: v for k, v in event.items()
                if k in ('type', 'kind', 'text', 'response_id', 'session_id', 'metrics')}
        if kind == 'text':
            text = event.get('text', '')
            if not isinstance(text, str) or len(text) > 4096:
                raise ValueError('text delta must be a bounded string')
            self.parts.append(text)
        else:
            self.audio_chunks += 1
            safe['audio_payload_discarded'] = True
        self.events.append(safe)
        if sum(map(len, self.parts)) > 16000 or len(self.events) > 256:
            turn = self.flush('bounded_partial')
            if turn:
                output.append(turn)
        return output

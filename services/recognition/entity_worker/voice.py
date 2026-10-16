"""Bounded VAD + ECAPA candidate features with original-audio sample offsets.

This is NOT speaker diarization: VAD does not detect speaker changes or overlap.
Consistent embeddings are provisional candidates, never verified speaker turns.
The caller may cluster candidates under explicitly provisional anonymous IDs;
manual correction or later diarization can revise these assignments.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path

ECAPA_REVISION = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"
ECAPA_SHA256 = "0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2"
SILERO_SHA256 = "e1122837f4154c511485fe0b9c64455f7b929c96fbb8d79fbdb336383ebd3720"
PREPROCESSING = "pcm16k-vad060-pad0-min250-sil200-ecapa192-l2-q050-v1"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class VoiceExtractor:
    """Sequential, bounded inference; callers must serialize access to this instance.

    Input: a decoded 16 kHz mono WAV, bounded to <= 30 seconds. ``segment_start_ms``
    is an optional offset of the WAV's first sample in its source media. Returned
    offsets include it; leave it zero if the coordinator applies stream PTS itself.
    CUDA use is explicit and must be scheduled with the gateway by the caller.
    """

    version = (
        f"silero6.2.1-{SILERO_SHA256[:16]}+"
        f"speechbrain1.0.3-ecapa-{ECAPA_SHA256[:16]}+{PREPROCESSING}"
    )

    def __init__(self, weights_dir: str | Path, device: str = "cpu"):
        import torch
        import torchaudio

        self.torch = torch
        self.device = torch.device(device)
        if self.device.type not in ("cpu", "cuda"):
            raise ValueError("voice_device_must_be_cpu_or_cuda")
        if self.device.type == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("voice_cuda_unavailable")
        # SpeechBrain 1.0.3 probes a removed TorchAudio decoder API on import.
        # This pipeline decodes exclusively with SoundFile, not TorchAudio.
        # Restore the module immediately after importing the tensor-only layers.
        compatibility_probe = not hasattr(torchaudio, "list_audio_backends")
        if compatibility_probe:
            torchaudio.list_audio_backends = lambda: ["soundfile"]
        try:
            from speechbrain.lobes.features import Fbank
            from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN
            from speechbrain.processing.features import InputNormalization
            from silero_vad import get_speech_timestamps
        finally:
            if compatibility_probe:
                del torchaudio.list_audio_backends

        root = Path(weights_dir)
        ecapa_path = root / "voice_ecapa.ckpt"
        vad_path = root / "voice_silero.jit"
        for path, expected in ((ecapa_path, ECAPA_SHA256), (vad_path, SILERO_SHA256)):
            if _sha256(path) != expected:
                raise ValueError(f"voice_weight_checksum_mismatch:{path.name}")
        self.features = Fbank(n_mels=80).to(self.device).eval()
        self.normalize = InputNormalization(norm_type="sentence", std_norm=False).to(self.device).eval()
        self.encoder = ECAPA_TDNN(
            input_size=80, channels=[1024, 1024, 1024, 1024, 3072],
            kernel_sizes=[5, 3, 3, 3, 1], dilations=[1, 2, 3, 4, 1],
            attention_channels=128, lin_neurons=192,
        ).to(self.device).eval()
        state = torch.load(ecapa_path, map_location="cpu", weights_only=True)
        self.encoder.load_state_dict(state, strict=True)
        # VAD is cheap and deliberately remains CPU-resident even with CUDA ECAPA.
        self.vad = torch.jit.load(str(vad_path), map_location="cpu").eval()
        self.get_speech_timestamps = get_speech_timestamps

    def _embedding(self, samples):
        torch = self.torch
        wave = torch.as_tensor(samples, dtype=torch.float32, device=self.device).unsqueeze(0)
        with torch.inference_mode():
            lengths = torch.ones(1, device=self.device)
            features = self.normalize(self.features(wave), lengths)
            embedding = self.encoder(features, lengths).reshape(-1)
            norm = torch.linalg.vector_norm(embedding)
            if not torch.isfinite(embedding).all() or float(norm) < 1e-8:
                raise RuntimeError("voice_embedding_invalid")
            return (embedding / norm).cpu().numpy()

    def extract(self, audio_path: str | Path, segment_start_ms: float = 0) -> list[dict]:
        import numpy as np
        import soundfile as sf

        if not math.isfinite(segment_start_ms) or segment_start_ms < 0:
            raise ValueError("voice_source_offset_invalid")
        with sf.SoundFile(str(audio_path)) as stream:
            if stream.samplerate != 16000 or stream.channels != 1:
                raise ValueError("voice_requires_16khz_mono")
            if stream.frames > 30 * 16000:
                raise ValueError("voice_audio_exceeds_30_seconds")
            samples = stream.read(dtype="float32")
        if not np.isfinite(samples).all():
            raise ValueError("voice_nonfinite_audio")
        if len(samples) == 0:
            return []
        source_offset = segment_start_ms / 1000.0
        with self.torch.inference_mode():
            regions = self.get_speech_timestamps(
                self.torch.from_numpy(samples), self.vad, sampling_rate=16000,
                threshold=0.60, min_speech_duration_ms=250,
                min_silence_duration_ms=200, speech_pad_ms=0,
                return_seconds=False,
            )
        results = []
        # Do not concatenate disjoint speech regions or cross gaps/speaker turns.
        # Split long regions into bounded 5 s samples; each output stays independent.
        for region in regions:
            for start in range(int(region["start"]), int(region["end"]), 5 * 16000):
                end = min(start + 5 * 16000, int(region["end"]), len(samples))
                wave = samples[start:end]
                duration = len(wave) / 16000.0
                rms = float(np.sqrt(np.mean(np.square(wave, dtype=np.float64))))
                rms_dbfs = 20 * math.log10(max(rms, 1e-12))
                clipped_fraction = float(np.mean(np.abs(wave) >= 0.999))
                reasons = []
                if duration < 3.0:
                    reasons.append("insufficient_speech_for_repeated_windows")
                if rms_dbfs < -45.0:
                    reasons.append("audio_level_too_low")
                if clipped_fraction > 0.01:
                    reasons.append("audio_clipping")
                agreement = None
                embedding = None
                if not reasons:
                    midpoint = len(wave) // 2
                    left = self._embedding(wave[:midpoint])
                    right = self._embedding(wave[midpoint:])
                    agreement = float(np.clip(np.dot(left, right), -1.0, 1.0))
                    if agreement < 0.50:
                        reasons.append("inconsistent_subwindow_embeddings")
                    else:
                        embedding = self._embedding(wave).tolist()
                # Agreement cannot detect all overlaps or changes. A candidate
                # may be provisionally clustered but is not verified identity.
                results.append({
                    "start_seconds": source_offset + start / 16000.0,
                    "end_seconds": source_offset + end / 16000.0,
                    "start_sample": start, "end_sample": end,
                    "sample_rate": 16000, "channels": 1,
                    "embedding": embedding,
                    "cluster_eligible": embedding is not None,
                    "candidate_for_clustering": embedding is not None,
                    "identity_status": (
                        "provisional_no_overlap_detector" if embedding is not None
                        else "unknown_insufficient_voice_evidence"
                    ),
                    "quality": {
                        "voiced_seconds": duration,
                        "rms_dbfs": round(rms_dbfs, 3),
                        "clipped_fraction": round(clipped_fraction, 6),
                        "subwindow_cosine_similarity": agreement,
                        "subwindow_cosine_threshold": 0.50,
                        "threshold_calibrated": False,
                        "feature_status": "candidate" if embedding is not None else "rejected",
                        "rejection_reasons": reasons,
                        "overlap_status": "not_measured",
                        "speaker_change_status": "not_measured",
                        "identity_verification": "not_verified_requires_diarization_and_overlap_check",
                    },
                })
        return results

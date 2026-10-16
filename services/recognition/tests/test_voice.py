"""Actual public-fixture inference; never reads the user's camera recordings."""
import os
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from entity_worker.voice import VoiceExtractor

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "voice_fixtures"


@pytest.fixture(scope="module")
def extractor():
    if not (ROOT / 'weights/voice_manifest.json').exists() or not FIXTURES.exists():
        pytest.skip('optional voice model weights and public fixtures are not installed')
    import torch
    torch.set_num_threads(2)
    return VoiceExtractor(ROOT / "weights", device=os.environ.get("VOICE_TEST_DEVICE", "cpu"))


def test_public_speaker_reference_pair_separates_from_other_speaker(extractor):
    # These filenames are the same/different-speaker examples in SpeechBrain's
    # official model card. A tiny plumbing regression, not accuracy calibration.
    embeddings = {}
    for name in ("spk1_snt1.wav", "spk1_snt2.wav", "spk2_snt1.wav"):
        samples, sr = sf.read(FIXTURES / name, dtype="float32")
        assert sr == 16000
        embedding = extractor._embedding(samples)
        assert embedding.shape == (192,)
        assert np.isfinite(embedding).all()
        assert np.linalg.norm(embedding) == pytest.approx(1.0, abs=1e-5)
        embeddings[name] = embedding
    same = float(np.dot(embeddings["spk1_snt1.wav"], embeddings["spk1_snt2.wav"]))
    different = float(np.dot(embeddings["spk1_snt1.wav"], embeddings["spk2_snt1.wav"]))
    assert same > different + 0.20


def test_real_speech_offsets_candidate_and_capability_flags(extractor):
    fixture = FIXTURES / "public_voxceleb_00003.wav"
    duration = sf.info(fixture).duration
    events = extractor.extract(fixture, segment_start_ms=250)
    assert events
    assert any(event["embedding"] is not None for event in events)
    for event in events:
        assert 0.25 <= event["start_seconds"] < event["end_seconds"] <= duration + 0.25
        assert event["start_seconds"] == pytest.approx(event["start_sample"] / 16000 + 0.25)
        assert event["end_seconds"] == pytest.approx(event["end_sample"] / 16000 + 0.25)
        assert event["quality"]["overlap_status"] == "not_measured"
        assert event["quality"]["speaker_change_status"] == "not_measured"
        assert event["quality"]["threshold_calibrated"] is False
        if event["cluster_eligible"]:
            assert event["identity_status"] == "provisional_no_overlap_detector"


def test_short_speech_never_creates_identity_candidate(extractor, tmp_path):
    samples, sr = sf.read(FIXTURES / "public_voxceleb_00003.wav", dtype="float32")
    path = tmp_path / "short.wav"
    sf.write(path, samples[: int(sr * 0.7)], sr)
    events = extractor.extract(path)
    assert events
    assert all(event["embedding"] is None and not event["cluster_eligible"] for event in events)


def test_silence_and_out_of_contract_audio(extractor, tmp_path):
    path = tmp_path / "silence.wav"
    sf.write(path, np.zeros(16000 * 5, dtype=np.float32), 16000)
    assert extractor.extract(path) == []
    sf.write(path, np.zeros(8000, dtype=np.float32), 8000)
    with pytest.raises(ValueError, match="16khz_mono"):
        extractor.extract(path)
    sf.write(path, np.zeros((16000, 2), dtype=np.float32), 16000)
    with pytest.raises(ValueError, match="16khz_mono"):
        extractor.extract(path)
    sf.write(path, np.zeros(16000 * 31, dtype=np.float32), 16000)
    with pytest.raises(ValueError, match="exceeds_30_seconds"):
        extractor.extract(path)
    with pytest.raises(ValueError, match="offset_invalid"):
        extractor.extract(path, segment_start_ms=float("nan"))


def test_abrupt_two_speaker_concat_is_not_a_durable_candidate(extractor, tmp_path):
    # This tests one controlled speaker transition without silence. It does NOT
    # establish that VAD+ECAPA detects general transitions or overlapping speech.
    left, sr = sf.read(FIXTURES / "public_voxceleb_00003.wav", dtype="float32")
    right, _ = sf.read(FIXTURES / "public_voxceleb_00004.wav", dtype="float32")
    path = tmp_path / "public_two_speakers.wav"
    samples = np.concatenate([left[16000:48000], right[32000:64000]])
    sf.write(path, samples, sr)
    events = extractor.extract(path)
    assert events
    assert all(not event["cluster_eligible"] for event in events)

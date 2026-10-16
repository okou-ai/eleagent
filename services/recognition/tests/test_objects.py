"""Real public-image model validation; no fabricated detector/embedding outputs."""
from pathlib import Path
import json
import os

import pytest
np = pytest.importorskip('numpy')
pytest.importorskip('torch')
pytest.importorskip('transformers')
pytest.importorskip('ultralytics')
from PIL import Image

from entity_worker.objects import ObjectDetector


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope='module')
def model():
    if not (ROOT / 'weights/manifest-object-yoloe.json').exists():
        pytest.skip('run object_download_models.py first')
    return ObjectDetector(ROOT / 'weights', device=os.environ.get('OBJECT_TEST_DEVICE', 'cpu'), threads=2)


@pytest.fixture(scope='module')
def sample():
    path = ROOT / 'object-sample-cats.png'
    if not path.exists():
        pytest.skip('public COCO sample is not downloaded')
    return np.asarray(Image.open(path).convert('RGB'))


def test_public_sample_real_detections_and_features(model, sample):
    records = model.extract(sample)
    cats = [r for r in records if r['label'] == 'cat']
    assert len(cats) == 2
    # The pinned prompt-free model detects these two public-sample cats on CUDA.
    # Confidence is an admission threshold, not a promise of calibrated certainty.
    assert all(record['confidence'] >= model.confidence for record in cats)
    assert max(record['bbox'][0] for record in cats) - min(record['bbox'][0] for record in cats) > 250
    for record in records:
        x1, y1, x2, y2 = record['bbox']
        assert 0 <= x1 < x2 <= sample.shape[1]
        assert 0 <= y1 < y2 <= sample.shape[0]
        assert record['identity_semantics'] == 'appearance_candidate_not_proof_of_same_physical_object'
        assert 'entity_id' not in record
        if record['feature'] is not None:
            assert len(record['feature']) == 384
            assert np.isfinite(record['feature']).all()
            assert abs(np.linalg.norm(record['feature']) - 1) < 1e-5
    assert all(record['feature'] is not None for record in cats)


def test_repeat_observation_preserves_descriptor_space(model, sample):
    first, second = model.extract(sample), model.extract(sample)
    assert len(first) == len(second)
    assert [record['label'] for record in first] == [record['label'] for record in second]
    for previous, current in zip(first, second):
        assert np.allclose(previous['bbox'], current['bbox'], atol=1e-4)
        if previous['feature'] is not None:
            assert np.dot(previous['feature'], current['feature']) > .99999


def test_blank_frame_does_not_produce_clusterable_objects(model):
    records = model.extract(np.zeros((480, 640, 3), dtype=np.uint8))
    # Prompt-free vocabulary can label a whole black frame "darkness". Preserve
    # raw detector evidence, but the existing quality gate must reject its crop.
    for record in records:
        assert record['feature'] is None
        assert record['quality']['accepted'] is False
        assert record['quality']['unknown_reason'] == 'object_blurred'


def test_invalid_frame_and_unverified_weights_rejected(model, tmp_path):
    with pytest.raises(ValueError, match='object_input_requires_rgb'):
        model.extract(np.zeros((480, 640, 3), dtype=np.float32))
    manifest = json.loads((ROOT / 'weights/manifest-object-yoloe.json').read_text())
    (tmp_path / 'manifest-object-yoloe.json').write_text(json.dumps(manifest))
    (tmp_path / manifest['files']['yoloe']['filename']).write_bytes(b'corrupted weights')
    with pytest.raises(ValueError, match='object_model_checksum_mismatch:yoloe'):
        ObjectDetector(tmp_path)


def test_pinned_preprocessing_matches_official_processor(model, sample):
    pytest.importorskip('torchvision')
    from transformers import AutoImageProcessor
    processor = AutoImageProcessor.from_pretrained(ROOT / 'weights/dinov2-small',
                                                   local_files_only=True, use_fast=False)
    # Rectangular crops exercise resize rounding and center-crop alignment.
    images = [Image.fromarray(sample[:237, :319]), Image.fromarray(sample[17:401, 190:333])]
    expected = processor(images=images, return_tensors='pt')['pixel_values'].numpy()
    actual = model._appearance_inputs(images)['pixel_values'].cpu().numpy()
    assert actual.shape == (2, 3, 224, 224)
    assert np.allclose(actual, expected, atol=5e-7)

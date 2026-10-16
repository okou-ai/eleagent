"""A cached dependency image must match every pinned PyTorch wheel version."""
import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    'install_dependencies', Path(__file__).parents[1] / 'install_dependencies.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


@pytest.fixture
def torch_lock():
    return (Path(__file__).parents[1] / 'requirements-torch-spark.txt').read_text().splitlines()


def test_cache_rejects_version_drift(monkeypatch, torch_lock):
    monkeypatch.setattr(installer.importlib.metadata, 'version', lambda name: '2.12.0')
    with pytest.raises(ValueError, match='does not match'):
        installer.reuse_torch(torch_lock)


def test_cache_preserves_other_pins_and_requires_all_wheels(monkeypatch, torch_lock):
    versions = {'torch': '2.13.0+cu130', 'torchvision': '0.28.0+cu130', 'torchaudio': '2.11.0+cu130'}
    monkeypatch.setattr(installer.importlib.metadata, 'version', versions.__getitem__)
    result = installer.reuse_torch(torch_lock + ['nvidia-nccl-cu13==2.29.7'])
    assert 'nvidia-nccl-cu13==2.29.7' in result
    assert all(f'{name}=={version}' in result for name, version in versions.items())
    with pytest.raises(ValueError, match='all three'):
        installer.reuse_torch([line for line in torch_lock if not line.startswith('torchaudio @')])

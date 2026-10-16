"""Fetch pinned official ECAPA weights and copy pinned Silero package weights.

No remote model code/hyperparameter YAML is executed. Both model artifacts are
verified against fixed SHA-256 values before replacing the destination file.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import urllib.request

from entity_worker.voice import ECAPA_REVISION, ECAPA_SHA256, SILERO_SHA256, PREPROCESSING


def verified_write(path, payload, checksum):
    if hashlib.sha256(payload).hexdigest() != checksum:
        raise ValueError(f"download_checksum_mismatch:{path.name}")
    temporary = path.with_suffix(path.suffix + ".download")
    temporary.write_bytes(payload)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights-dir", type=Path, default=Path(__file__).parent / "weights")
    args = parser.parse_args()
    root = args.weights_dir
    root.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/{ECAPA_REVISION}/embedding_model.ckpt"
    path = root / "voice_ecapa.ckpt"
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != ECAPA_SHA256:
        with urllib.request.urlopen(url, timeout=120) as response:
            verified_write(path, response.read(90 * 1024 * 1024), ECAPA_SHA256)
    dist = importlib.metadata.distribution("silero-vad")
    if dist.version != "6.2.1":
        raise ValueError("silero_package_must_be_6.2.1")
    silero = Path(dist.locate_file("silero_vad/data/silero_vad.jit"))
    verified_write(root / "voice_silero.jit", silero.read_bytes(), SILERO_SHA256)
    manifest = {
        "preprocessing": PREPROCESSING,
        "ecapa": {"url": url, "sha256": ECAPA_SHA256, "revision": ECAPA_REVISION,
                  "license": "Apache-2.0", "filename": "voice_ecapa.ckpt"},
        "silero": {"package": "silero-vad==6.2.1", "sha256": SILERO_SHA256,
                   "license": "MIT", "filename": "voice_silero.jit"},
    }
    (root / "voice_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()

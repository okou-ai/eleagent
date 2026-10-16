# Recognition workers

This service contains three independently scheduled workers:

- `entity_worker.worker`: YuNet/SFace face candidates and YOLOE/DINOv2 object appearances.
- `entity_worker.speech`: Silero VAD, CAM++ speaker candidates, and Qwen3-ASR transcripts.
- `entity_worker.text_worker`: CPU OCR with RapidOCR and PP-OCRv6 small.

Recognition creates provisional evidence, not verified identities. Original source references and uncertainty remain available to the sleep agent.

## Containers

Build the `objects`, `speech`, and `ocr` targets of this directory's Dockerfile. The GPU targets use checksum-pinned official CUDA 13 wheels for ARM64 and CPython 3.12. They require the NVIDIA container runtime and a compatible driver. All three dependency sets resolve for ARM64/CPython 3.12 and their transitive versions are locked in `requirements-*.lock`. The speech build includes upstream tokenizer dependencies that may compile from source. These public build recipes have not yet been built and exercised on a fresh machine; local source checks do not establish deployment or model accuracy.

```sh
docker build --target objects -t eleagent-recognition services/recognition
docker build --target speech -t eleagent-speech services/recognition
docker build --target ocr -t eleagent-ocr services/recognition
```

All workers require `ARCHIVE_URL` and `SCENE_ARCHIVE_TOKEN`. They share writable state at `/data/entities.sqlite`. Mount the entire state directory so SQLite WAL files and GPU handoff markers are shared. Each GPU worker acknowledges a nightly pause only after finishing its current job and publishes readiness after loading its models.

Model locations:

| Path | Contents |
| --- | --- |
| `/models/entities` | Face/object manifests and weights; `voice_silero.jit` |
| `/models/campplus` | CAM++ checkpoint and configuration |
| `/models/qwen3-asr-1.7b` | Qwen3-ASR checkpoint and tokenizer |
| `/models/ocr` | The three RapidOCR ONNX files |

`ENTITY_WEIGHTS_DIR` overrides the shared entity model directory. `ASR_LANGUAGE` is optional; leave it unset for automatic language detection. `--glossary-file` accepts one domain term per line; the default glossary is empty. `GATEWAY_WORKER_ID` identifies a co-located inference worker if the optional MiniCPM gate is enabled. The reference object container disables that gate because recognition runs on its own host.

## Model preparation

No model weights or human recordings are included. Review each model's terms before downloading. Use `download_models.py` for faces, `object_download_models.py` for objects, and `ocr_download_models.py --model-dir PATH` for OCR. Set `ENTITY_WEIGHTS_DIR` for the first two scripts. `voice_download_models.py --weights-dir PATH` prepares the pinned Silero weight and the optional ECAPA model used by the legacy single-clip voice extractor; the main speech worker uses CAM++ instead of ECAPA. The voice downloader requires `silero-vad==6.2.1` installed.

The CAM++ and Qwen3-ASR directories must be prepared separately using the pinned model sources listed in the deployment configuration. Containers load local weights and do not download them during inference.

## Tests

Use a separate Python environment, install `requirements-dev.txt`, then run from this directory:

```sh
python -m pytest tests
```

The unit tests use temporary databases, generated signals, and fabricated identifiers. Model tests are optional and skip when their dependencies, weights, or external public fixtures are absent. No personal camera recordings, face images, voice samples, or production database snapshots are distributed. Optional model tests are plumbing checks rather than accuracy claims.

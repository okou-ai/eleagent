# Recognition workers

This service contains three independently scheduled workers:

- `entity_worker.worker`: YuNet/SFace face candidates and YOLOE/DINOv2 object appearances.
- `entity_worker.speech`: Silero VAD, CAM++ speaker candidates, and Qwen3-ASR transcripts.
- `entity_worker.text_worker`: CPU OCR with RapidOCR and PP-OCRv6 small.

Recognition creates provisional evidence, not verified identities. Original source references and uncertainty remain available to the sleep agent.

## Containers

Build the `objects`, `speech`, and `ocr` targets of this directory's Dockerfile. The GPU targets use checksum-pinned official CUDA 13 wheels for ARM64 and CPython 3.12. They require the NVIDIA container runtime and a compatible driver. All three dependency sets resolve for ARM64/CPython 3.12 and their transitive versions are locked in `requirements-*.lock`. The speech build includes upstream tokenizer dependencies that may compile from source.

All three targets were built and exercised on synthetic media in the [deployment validation run](../../docs/deployment-validation.md). The GPU targets reused exact-version installed PyTorch packages from a local dependency image; model files were verified against their pinned hashes. The run exercised object processing, CAM++/Qwen speech, and baseline/focus OCR. It does not establish a fresh download of all default dependencies or model accuracy.

```sh
docker build --target objects -t eleagent-recognition services/recognition
docker build --target speech -t eleagent-speech services/recognition
docker build --target ocr -t eleagent-ocr services/recognition
```

### Reusing a local dependency image

If the three large PyTorch wheels are already installed in a trusted ARM64/Python 3.12 dependency image, the following optional build mode reuses those packages while building the application from this checkout:

```sh
docker build --target objects \
  --build-arg RECOGNITION_BASE_IMAGE="$LOCAL_DEPENDENCY_IMAGE" \
  --build-arg REUSE_INSTALLED_TORCH=1 \
  -t eleagent-recognition services/recognition
```

Use `--target speech` for the speech image. The installer requires exact matches for all three versions in the lock file and still installs the remaining locked dependencies. A cache image's provenance is the operator's responsibility; installed packages cannot be rechecked against the original wheel archive hashes. This mode does not establish that the default online download path was exercised. The default build uses the public Python base and checksum-pinned wheel URLs.

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

No model weights or human recordings are included. Review each model's terms before downloading. Use `download_models.py` for faces, `object_download_models.py` for objects, and `ocr_download_models.py --model-dir PATH` for OCR. Set `ENTITY_WEIGHTS_DIR` for the first two scripts. For a local copy of the face cache, `download_models.py --offline --weights-dir PATH` checks the pinned weight hashes and requires both license files without network access. The object and OCR scripts reuse existing files only when their pinned hashes match. `voice_download_models.py --weights-dir PATH` prepares the pinned Silero weight and the optional ECAPA model used by the legacy single-clip voice extractor; the main speech worker uses CAM++ instead of ECAPA. The voice downloader requires `silero-vad==6.2.1` installed.

To prepare only the required Silero weight from the already installed, pinned package, use the built speech image. This mode makes no model download request:

```sh
mkdir -p "$MODEL_ROOT/entities"
docker run --rm --entrypoint python \
  -v "$MODEL_ROOT/entities:/models/entities" \
  local/eleagent-speech:production /app/voice_download_models.py \
  --weights-dir /models/entities --skip-ecapa
```

Omit `--skip-ecapa` only when enabling the optional legacy voice extractor. Fresh speech and OCR worker installations consume existing archived clips from cursor zero, including recordings uploaded while their models were loading. Existing worker generations inherit their saved progress instead of reprocessing completed history.

The CAM++ and Qwen3-ASR directories must be prepared separately using the pinned model sources listed in the deployment configuration. Containers load local weights and do not download them during inference.

## Tests

Install FFmpeg for the generated-media checks. Use a separate Python environment, install `requirements-dev.txt`, then run from this directory:

```sh
python -m pytest tests
```

The unit tests use temporary databases, generated signals, and fabricated identifiers. Model tests are optional and skip when their dependencies, weights, or external public fixtures are absent. No personal camera recordings, face images, voice samples, or production database snapshots are distributed. Optional model tests are plumbing checks rather than accuracy claims.

# Prepare and verify model files

Run these commands from the repository root on the host that will serve each
model. `models.lock.json` is the source of repository IDs, immutable revisions,
directory names, and licenses. The verifier reads metadata and local bytes; it
never downloads weights or modifies the model directory.

```sh
set -a
. deploy/dual-spark/.env
set +a
mkdir -p "$MODEL_ROOT" "$DATA_ROOT/model-metadata"
```

## Reuse local files

Existing files may be copied, hard-linked, or symlinked into the documented
directories. For example, when the destination does not already exist:

```sh
ln -s /mnt/existing-models/MiniCPM-o-4_5 "$MODEL_ROOT/MiniCPM-o-4_5"
python3 deploy/verify-model.py minicpm-o-4_5 \
  --path "$MODEL_ROOT/MiniCPM-o-4_5" \
  --write-metadata "$DATA_ROOT/model-metadata/minicpm.json"
```

The first check fetches the file list at the exact pinned revision. It verifies
large Git LFS artifacts with SHA-256 and ordinary files, including configuration
and tokenizer files, with Git blob SHA-1. A modified configuration fails even
when every weight shard is correct. Extra local cache files are ignored. Only
the MiniCPM demo files listed in `optional_file_patterns` may be absent; these
are example audio/video recordings, not model weights or configuration.

To repeat the check without any network requests, reuse metadata saved by the
first check. The cache must identify the same repository and revision:

```sh
python3 deploy/verify-model.py minicpm-o-4_5 \
  --path "$MODEL_ROOT/MiniCPM-o-4_5" \
  --metadata-file "$DATA_ROOT/model-metadata/minicpm.json"
```

Store trusted metadata with deployment records. The verifier checks its pinned
identity, but an edited local metadata file is not an independent upstream proof.

Run the corresponding checks on Spark 2:

```sh
python3 deploy/verify-model.py qwen3-asr-1.7b --path "$MODEL_ROOT/qwen3-asr-1.7b"
python3 deploy/verify-model.py campplus --path "$MODEL_ROOT/campplus"
```

For the optional Atlas profile, verify the original upstream source directories
on both hosts before conversion. Keep any local runtime configuration changes
in the converted runtime directory; never relax hash checks to accept changes:

```sh
python3 deploy/verify-model.py glm-5.3-flash-nvfp4 \
  --path "$MODEL_ROOT/glm-5.3-flash-atlas/nvidia--GLM-5.3-Flash-NVFP4"
python3 deploy/verify-model.py glm-dflash2 \
  --path "$MODEL_ROOT/glm-5.3-flash-atlas/incoai--GLM-5.3-Flash-DFlash2"
```

## Download when a verified local copy is unavailable

Install the public download CLI in a local environment:

```sh
python3 -m venv .venv
.venv/bin/pip install huggingface_hub==0.34.6
```

On Spark 1:

```sh
.venv/bin/hf download openbmb/MiniCPM-o-4_5 \
  --revision 503e754207c94da6bb26850b4469f367c9ea3582 \
  --local-dir "$MODEL_ROOT/MiniCPM-o-4_5"
python3 deploy/verify-model.py minicpm-o-4_5 --path "$MODEL_ROOT/MiniCPM-o-4_5"
```

On Spark 2:

```sh
.venv/bin/hf download Qwen/Qwen3-ASR-1.7B \
  --revision 7278e1e70fe206f11671096ffdd38061171dd6e5 \
  --local-dir "$MODEL_ROOT/qwen3-asr-1.7b"
.venv/bin/hf download funasr/campplus \
  --revision e4b6ede7ce16997aff4ae69fbca1f0175e2afede \
  --local-dir "$MODEL_ROOT/campplus"
python3 deploy/verify-model.py qwen3-asr-1.7b --path "$MODEL_ROOT/qwen3-asr-1.7b"
python3 deploy/verify-model.py campplus --path "$MODEL_ROOT/campplus"
```

The remaining recognition model download commands and checksum checks are in
[the recognition guide](../services/recognition/README.md). They also reuse
existing files rather than downloading matching bytes again.

## Optional restricted Atlas profile

The DFlash2 drafter uses **CC-BY-NC-ND-4.0**. This is an optional research profile,
not a commercially unrestricted default. Review and accept its terms before
running the following downloads. The base GLM weights have a separate MIT license.

Run on both hosts, or copy verified files between them over your private link:

```sh
.venv/bin/hf download nvidia/GLM-5.3-Flash-NVFP4 \
  --revision da920bb0b9f4a06727223a349e55468e38352348 \
  --local-dir "$MODEL_ROOT/glm-5.3-flash-atlas/nvidia--GLM-5.3-Flash-NVFP4"
.venv/bin/hf download incoai/GLM-5.3-Flash-DFlash2 \
  --revision 7d74cdd881ed7e32c31175984a67823127b66cfe \
  --local-dir "$MODEL_ROOT/glm-5.3-flash-atlas/incoai--GLM-5.3-Flash-DFlash2"
```

Then run the two Atlas verification commands above and follow
[the Atlas conversion instructions](atlas/README.md). Conversion creates the
runtime layout and is required even when source downloads are skipped.

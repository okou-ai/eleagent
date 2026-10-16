# MiniCPM perception runtime

This recipe fetches the official MiniCPM-o Demo at the commit and Git tree in
`source.lock.json`. It runs its Python backend plus forwarding worker; it does
not run a vLLM inference server or vendor upstream application code. No license
file was found in this pinned demo repository, so `source.lock.json` records
`NOASSERTION`: review upstream permission before distributing a built demo image.
The MiniCPM model card lists Apache-2.0 for weights, which is a separate artifact.

The application artifact URLs and hashes in `requirements.arm64.lock` come from
the ARM64 CPython 3.12 package set used by the deployed worker. The 33 wheels
match public PyPI filenames, URLs, sizes, and SHA-256 values. `minicpmo-utils`
1.0.6 is built from its checksum-pinned public source distribution using the
pinned setuptools backend in `build-requirements.lock`; no machine-local wheel
is required. Package notices remain in their installed distributions.

`base.Dockerfile` provides a public base candidate from the ARM64 manifest of
NVIDIA CUDA 13.0.2 with cuDNN on Ubuntu 24.04, pinned by digest. It installs
Python 3.12 and the 104-package ARM64 dependency closure in
`base-requirements.lock`, including checksum-pinned official CUDA 13 PyTorch,
TorchVision, and TorchAudio wheels. `base-requirements.in` records the direct
inputs; update its lock with `uv pip compile --python-version 3.12
--python-platform aarch64-manylinux_2_28 --generate-hashes --no-header
--no-annotate -o base-requirements.lock base-requirements.in` from this directory.
The `minicpmo-utils` source package is installed separately without dependency
resolution: its older `librosa==0.9.0` metadata conflicts with the official demo's
explicit `librosa>=0.10.2` requirement, so the application retains the deployed
`librosa==0.11.0` override and ARM64 `decord2` package.

```sh
bash deploy/minicpm/build.sh
```

The default build composes the public base and application into one multi-stage
build. `build-base.sh` optionally builds only the base. To use a separately
reviewed public base instead, set `MINICPM_BASE_IMAGE` to an immutable public
reference ending in `@sha256:...`. No previously built machine-local image is
required. The pinned upstream model/application select PyTorch SDPA when the
optional `flash-attn` package is absent; no Flash Attention wheel is required.

Registry identities, public wheel metadata, dependency resolution, and recipe
syntax were checked. This public base is a **build candidate**: a clean-host
image build, GB10 model loading, and inference acceptance have not been run.
The Dockerfiles include CPU-side import and version checks; they do not load
model weights. Ubuntu package updates are not snapshot-pinned, so this is not a
claim of bit-for-bit reproducible image output. Upstream application licensing
remains a separate review item even when all build inputs are public.

The English entrypoint starts the backend on container loopback, waits for model
readiness, then starts the forwarding worker. It terminates both child processes
when either exits. Direct observer-to-worker calls do not require an upstream
demo gateway or automatic worker registration. The current windowed observer
connects to `ws://127.0.0.1:22400/v1/worker/chat`.

Mount the pinned MiniCPM-o-4_5 snapshot at `/models/MiniCPM-o-4_5`, expose worker
port 22400 only to the internal observer, and give the container its assigned GPU.
`MODEL_PATH`, `BACKEND_PORT`, `WORKER_HOST`, `WORKER_PORT`, and `GPU_ID` are configurable. Persist
`/app/torch_compile_cache` separately from model weights. The dual-Spark recipe
owns networking and host paths.

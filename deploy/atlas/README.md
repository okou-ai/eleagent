# Atlas on two Spark hosts

`build.sh` fetches SparkGLM and the Atlas engine at the exact commits and Git tree
IDs in `sources.lock.json`. It applies `public-native.patch` to the upstream
Dockerfile. The patch reuses three native libraries and the converter library
from a digest-pinned public ARM64 image, verifies their checksums, preserves their
license notices, and rebuilds the server from the pinned engine source. It does
not reuse the published server executable. No upstream source tree or binary is
vendored in Eleagent.

The runtime is AGPL-3.0-only, with notices for its third-party components.
`create-rank.sh` derives from SparkGLM's `install/start-node.sh` at the pinned
commit. Eleagent changes it to create a stopped, no-restart container under its
own name and ownership label, with a 114 GiB memory limit, a fixed 1M engine
context limit, and no-new-privileges. The manager starts the exact captured ID
only after draining daytime work. `profile-4x1m.json` is the matching upstream
profile. Sleep limits its own request context to 512K tokens.

## Provisioning

1. On an ARM64 host with Docker and NVIDIA Container Toolkit, run `bash build.sh`.
   Record the exact image ID printed by Docker. Configure each host's manager
   with its locally built image ID. The recipes are source-pinned, but package
   registries can change; independent builds need not have identical image IDs.
2. Download the model revisions listed in `../models.lock.json` into a local
   model root, using the directory names from that manifest. The current DFlash2
   profile requires accepting its CC BY-NC-ND-4.0 restrictions; it is optional
   research functionality, not a blanket commercial-use configuration.
3. During an explicit maintenance window with GPUs free, run
   `bash convert-model.sh MODEL_ROOT sha256:IMAGE_ID` on each host. This is a GPU
   conversion step and is not run by the scheduler or by an ordinary build.
   The wrapper also removes the original BF16 MTP exclusion patterns from the
   converted overlay's metadata. It replaces metadata links with overlay-local
   files and never edits the source checkpoint.
4. Keep `conversion.complete.json`, `sparkglm-verified.json`, and the wrapper's
   `eleagent-overlay.json` in
   `atlas-overlay`. Keep the source checkpoint mounted at its absolute path:
   the overlay contains links to it. Configure fabric interface/HCA names for
   each host explicitly; no particular device or network address is assumed.
5. Install the GPU managers using `../dual-spark` and let Sleep control them.
   Do not start the ranks alongside daytime GPU workers.

`fetch-sources.sh DESTINATION` prepares sources without building or inference.
`create-rank.sh` only creates a stopped rank. Neither performs downloads or model
conversion. Build checks are upstream CPU-side compilation checks, not quality
benchmarks. The public packaging was checked statically; a clean-host build and
nighttime handoff remain release acceptance work.

## Reusing local build assets

Large assets do not need to be downloaded again. Set
`ATLAS_NATIVE_ARTIFACTS_DIR` to an extracted release directory containing
`opt/atlas/native`, `opt/atlas/notices`, and
`opt/atlas/converter/libatlas_mtp_quantize.so`. The same fixed checksums and
architecture checks still run. No existing server executable is copied from
this directory.

For hosts without direct GitHub access, `ATLAS_SOURCE_CACHE` may point to a
directory containing local `sparkglm.git` and `engine.git` repositories. They
must contain all objects needed for the commits in `sources.lock.json`; partial
clones with missing objects are insufficient. Commit and tree verification is
identical to the network-fetch path. Keep these caches outside the Eleagent
checkout.

`ATLAS_CUDA_DEVEL_IMAGE` and `ATLAS_CUDA_RUNTIME_IMAGE` optionally select exact
local Docker image IDs (`sha256:...`) or digest-pinned repository references.
They must provide the corresponding CUDA 13.0 development and runtime tools on
Ubuntu 24.04, respectively. The defaults remain the pinned public NVIDIA images.
Record any overrides with the resulting image ID: using a different local base
validates that build path, not a fresh download of the default base images.
The server is compiled from the pinned engine source in either case, and the
default build runs the upstream CPU checks before producing the runtime image.

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
4. Keep both `conversion.complete.json` and `sparkglm-verified.json` in
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

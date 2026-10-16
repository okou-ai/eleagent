#!/usr/bin/env bash
# Optional base-only build. build.sh uses this same recipe as a build stage.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $# == 0 ]] || { echo 'usage: MINICPM_BASE_TAG=IMAGE build-base.sh' >&2; exit 2; }
[[ $(uname -m) == aarch64 ]] || { echo 'Build on an ARM64 host' >&2; exit 2; }
tag=${MINICPM_BASE_TAG:-local/eleagent-minicpm-base:candidate}
docker build --platform linux/arm64 -f "$here/base.Dockerfile" -t "$tag" "$here"
docker image inspect --format '{{.Id}}' "$tag"

#!/usr/bin/env bash
# Optional base-only build. build.sh uses this same recipe as a build stage.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $# == 0 ]] || { echo 'usage: MINICPM_BASE_TAG=IMAGE build-base.sh' >&2; exit 2; }
[[ $(uname -m) == aarch64 ]] || { echo 'Build on an ARM64 host' >&2; exit 2; }
tag=${MINICPM_BASE_TAG:-local/eleagent-minicpm-base:candidate}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/wheels"
wheelhouse=${MINICPM_WHEELHOUSE:-$work/wheels}
[[ -d $wheelhouse ]] || { echo 'MINICPM_WHEELHOUSE must be an existing directory' >&2; exit 2; }
wheelhouse=$(realpath "$wheelhouse")
cp "$here/base-requirements.lock" "$work/base-requirements.lock"
cp "$here/install-locked.py" "$work/eleagent-install-locked.py"
docker build --build-context "wheelhouse=$wheelhouse" --platform linux/arm64 -f "$here/base.Dockerfile" -t "$tag" "$work"
docker image inspect --format '{{.Id}}' "$tag"

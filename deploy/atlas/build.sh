#!/usr/bin/env bash
# Build the pinned ARM64 runtime. No model weights or inference are involved.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tag=${ATLAS_IMAGE_TAG:-local/eleagent-atlas:production}
[[ $# == 0 ]] || { echo 'usage: ATLAS_IMAGE_TAG=IMAGE build.sh' >&2; exit 2; }
[[ $(uname -m) == aarch64 ]] || { echo 'Build on an ARM64 Spark host' >&2; exit 2; }
jobs=${ATLAS_BUILD_JOBS:-4}
[[ $jobs =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid ATLAS_BUILD_JOBS' >&2; exit 2; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
bash "$here/fetch-sources.sh" "$work/context" >/dev/null
args=(--build-arg INSTALL_TREE=f0f8a55c3da279a65316c90f221e1fc4249dda53 --build-arg "BUILD_JOBS=$jobs" -f "$work/context/install/Dockerfile")
for kind in DEVEL RUNTIME; do
  key="ATLAS_CUDA_${kind}_IMAGE"
  value=${!key:-}
  if [[ -n $value ]]; then
    [[ $value =~ ^sha256:[0-9a-f]{64}$ || $value =~ @sha256:[0-9a-f]{64}$ ]] || {
      echo "$key must use an exact image ID or repository digest" >&2; exit 2;
    }
    if [[ $value == sha256:* ]]; then
      # BuildKit interprets a bare image ID in FROM as a registry name. Resolve
      # it locally and use a content-named alias for the build base only.
      actual=$(docker image inspect --format '{{.Id}}' "$value")
      [[ $actual == "$value" ]] || { echo 'Local image identity mismatch' >&2; exit 2; }
      alias="local/eleagent-atlas-base:${kind,,}-${value#sha256:}"
      docker image tag "$value" "$alias"
      value=$alias
    fi
    args+=(--build-arg "CUDA_${kind}_IMAGE=$value")
  fi
done
for key in HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  [[ -z ${!key:-} ]] || args+=(--build-arg "$key")
done
case ${ATLAS_IMAGE_CHECKS:-1} in
  1) docker build "${args[@]}" --target checks "$work/context" ;;
  0) ;;
  *) echo 'ATLAS_IMAGE_CHECKS must be 0 or 1' >&2; exit 2 ;;
esac
docker build "${args[@]}" --target runtime -t "$tag" "$work/context"
docker image inspect --format '{{.Id}}' "$tag"

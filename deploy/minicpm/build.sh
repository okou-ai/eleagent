#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
base=${MINICPM_BASE_IMAGE:-}
cached_base=${MINICPM_CACHED_BASE_IMAGE:-}
[[ -z $base || -z $cached_base ]] || { echo 'Choose a public base or a local dependency cache, not both' >&2; exit 2; }
[[ -z $base || $base =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
  echo 'MINICPM_BASE_IMAGE must contain an immutable sha256 digest' >&2; exit 2;
}
if [[ -n $cached_base ]]; then
  cache_id=$(docker image inspect --format '{{.Id}}' "$cached_base")
  [[ $cache_id =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Local dependency image is unavailable' >&2; exit 2; }
  base="eleagent-minicpm-cache:${cache_id#sha256:}"
  docker tag "$cache_id" "$base"
  echo "Using local dependency cache $cache_id; this does not validate a fresh public base build"
fi
[[ $(uname -m) == aarch64 ]] || { echo 'Build on an ARM64 host' >&2; exit 2; }
tag=${MINICPM_IMAGE_TAG:-local/eleagent-minicpm:production}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/wheels"
wheelhouse=${MINICPM_WHEELHOUSE:-$work/wheels}
[[ -d $wheelhouse ]] || { echo 'MINICPM_WHEELHOUSE must be an existing directory' >&2; exit 2; }
wheelhouse=$(realpath "$wheelhouse")
read -r repository commit tree < <(python3 - "$here/source.lock.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); print(m['repository'],m['commit'],m['tree'])
PY
)
if [[ -n ${MINICPM_SOURCE_DIR:-} ]]; then
  [[ $(git -C "$MINICPM_SOURCE_DIR" rev-parse "$commit^{commit}") == "$commit" &&
     $(git -C "$MINICPM_SOURCE_DIR" rev-parse "$commit^{tree}") == "$tree" ]]
  mkdir "$work/source"
  git -C "$MINICPM_SOURCE_DIR" archive "$commit" | tar -x -C "$work/source"
else
  git init -q "$work/source"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$work/source" fetch -q --depth 1 "$repository" "$commit"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$work/source" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
  [[ $(git -C "$work/source" rev-parse HEAD) == "$commit" && $(git -C "$work/source" rev-parse 'HEAD^{tree}') == "$tree" ]]
  rm -rf "$work/source/.git"
fi
cp "$here/build-requirements.lock" "$work/source/eleagent-build-requirements.lock"
cp "$here/requirements.arm64.lock" "$work/source/eleagent-requirements.lock"
cp "$here/entrypoint.sh" "$work/source/eleagent-entrypoint.sh"
cp "$here/install-locked.py" "$work/source/eleagent-install-locked.py"
if [[ -n $base ]]; then
  docker build --build-context "wheelhouse=$wheelhouse" --build-arg "MINICPM_BASE_IMAGE=$base" -f "$here/Dockerfile" -t "$tag" "$work/source"
else
  # Compose the public base and application stages into one immutable build graph.
  # No mutable, machine-local base tag is needed between the two stages.
  cp "$here/base-requirements.lock" "$work/source/base-requirements.lock"
  cat "$here/base.Dockerfile" > "$work/Dockerfile"
  sed '/^# syntax=/d; /^ARG MINICPM_BASE_IMAGE$/d; s/^FROM ${MINICPM_BASE_IMAGE}$/FROM eleagent-minicpm-base/' \
    "$here/Dockerfile" >> "$work/Dockerfile"
  docker build --build-context "wheelhouse=$wheelhouse" --platform linux/arm64 -f "$work/Dockerfile" -t "$tag" "$work/source"
fi
docker image inspect --format '{{.Id}}' "$tag"

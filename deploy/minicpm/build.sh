#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
base=${MINICPM_BASE_IMAGE:-}
[[ -z $base || $base =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
  echo 'MINICPM_BASE_IMAGE must contain an immutable sha256 digest' >&2; exit 2;
}
[[ $(uname -m) == aarch64 ]] || { echo 'Build on an ARM64 host' >&2; exit 2; }
tag=${MINICPM_IMAGE_TAG:-local/eleagent-minicpm:production}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
read -r repository commit tree < <(python3 - "$here/source.lock.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); print(m['repository'],m['commit'],m['tree'])
PY
)
git init -q "$work/source"
GIT_LFS_SKIP_SMUDGE=1 git -C "$work/source" fetch -q --depth 1 "$repository" "$commit"
GIT_LFS_SKIP_SMUDGE=1 git -C "$work/source" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
[[ $(git -C "$work/source" rev-parse HEAD) == "$commit" && $(git -C "$work/source" rev-parse 'HEAD^{tree}') == "$tree" ]]
cp "$here/build-requirements.lock" "$work/source/eleagent-build-requirements.lock"
cp "$here/requirements.arm64.lock" "$work/source/eleagent-requirements.lock"
cp "$here/entrypoint.sh" "$work/source/eleagent-entrypoint.sh"
if [[ -n $base ]]; then
  docker build --build-arg "MINICPM_BASE_IMAGE=$base" -f "$here/Dockerfile" -t "$tag" "$work/source"
else
  # Compose the public base and application stages into one immutable build graph.
  # No mutable, machine-local base tag is needed between the two stages.
  cp "$here/base-requirements.lock" "$work/source/base-requirements.lock"
  cat "$here/base.Dockerfile" > "$work/Dockerfile"
  sed '/^# syntax=/d; /^ARG MINICPM_BASE_IMAGE$/d; s/^FROM ${MINICPM_BASE_IMAGE}$/FROM eleagent-minicpm-base/' \
    "$here/Dockerfile" >> "$work/Dockerfile"
  docker build --platform linux/arm64 -f "$work/Dockerfile" -t "$tag" "$work/source"
fi
docker image inspect --format '{{.Id}}' "$tag"

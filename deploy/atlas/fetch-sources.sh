#!/usr/bin/env bash
# Fetch exact upstream source trees without starting containers or models.
set -euo pipefail
[[ $# == 1 ]] || { echo 'usage: fetch-sources.sh NEW_DIRECTORY' >&2; exit 2; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
context=$1
[[ ! -e $context ]] || { echo 'Destination must not exist' >&2; exit 2; }
mkdir -p "$context"
fetch() {
  local name=$1 destination=$2 repo commit tree
  read -r repo commit tree < <(python3 - "$here/sources.lock.json" "$name" <<'PY'
import json,sys
source=json.load(open(sys.argv[1]))[sys.argv[2]]
print(source['repository'], source['commit'], source['tree'])
PY
)
  git init -q "$destination"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$destination" fetch -q --depth 1 "$repo" "$commit"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$destination" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
  [[ $(git -C "$destination" rev-parse HEAD) == "$commit" && $(git -C "$destination" rev-parse 'HEAD^{tree}') == "$tree" ]] || {
    echo 'Source identity mismatch' >&2; exit 1;
  }
}
fetch sparkglm "$context/product"
fetch engine "$context/engine"
expected=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sparkglm"]["install_tree"])' "$here/sources.lock.json")
[[ $(git -C "$context/product" rev-parse HEAD:install) == "$expected" ]]
cp -a "$context/product/install" "$context/install"
cp "$context/install/dockerignore" "$context/.dockerignore"
git -C "$context" apply --check "$here/public-native.patch"
git -C "$context" apply "$here/public-native.patch"
printf '%s\n' "$context"

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
  if [[ -n ${ATLAS_SOURCE_CACHE:-} ]]; then
    repo="${ATLAS_SOURCE_CACHE%/}/$name.git"
    [[ -d $repo ]] || { echo "Missing local source repository: $name" >&2; exit 2; }
  fi
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
if [[ -n ${ATLAS_NATIVE_ARTIFACTS_DIR:-} ]]; then
  # The Dockerfile still verifies every library against the public release hash.
  # Keep the local replacement narrow: no server executable is copied.
  python3 - "$context" "$ATLAS_NATIVE_ARTIFACTS_DIR" <<'PY'
import pathlib, shutil, sys
context, source = map(pathlib.Path, sys.argv[1:])
source = source.resolve(strict=True) / 'opt/atlas'
target = context / 'local-native/opt/atlas'
for name in ('native', 'notices'):
    shutil.copytree(source / name, target / name)
(target / 'converter').mkdir()
shutil.copy2(source / 'converter/libatlas_mtp_quantize.so', target / 'converter/libatlas_mtp_quantize.so')
dockerfile = context / 'install/Dockerfile'
text = dockerfile.read_text()
line = next(line for line in text.splitlines() if line.endswith(' AS published-native'))
text = text.replace(line, 'FROM scratch AS published-native\nCOPY local-native/opt/atlas/ /opt/atlas/', 1)
dockerfile.write_text(text)
PY
fi
printf '%s\n' "$context"

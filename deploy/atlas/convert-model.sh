#!/usr/bin/env bash
# Explicit offline provisioning step: conversion uses the GPU on this host.
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: convert-model.sh MODEL_ROOT PINNED_IMAGE_ID' >&2; exit 2; }
[[ $2 =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Use an exact local image ID' >&2; exit 2; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
bash "$here/fetch-sources.sh" "$work/context" >/dev/null
bash "$work/context/install/convert.sh" "$1" "$2"
python3 "$here/prepare-overlay.py" "$1"

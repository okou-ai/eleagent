#!/usr/bin/env bash
set -euo pipefail
out=${1:?Usage: make-media.sh OUTPUT.mp4}
ffmpeg -nostdin -hide_banner -v error -n \
  -f lavfi -i 'testsrc2=size=640x360:rate=15' \
  -f lavfi -i 'sine=frequency=440:sample_rate=16000' \
  -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$out"

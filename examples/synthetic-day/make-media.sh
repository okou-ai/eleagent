#!/usr/bin/env bash
set -euo pipefail
out=${1:?Usage: make-media.sh OUTPUT.mp4 [--speech]}
mode=${2:-}
if [[ "$mode" == --speech ]]; then
  ffmpeg -nostdin -hide_banner -v error -n \
    -f lavfi -i 'color=c=white:s=1280x720:r=15' \
    -f lavfi -i 'flite=text=We will review two designs tomorrow at ten in the morning.:voice=slt' \
    -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='DESIGN REVIEW':fontcolor=black:fontsize=58:x=(w-text_w)/2:y=220,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Tomorrow at 10 AM':fontcolor=black:fontsize=48:x=(w-text_w)/2:y=330" \
    -af apad -t 5 -c:v libx264 -preset veryfast -pix_fmt yuv420p \
    -c:a aac -ar 16000 -movflags +faststart "$out"
elif [[ -z "$mode" ]]; then
  ffmpeg -nostdin -hide_banner -v error -n \
    -f lavfi -i 'testsrc2=size=640x360:rate=15' \
    -f lavfi -i 'sine=frequency=440:sample_rate=16000' \
    -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart "$out"
else
  echo 'Usage: make-media.sh OUTPUT.mp4 [--speech]' >&2
  exit 2
fi

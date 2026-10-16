#!/usr/bin/env bash
# Start the pinned upstream backend and its worker forwarding process.
set -euo pipefail
MODEL_PATH=${MODEL_PATH:-/models/MiniCPM-o-4_5}
BACKEND_PORT=${BACKEND_PORT:-22500}
WORKER_PORT=${WORKER_PORT:-22400}
WORKER_HOST=${WORKER_HOST:-127.0.0.1}
GPU_ID=${GPU_ID:-0}
backend_url="http://127.0.0.1:$BACKEND_PORT"
cd /app
[[ -f config.json ]] || cp config.example.json config.json
[[ -d $MODEL_PATH ]] || { echo 'Model mount is missing' >&2; exit 1; }
mkdir -p /app/data /app/tmp /app/torch_compile_cache
backend_pid='' worker_pid=''
cleanup() {
  trap - EXIT SIGTERM SIGINT
  [[ -z $worker_pid ]] || kill "$worker_pid" 2>/dev/null || true
  [[ -z $backend_pid ]] || kill "$backend_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' SIGTERM SIGINT
python -m py_backend.server --host 127.0.0.1 --port "$BACKEND_PORT" \
  --gpu-id "$GPU_ID" --model-path "$MODEL_PATH" &
backend_pid=$!
loaded=0
for ((attempt=0; attempt<300; attempt++)); do
  kill -0 "$backend_pid" 2>/dev/null || { echo 'Backend exited during startup' >&2; exit 1; }
  if curl -fsS "$backend_url/health" >/dev/null 2>&1; then loaded=1; break; fi
  sleep 2
done
[[ $loaded == 1 ]] || { echo 'Backend readiness deadline exceeded' >&2; exit 1; }
python worker.py --host "$WORKER_HOST" --port "$WORKER_PORT" --gpu-id "$GPU_ID" \
  --backend-server-url "$backend_url" &
worker_pid=$!
# Any child exit ends the bundle, so Docker restarts both processes together.
set +e
wait -n "$backend_pid" "$worker_pid"
status=$?
set -e
exit "$status"

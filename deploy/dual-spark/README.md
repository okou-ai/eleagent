# Dual-Spark reference deployment

This recipe places capture and graph services on Spark 1, and storage and recognition on Spark 2. It uses Linux host networking and private IPv4 addresses. A generic HTTPS reverse proxy on Spark 1 forwards the public web origin to `127.0.0.1:8080`; the browser uploads directly to `/`. The archive, database, model servers, and GPU manager are internal services.

These files are an open-source deployment candidate. CPU service checks and ARM64 dependency resolution have passed, but a complete clean-machine build and two-host acceptance run remain outstanding. The MiniCPM image is built separately from its pinned public CUDA base and dependency locks; see `../minicpm/README.md`. Its upstream application license remains unresolved. Do not assume that a missing local image can be pulled from a registry.

## Prerequisites

- Two Linux ARM64 Spark hosts with Docker Engine, Docker Compose 2.30 or newer, and NVIDIA Container Toolkit.
- A private network between the hosts, plus the network interface and HCA required by the Atlas runtime.
- The same repository revision on both hosts, installed at `/opt/eleagent` if using the supplied systemd unit unchanged.
- Model files prepared under `MODEL_ROOT` using `../models.lock.json` and the model download instructions.
- A host account with UID/GID 1000 and Docker access. The observer, recognition, speech, sleep, and GPU-manager processes must share UID 1000: pause, acknowledgement, readiness, and control-token files deliberately use mode 0600. Configure the supplied systemd unit's `User` and `Group` to that account. If choosing another UID, change all affected containers and host services together, including the sleep image's file ownership.

## Private configuration

From this directory, copy `.env.example` to `.env` and make it private. The following creates independent credentials without printing them:

```sh
cp .env.example .env
chmod 600 .env
python3 - <<'PY'
from pathlib import Path
import secrets
path = Path('.env')
text = path.read_text()
for key in ('SCENE_API_TOKEN', 'SCENE_ARCHIVE_TOKEN', 'GRAPH_API_TOKEN', 'NEO4J_PASSWORD'):
    text = text.replace(key + '=\n', key + '=' + secrets.token_hex(32) + '\n')
path.write_text(text)
path.chmod(0o600)
PY
```

Edit `SPARK1_ADDRESS` and `SPARK2_ADDRESS` to the hosts' private IPv4 addresses. Keep credentials, host addresses, and timezone identical on both hosts; `DATA_ROOT` and `MODEL_ROOT` may differ if storage is laid out differently. Transfer the populated `.env` privately to the other host. Never commit it or share rendered Compose configuration, because interpolation includes credentials.

The `SCENE_API_TOKEN` is the browser upload token. The archive and graph API use separate tokens. The Neo4j password is only for internal database clients. Existing `SCENE_*` variable names remain for compatibility.

## Storage and permissions

The commands below use the example root `/srv/eleagent`; adjust them when changing `.env`.

On both hosts:

```sh
sudo install -d -m 0755 /srv/eleagent/data /srv/eleagent/models
sudo install -d -m 0700 -o 1000 -g 1000 /srv/eleagent/data/gpu-manager
```

On Spark 1:

```sh
sudo install -d -m 0750 -o 1000 -g 1000 /srv/eleagent/data/observer /srv/eleagent/data/sleep
sudo install -d -m 0750 -o 7474 -g 7474 /srv/eleagent/data/neo4j/data /srv/eleagent/data/neo4j/logs
sudo install -d -m 0750 /srv/eleagent/data/minicpm-cache
```

On Spark 2:

```sh
sudo install -d -m 2750 -o 10001 -g 10001 /srv/eleagent/data/archive
sudo install -d -m 0750 -o 1000 -g 1000 /srv/eleagent/data/recognition
```

The archive runs as UID 10001. Graph Sync runs as UID 1000 with supplementary group 10001, which allows it to read the archive directory and its SQLite WAL files. Recognition and Graph Sync share a writable recognition directory. Preserve group-readable permissions on archive database files; do not copy only the main SQLite file while its WAL is active.

Model mounts must be readable by their service accounts. Expected directories are:

| Host | Path below `MODEL_ROOT` | Purpose |
| --- | --- | --- |
| Spark 1 | `MiniCPM-o-4_5` | Daytime perception |
| Spark 2 | `entities` | Face/object weights, manifests, and `voice_silero.jit` |
| Spark 2 | `campplus` | Speaker embedding model |
| Spark 2 | `qwen3-asr-1.7b` | Speech transcription |
| Spark 2 | `ocr` | Three checksum-pinned OCR ONNX files |
| Both | The Atlas converted-model root passed to the manager | Nighttime GLM and drafter |

## Host GPU managers

The managers run as systemd host services, outside Compose. Prepare the Atlas image and converted model layout first; read `../atlas/README.md` and `../../runtime/gpu-manager/README.md`.

Generate one control token in the UID-1000 account and copy exactly the same file privately to the other host:

```sh
python3 - <<'PY'
from pathlib import Path
import os, secrets
path = Path('/srv/eleagent/data/gpu-manager/control.secret')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(secrets.token_hex(32) + '\n')
PY
```

Use `runtime/gpu-manager/generate-config.py` to generate each host's configuration. Supply actual private bind addresses, the rank-0 fabric address, the immutable Atlas image ID, the fabric interface/HCA, the converted model root, and the same timezone used by Compose. The generator refuses to replace an existing configuration.

| Generator argument | Spark 1 | Spark 2 |
| --- | --- | --- |
| `--role` | `s1` | `s2` |
| `--data-dir` | `DATA_ROOT/observer` | `DATA_ROOT/recognition` |
| `--state-dir` | `DATA_ROOT/gpu-manager` | `DATA_ROOT/gpu-manager` |
| `--output` | `/etc/eleagent/gpu-manager.json` | `/etc/eleagent/gpu-manager.json` |

Generate a configuration as the UID-1000 account. Load the private, owner-authored `.env` into the shell, then supply the local role and fabric values. The Atlas model root is the directory containing the converted overlay and drafter described in the Atlas guide.

```sh
set -a
. ./.env
set +a
# Choose s1 on Spark 1, or s2 on Spark 2.
HOST_ROLE=s1
ATLAS_IMAGE_ID=$(docker image inspect --format '{{.Id}}' local/eleagent-atlas:production)
# Set these to the fabric and converted-model values for the actual machines.
ATLAS_LEADER_ADDRESS='<rank-0-private-fabric-address>'
ATLAS_FABRIC_INTERFACE='<interface-name>'
ATLAS_FABRIC_HCA='<hca-name>'
ATLAS_MODEL_ROOT='<absolute-converted-model-root>'
if [ "$HOST_ROLE" = s1 ]; then
  MANAGER_BIND_ADDRESS=$SPARK1_ADDRESS
  WORKER_DATA_DIR=$DATA_ROOT/observer
else
  MANAGER_BIND_ADDRESS=$SPARK2_ADDRESS
  WORKER_DATA_DIR=$DATA_ROOT/recognition
fi
sudo install -d -m 0750 -o 1000 -g 1000 /etc/eleagent
python3 ../../runtime/gpu-manager/generate-config.py \
  --role "$HOST_ROLE" --bind-address "$MANAGER_BIND_ADDRESS" \
  --leader-address "$ATLAS_LEADER_ADDRESS" --image-id "$ATLAS_IMAGE_ID" \
  --data-dir "$WORKER_DATA_DIR" --model-root "$ATLAS_MODEL_ROOT" \
  --repo-dir /opt/eleagent --state-dir "$DATA_ROOT/gpu-manager" \
  --fabric-interface "$ATLAS_FABRIC_INTERFACE" --fabric-hca "$ATLAS_FABRIC_HCA" \
  --timezone "$ELEAGENT_TIMEZONE" --output /etc/eleagent/gpu-manager.json
sudo install -m 0644 ../../runtime/gpu-manager/eleagent-gpu-manager.service /etc/systemd/system/
```

The angle-bracket values above are required inputs, not executable defaults. Confirm the Atlas image tag from its build output before inspecting it. Set the unit's `User` and `Group` to the actual UID/GID-1000 account using `sudo systemctl edit --full eleagent-gpu-manager.service`. Then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now eleagent-gpu-manager.service` on each host.

Install the supplied unit after setting its account and repository paths. The account must own the mode-0600 manager configuration and control token. Spark 1's sleep container mounts the token read-only. The manager stops only `eleagent-minicpm` on Spark 1 and `eleagent-recognition`/`eleagent-speech` on Spark 2. The observer and CPU services continue running.

The reference window starts at 00:30, permits acquisition before 05:00, and ends at 05:30 in `ELEAGENT_TIMEZONE`. Keep these values consistent with the generated manager configuration. In the default Los Angeles timezone, calendar dates follow local daylight-saving rules.

## Build and start

Prepare the MiniCPM image, Atlas image, model files, managers, and storage before starting the complete stack. From this directory, inspect and build the CPU components without starting any service:

```sh
docker compose --env-file .env -f compose.spark1.yaml config --quiet
docker compose --env-file .env -f compose.spark1.yaml build observer graph-api sleep
docker compose --env-file .env -f compose.spark2.yaml config --quiet
docker compose --env-file .env -f compose.spark2.yaml build archive text graph-sync
```

Build `recognition` and `speech` on Spark 2. Their locked ARM64 dependencies include public CUDA 13 wheels. Upstream speech tokenizer dependencies may compile from source.

Start Spark 2's services, then Spark 1's services on their respective hosts:

```sh
# Spark 2
docker compose --env-file .env -f compose.spark2.yaml up -d --build
# Spark 1
docker compose --env-file .env -f compose.spark1.yaml up -d --build
```

Compose does not build MiniCPM or Atlas, nor install the host managers. Starting the stack enables the nightly scheduler; prepare both managers before starting `sleep`. Keep the private ports restricted to the intended hosts. Only the HTTPS reverse proxy should be reachable by capture clients.

| Listener | Bind / reachability |
| --- | --- |
| Web capture | Spark 1 loopback `8080`, behind the HTTPS reverse proxy |
| Graph API | Spark 1 loopback `22403`, optionally behind an authenticated HTTPS route |
| MiniCPM worker / backend | Spark 1 loopback `22400` / `22500` |
| Neo4j Bolt | Spark 1 private address, `7687`; HTTP console disabled |
| Archive | Spark 2 private address, `22401` |
| GPU managers | Each host's private address, `9210`; bearer authenticated |
| GLM HTTP | Spark 1 loopback `8893` during sleep |
| Metrics | Host loopback, ports specified in each Compose service |

Do not delete or recreate the persistent data directories when updating images. Archive recordings, recognition state, graph data, and sleep state are user data; build caches and model downloads are separate.

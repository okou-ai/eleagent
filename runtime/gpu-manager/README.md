# Host GPU manager

A Python 3.11+ host service owns the handoff between daytime perception and the
nighttime Atlas ranks. It uses the Docker CLI and socket; this is a privileged
control plane. Run only on the dedicated hosts, bound to an explicitly configured
private IPv4 address. Do not expose port 9210 to the public internet.

Generate configuration with `generate-config.py` using the host paths described
in `deploy/dual-spark`. Each host uses its own
state file, an exclusive process lock, and a shared control token stored in a
regular mode-0600 file. The manager and paused workers must share UID 1000
because lease and acknowledgement files are also mode 0600. Keep timezone and acquisition window settings identical
to the Sleep scheduler. Windows must start and end within one local calendar day.

## Configuration contract

- `listen_ip`, `allowed_bind_addresses`, optional `port` (9210): binding and
  explicit private-address allowlist; wildcard and public binds are rejected.
- `secret_file`, `state_file`: absolute token and durable state paths.
- `timezone`, `acquire_start_minute`, `acquire_end_minute`, `hard_stop_minute`:
  IANA timezone and ordered minutes since midnight, such as 30, 300, and 330.
- `daytime_containers`: the exact GPU containers to stop and later restore.
- `rank_name`, `rank_image`: exact name and Docker image ID (`sha256:...`).
- `rank_label`: `{ "key": "org.eleagent.gpu", "value": "sleep-glm" }`.
- `rank_create_command`: fixed local argv for `deploy/atlas/create-rank.sh`.
- `pause_files`, `drain_commands`, `ready_commands`: cooperative handoff hooks.
- `host_role`: `s1` or `s2`; `data_dir`: shared worker marker directory.
- `pause_workers`: marker-key-to-container-name map. On s1, map `minicpm` to
  `eleagent-observer`; on s2, map `entity` and `speech` to their worker containers.
- `minicpm_health_url`: s1's trusted internal MiniCPM worker `/health` endpoint.
- `drain_timeout_seconds`: 600 by default; `lease_ttl_seconds` must remain 120.
- `min_available_gib`: at least 4; `recovery_available_gib`: at least 64.

Use `python3 drain.py --config /path/to/manager.json` and the same invocation for
`ready.py` in the hooks. Neither command performs inference. Readiness markers
must belong to the current container process, not merely the same container ID.

## Control API

All routes require `Authorization: Bearer <control-token>`.

- `GET /status` reports phase and lease identity.
- `POST /acquire`, `/heartbeat`, `/start`, `/release` accept only
  `{ "lease": "<canonical UUID>" }` (maximum 256 bytes).

The scheduler renews the lease every 15 seconds. Acquire both hosts, wait for
`prepared`, then start rank 1 before rank 0. A hard deadline, expired lease,
low memory, host OOM, or manager restart triggers restoration. Original Docker
restart policies and running states are captured durably. Paused workers resume
only after the captured daytime processes are healthy again. HTTP requests never
supply shell commands or model paths.

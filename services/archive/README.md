# Media archive

The archive retains original media bytes and an append-only timeline in SQLite. It is an internal service: the observer validates uploaded media before forwarding it here. Recognition workers and the sleep agent retrieve media, frames, audio, and source references through the authenticated `/v1/archive` API.

Build with `docker build -t eleagent-archive services/archive` from the repository root. The container serves port 8090 and runs as UID 10001. Mount writable storage at `/data/archive`, owned by that UID.

Required environment:

- `SCENE_ARCHIVE_TOKEN`: a generated bearer token of at least 16 characters, shared with authorized internal clients.

Optional environment:

- `SCENE_ARCHIVE_ROOT`: original media directory; default `/data/archive/media`.
- `SCENE_ARCHIVE_DB`: SQLite path; default `/data/archive/archive.sqlite3`.
- `SCENE_ARCHIVE_RESERVE_BYTES`: free-space reserve; default 100 GiB. Choose an appropriate reserve for the actual disk.
- `METRICS_PORT`: enable the metrics listener when set.

The existing `SCENE_*` configuration names and `/v1/archive` routes are preserved for service compatibility. Database files, recordings, and runtime credentials do not belong in the repository. Public browser capture is provided by the web entrypoint, not this internal API.

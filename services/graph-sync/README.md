# Graph synchronization

`graph_sync.py` reads committed media and timeline events from the archive's SQLite database, applies recognition retention decisions, and incrementally consolidates them into Neo4j. It preserves sleep-authored memories and natural-language links. It shares retention logic and metrics with `services/recognition/entity_worker`.

Build from the repository root:

```sh
docker build -f services/graph-sync/Dockerfile -t eleagent-graph-sync .
```

The default command runs every 60 seconds. Pass `0` for one synchronization cycle.

Configuration:

| Variable | Default / purpose |
| --- | --- |
| `GRAPH_URL` | `bolt://neo4j:7687` |
| `NEO4J_AUTH` | Required `username/password` credential string |
| `ARCHIVE_DB` | `/archive/archive.sqlite3`; mount the archive directory read-only, including WAL files |
| `ENTITY_STATE_PATH` | `/entities/entities.sqlite`; writable recognition state for retention handoff |
| `ELEAGENT_TIMEZONE` | `America/Los_Angeles`; IANA timezone used for human-readable summaries |
| `RECOGNITION_SOURCE_DIR` | Location of the shared recognition package; set by the container |
| `METRICS_PORT` | Optional metrics listener |

Raw media stays in the archive. The graph contains a navigable index plus memories authored by the sleep agent. Run exactly one coordinator for a given archive and graph pair.

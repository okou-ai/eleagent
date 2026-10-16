# Eleagent

**An elephant's memory. An agent's mind.**

A self-hosted personal memory system. Capture audio and video in a browser, retain the original evidence, organize observations into a graph, and consolidate the day into memories and a diary during a scheduled sleep cycle.

Eleagent is an experimental reference implementation. Its initial hardware profile uses two NVIDIA DGX Spark systems: daytime perception shares the GPUs with a larger model at night.

![Eleagent architecture: daytime parallel video perception and nighttime Pi memory consolidation, with model allocation on DGX Spark 1 and 2](docs/images/architecture.png)

## Capture

The web application and upload endpoint share an origin:

- `GET /` serves the capture interface.
- `POST /` accepts a multipart `meta` JSON field and a `video` file, authenticated with a bearer token.
- Successful responses acknowledge durable archival. Repeating the same capture ID, sequence and content is idempotent.

The browser records separate short clips and uploads them in order. Keep the page in the foreground. Screen Wake Lock requests an awake display; it cannot prevent a deliberate lock or guarantee background recording. Interrupted capture is shown explicitly. Use HTTPS on phones. iOS 18.4 or later is recommended for home-screen use.

To deploy, follow the [agent deployment runbook](docs/agent-runbook.md).

## Read-only MCP

The graph HTTP server exposes **`POST /mcp`** using stateless MCP Streamable HTTP (JSON responses). Connect a standard MCP client to the graph API origin plus `/mcp`; **no client authentication is required**. Anyone who can reach this endpoint can query the graph and download originals. GET/SSE and DELETE sessions are not used. Existing `/v1/graph` REST endpoints remain available with their existing Bearer authentication; capture upload and internal archive authentication are unchanged.

| Tool | Purpose |
| --- | --- |
| `search_entities` | Search property text, filter exact properties, sort and paginate |
| `get_entity` | Read one entity by ID |
| `list_entity_links` | Page through an entity's relationships and adjacent entities |
| `get_subgraph` | Bounded graph expansion with explicit truncation |
| `list_video_clips` | List original clips by capture, UTC/time-offset interval or graph `entity_id` |
| `get_video_clip` | Read clip metadata and a public original-download URL |

Graph evidence refers to originals through stable `media_id` values, not filesystem paths. Media references distinguish full clips, timestamped intervals and representative points; a representative frame does not prove an entire event. Use `list_video_clips` with `entity_id`, then `get_video_clip` with a returned `media_id`. Missing source files/references are reported rather than silently substituted. Graph model interpretations are not verified facts.

Original URLs use the same graph origin (`/v1/archive/media/{media_id}/original`); downloads **do not require a token**. GET, HEAD and byte ranges stream from Spark-2 without embedding large video blobs in MCP JSON. The graph server injects its separate archive credential internally. Never put credentials in URLs. `ARCHIVE_URL` and `SCENE_ARCHIVE_TOKEN` enable archive access; the dual-Spark Compose configuration supplies them. No public archive port or additional database writes are required.

Non-browser MCP clients work without Origin. Browser clients are denied by default: explicitly allow trusted exact origins through comma-separated `MCP_ALLOWED_ORIGINS`; do not use a wildcard. All six tools are read-only; arbitrary Cypher, ingestion and memory mutation are not exposed.

## Repository

| Path | Responsibility |
| --- | --- |
| `apps/web` | Browser capture and bounded local upload queue |
| `services/observer` | Upload ingress and MiniCPM observation scheduling |
| `services/archive` | Original media and timestamped evidence |
| `services/recognition` | Face, object, speech and OCR workers |
| `services/graph-api` | Read API for the memory graph |
| `services/graph-sync` | Incremental graph synchronization |
| `services/sleep` | Pi memory tools, prompts and nightly consolidation |
| `runtime/gpu-manager` | Host GPU leases, draining and recovery |
| `deploy` | Versioned model and hardware recipes |

The local model route has a configured 524,288-token context window.

## Licensing

Original project code is AGPL-3.0-only unless a file states otherwise. Dependencies retain their own licenses. Model weights are obtained separately and are not covered by this repository's license.

**The DFlash2 draft weights in the experimental accelerated recipe use CC BY-NC-ND 4.0.** This recipe is not an unrestricted commercial model stack. Downloading weights yourself does not remove their license conditions. The pinned MiniCPM demo application also lacks an explicit source license; resolve its redistribution terms separately. See [third-party notices](THIRD_PARTY_NOTICES.md) and the model manifest before choosing a deployment.

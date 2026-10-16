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

The graph HTTP server exposes **`POST /mcp`** using stateless MCP Streamable HTTP (JSON responses), protected by Better Auth OAuth and a dedicated SQLite database. Connect an OAuth-capable MCP client to the configured public origin plus `/mcp`, sign in in the browser, and approve access. GET/SSE and DELETE sessions are not used. Existing `/v1/graph` REST endpoints and original downloads require OAuth access tokens too; capture upload and internal archive credentials are unchanged.

| Tool | Purpose |
| --- | --- |
| `search_entities` | Search property text, filter exact properties, sort and paginate |
| `get_entity` | Read one entity by ID |
| `list_entity_links` | Page through an entity's relationships and adjacent entities |
| `get_subgraph` | Bounded graph expansion with explicit truncation |
| `list_video_clips` | List original clips by capture, UTC/time-offset interval or graph `entity_id` |
| `get_video_clip` | Read clip metadata and a protected original-download URL |

Graph evidence refers to originals through stable `media_id` values, not filesystem paths. Media references distinguish full clips, timestamped intervals and representative points; a representative frame does not prove an entire event. Use `list_video_clips` with `entity_id`, then `get_video_clip` with a returned `media_id`. Missing source files/references are reported rather than silently substituted. Graph model interpretations are not verified facts.

Original URLs use the same graph origin (`/v1/archive/media/{media_id}/original`); send the OAuth access token in the Authorization header with the `media:read` scope. GET, HEAD and byte ranges stream from Spark-2 without embedding large video blobs in MCP JSON. The graph server injects its separate archive credential internally. Never put credentials in URLs. `ARCHIVE_URL` and `SCENE_ARCHIVE_TOKEN` enable archive access; the dual-Spark Compose configuration supplies them. No public archive port or additional database writes are required.

Non-browser MCP clients work without Origin. The configured public origin is trusted for browser requests; allow additional exact origins through comma-separated `MCP_ALLOWED_ORIGINS`, never a wildcard. Graph tools/REST require `graph:read`; video tools/downloads require `media:read`. All six tools are read-only; arbitrary Cypher, ingestion and memory mutation are not exposed.

### OAuth configuration and owner setup

- Set **`AUTH_PUBLIC_URL=https://memory.example.com`** to the externally reachable canonical origin (not a path). It is a required configuration value, not a hardcoded domain. The service fails closed if OAuth configuration is absent. HTTPS is mandatory outside loopback development.
- Persist `DATA_ROOT/auth` on Spark-1, owned by container UID 1000 and mode 0700. Create `DATA_ROOT/auth/secret` with at least 32 cryptographically random characters, mode 0600; keep it stable. Compose mounts this directory for `auth.sqlite`, WAL state, signing keys and the secret. It is separate from media, the archive database and Neo4j.
- Public signup is disabled. Visit `/auth/setup` once and supply the existing **`GRAPH_API_TOKEN` as the setup key**, your email and a new password. Set `AUTH_OWNER_EMAIL` to restrict the owner email. The setup key is entered only in the form, never a URL; it does not authorize MCP or downloads. Only the first owner can be provisioned.
- `/auth/sign-in` and `/auth/consent` complete authorization-code + S256 PKCE login/consent. `/auth/account` lists connected applications and lets the owner revoke access. Discovery is served at the standard `.well-known` URLs. Existing clients can use explicit dynamic registration; CIMD uses the official SSRF-safe Node transport.
- Resource-bound opaque access tokens are stored hashed and checked against live provider state for issuer, audience, expiry, scopes and active consent; access revoked from the account page stops working. Refresh tokens rotate. The JWT plugin persists signing keys for OAuth discovery, but access authorization does not rely on an irrevocable JWT-only cache. Cookies are not accepted as MCP access tokens; the setup key and internal archive key are not alternate OAuth credentials.
- Run **one graph-api process/instance per auth SQLite database** (the supplied Docker command does this). OAuth issuance and revocation are serialized in that process; do not add cluster workers or share this database with another writer. Revocation removes outstanding authorization codes as well as access/refresh tokens; narrowing consent also invalidates older credentials, so later reconsent cannot revive them. Provider upgrades require rerunning these schema-coupled revocation tests.
- Back up the entire private auth directory consistently, including SQLite WAL, while graph-api is stopped (or use a SQLite online backup). Restore it together with the same secret. Do not put auth databases, passwords or keys in the repository or published artifacts.
- Changing `AUTH_PUBLIC_URL` changes the OAuth issuer/resource. Update the public proxy/tunnel and this configuration together; clients must reconnect and authorize again. Temporary tunnel domains can be configured for testing but are not stable production identities.

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

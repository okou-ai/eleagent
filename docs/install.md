# Installation

Eleagent is an experimental two-host reference system. The initial profile targets two NVIDIA DGX Spark machines running Linux ARM64. It does not include model weights, personal recordings, credentials, or a hosted account.

Before replacing an existing deployment, make and verify a [consistent backup](backup-and-restore.md). Use empty data directories for deployment acceptance.

Agents performing an installation or migrating an existing deployment should follow the [agent deployment runbook](agent-runbook.md). It orders these steps and adds the data migration and cutover procedure.

## Prepare the stack

1. Clone this repository onto both hosts at the same revision.
2. Read [third-party notices](../THIRD_PARTY_NOTICES.md), especially the draft-model restrictions and the unresolved MiniCPM demo application license. The perception recipe includes a digest-pinned public CUDA base and locked ARM64 dependencies. The local-asset path has passed service builds, daytime inference, fresh Atlas conversion on both hosts, a scheduled GLM/Pi Sleep run and automatic daytime recovery. A full build using only fresh public downloads remains unverified; this is not yet a one-command installation.
3. Follow [the dual-Spark deployment guide](../deploy/dual-spark/README.md) to generate private credentials, create storage, prepare model files, build images, and configure the host GPU managers.
4. Start the internal services with the two supplied Compose files. Expose only the web origin to capture clients. The internal archive, graph database, model servers, and GPU control ports belong on the private network.
5. Add HTTPS in front of Spark 1's loopback observer listener, then open `/` in your phone's browser.

No inference benchmark or model download runs automatically when cloning the repository or checking source syntax. Starting `sleep` enables its nightly schedule; prepare both host managers first.

## HTTPS for the browser

Camera and microphone access require a secure context on phones. A generic reverse proxy can terminate TLS and forward every path, including `POST /`, to the observer. For example, install Caddy on Spark 1 and replace the hostname below with a domain you control:

```caddyfile
capture.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Point that domain at your server and arrange the certificate challenge and firewall rules for your network. A private VPN and a certificate trusted by the phone are another option. Do not disable browser certificate validation.

The page itself is public and contains no personal records. Uploads require the independently generated `SCENE_API_TOKEN`. Enter that value in the page's **Access token** field; the application keeps it in memory for the current visit. Archive reads and graph API reads use separate credentials and are not routed through the capture page.

## Capture a day

Allow the camera and microphone, optionally enable location, then tap **Start recording**. Keep the page visible. The browser requests Screen Wake Lock and shows whether it was granted. Switching apps, locking the phone, or losing capture permissions pauses recording. Return to the page and explicitly resume.

Clips are buffered in IndexedDB until the server confirms durable archival. The queue is bounded; recording pauses before it fills. Do not clear browser data while uploads are pending. The page is an installable foreground web interface, not an operating-system background recorder. See [capture protocol](capture.md).

## Check a deployment

See the dated [deployment validation record](deployment-validation.md) for the exercised local-asset path and its remaining boundaries.

- Open `GET /` and the browser's developer console. The page should load with no external script dependencies.
- An unauthenticated `POST /` should return `401`.
- Use a short test recording and a separate empty test archive for upload checks. Do not insert test recordings into a personal memory database.
- Confirm the archive stores MP4/WebM with the correct content type and duplicate uploads return the same durable receipt.
- Confirm each GPU manager reports its actual daytime state before enabling the sleep scheduler.

The repository's focused checks cover source syntax, upload and archive contracts, browser state transitions, graph reads, and local-calendar handling. The separate two-host validation used verified local assets for real daytime inference, fresh Atlas conversion and a scheduled Sleep run with image checks and persisted memories. Neither establishes phone-specific recording reliability, model accuracy or a build using only fresh public downloads. See [limitations](limitations.md).

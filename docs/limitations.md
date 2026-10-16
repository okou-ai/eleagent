# Current boundaries

- The browser is a foreground recorder. Switching apps, a deliberate screen lock, browser eviction, low power, or revoked device permissions can interrupt capture. Returning to the page requires checking its state; missing intervals are not reconstructed.
- Camera and microphone access require HTTPS and browser permission. Audio/video container support varies by browser. Clips are separately finalized, so small capture gaps can occur between segments.
- Browser storage is bounded and may be evicted by the operating system. An upload is durable only after the archive acknowledges it. The UI must distinguish recorded, queued and archived data.
- Location collection is optional. Device motion is not collected by the initial web client.
- Source observations, speaker clusters, OCR and image descriptions can be wrong. The diary is an interpretation with source references, not a verified factual record. Prompt changes are not evidence that hallucinations have been eliminated.
- The initial model recipe targets two Linux ARM64 DGX Spark hosts with a direct fabric connection. Other hardware is not validated. Building the public recipes from a clean machine is a separate release check from running the original deployment.
- Sleep currently has one owner and one scheduled nightly lease. It is not a multi-tenant service. Keep archive, graph and GPU control ports on trusted private networks.
- Synthetic examples are authored fixtures, not measured model outputs or a public accuracy benchmark.

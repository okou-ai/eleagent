# Capture protocol

Serve the web UI and ingest endpoint at the same HTTPS origin. Configure `SCENE_API_TOKEN` on the observer and enter that access token in the capture page. The token is not embedded in public assets.

To prefill the token, open `https://your-host.example/#token=<URL-encoded-access-token>` or encode that URL in a private QR code. The page reads and removes the fragment before initialization; fragments are not sent to the server. The token remains in memory for the current visit, and pending uploads resume when connected. Recording still requires tapping **Start recording**.

## Upload

`POST /` with `Authorization: Bearer <access-token>` and multipart fields:

- `meta`: JSON describing capture identity, sequence, capture start and end timestamps, and optional location readings.
- `video`: one independently decodable audio/video segment. The browser negotiates an available MP4 or WebM recorder format.

Example metadata (fictional):

```json
{
  "capture_id": "synthetic-sf-workday",
  "clip_seq": 0,
  "captured_at": "2026-04-14T08:35:00-07:00",
  "captured_end_at": "2026-04-14T08:35:05-07:00",
  "camera": "back",
  "source": "browser_media_recorder",
  "capture_gaps": [],
  "locations": []
}
```

Client wall-clock timestamps are estimates, not hardware-synchronized evidence. A segment is acknowledged only after durable archival. Retrying an identical segment preserves identity. Reusing an identity for different bytes or a different capture timestamp returns a conflict.

The capture client keeps access credentials out of media metadata and limits its local queue. Failed requests retain their original identity. When the queue reaches its limit, recording must pause rather than silently dropping old recordings.

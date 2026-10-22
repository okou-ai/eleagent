// Clips are PUT to the Blob API (https://vercel.com/api/blob/?pathname=...), the host the SDK signs uploads for; reads of
// private blobs go to <store>.private.blob.vercel-storage.com.
export const CAPTURE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "media-src 'self' blob:",
  "connect-src 'self' https://vercel.com/api/blob/ https://*.blob.vercel-storage.com", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

// The recording page. Its script and styles live in /public/capture; app.js drives the camera, the local clip queue
// (IndexedDB) and uploads.
export const CAPTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Eleagent">
  <title>Eleagent</title>
  <link rel="icon" href="/capture/icon.svg" type="image/svg+xml">
  <link rel="manifest" href="/capture/manifest.webmanifest">
  <link rel="stylesheet" href="/capture/style.css">
  <script type="module" src="/capture/app.js"></script>
</head>
<body>
  <main>
    <video id="preview" autoplay playsinline muted aria-label="Camera preview"></video>
    <p id="status" class="status" role="status" aria-live="polite"></p>
    <div class="controls">
      <button id="shutter" class="shutter" aria-label="Record" disabled><span></span></button>
      <button id="flip" class="flip" aria-label="Switch camera" disabled>
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 10.5A7.6 7.6 0 0 0 6 6.3L4.5 7.8"/><path d="M4.5 3.5v4.3h4.3"/><path d="M4.5 13.5A7.6 7.6 0 0 0 18 17.7l1.5-1.5"/><path d="M19.5 20.5v-4.3h-4.3"/></svg>
      </button>
    </div>
  </main>
</body>
</html>
`;

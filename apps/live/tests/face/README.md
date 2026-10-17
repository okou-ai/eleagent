# Face pipeline parity (browser vs server OpenCV)

Checks that `apps/live/face.js` + onnxruntime produce the same detections and SFace embeddings as the server
(`services/recognition/entity_worker/faces.py`, opencv-python-headless 5.0.0.93) for identical input pixels.

- `opencv_reference.py` resizes each image (longer side 320 and 640, `INTER_AREA`, plus one top-left edge crop),
  writes the frames as PNG, runs `cv2.FaceDetectorYN` (0.9 / 0.3 / 5000) and `cv2.FaceRecognizerSF`
  (`alignCrop` + `feature` + L2 normalise), and dumps the raw YuNet outputs to `reference.json`.
- `parity.mjs` loads the same PNGs and checks: detection count equal, box IoU >= 0.95, landmark error <= 1.5 px,
  embedding cosine >= 0.995, identity match via `matchIdentity`, plus two isolated checks: `decodeYunet` on OpenCV's
  raw outputs must equal `detect()` bit-for-bit, and `alignmentMatrix` + `warpAffineBilinear` are diffed per pixel
  against `alignCrop`. Exits 1 on failure.

## Run

```sh
# one-time setup, everything outside the repo
python3 -m venv /tmp/live-venv && /tmp/live-venv/bin/pip install opencv-python-headless==5.0.0.93 onnx numpy
mkdir -p /tmp/live-node && (cd /tmp/live-node && npm init -y && npm install onnxruntime-node pngjs)
python3 services/recognition/download_models.py --weights-dir /tmp/live-models   # pinned revision + sha256
mkdir -p /tmp/live-face-images/src   # download the images below into this directory

/tmp/live-venv/bin/python apps/live/tests/face/opencv_reference.py   # -> /tmp/live-face-images/out
node apps/live/tests/face/parity.mjs                                # LIVE_FACE_DEPS=/tmp/live-node by default
```

## Test images (public domain, NASA, via Wikimedia Commons; 1280px renditions)

| file | source |
| --- | --- |
| `sally_ride_1984.jpg` | https://commons.wikimedia.org/wiki/File:Sally_Ride_(1984).jpg |
| `mae_jemison.jpg` | https://commons.wikimedia.org/wiki/File:Mae_Carol_Jemison.jpg |
| `apollo11_crew.jpg` (3 faces) | https://commons.wikimedia.org/wiki/File:Apollo_11_Crew.jpg |
| `gemini8_crew.jpg` (2 faces, 640x480 original) | https://commons.wikimedia.org/wiki/File:Gemini_8_crew.jpg |

Direct downloads: `https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Sally_Ride_%281984%29.jpg/1280px-Sally_Ride_%281984%29.jpg`,
`.../thumb/5/55/Mae_Carol_Jemison.jpg/1280px-Mae_Carol_Jemison.jpg`, `.../thumb/3/3d/Apollo_11_Crew.jpg/1280px-Apollo_11_Crew.jpg`,
`https://upload.wikimedia.org/wikipedia/commons/3/3f/Gemini_8_crew.jpg`.

## Notes

- Parity holds only for the same input frame. The server detects and aligns on the full sampled frame; detecting
  at 320 px instead moves the landmarks enough to change the embedding (cosine 0.65-0.97 against the full-resolution
  embedding on these images). Run YuNet at the resolution the server sees, or at least align on the full frame.
- OpenCV 5.0 `warpAffine` (INTER_LINEAR, 8UC3) uses float32 coordinates and weights with FMA, not the old
  fixed-point tables; `warpAffineBilinear` follows that and is pixel-identical here. For reference, OpenCV 4.10's
  fixed-point `alignCrop` differs on ~10% of channel values (max 4 levels), embedding cosine still >= 0.9997.

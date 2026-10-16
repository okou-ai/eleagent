# A fictional San Francisco workday

All people, the employer, conversations, media and events in this example are invented. They are not anonymized production records. San Francisco neighborhoods are public setting references, not a person's actual address or location history.

Alex Rivera is a fictional designer working at the explicitly fictional **Example Design Studio** in SoMa, San Francisco, California. Maya is a fictional coworker. The timeline uses `America/Los_Angeles` with the applicable UTC-07:00 offset.

- `observations.json` contains authored source excerpts.
- `expected-diary.md` demonstrates an evidence-bounded account. It is written by the example author, not produced by a measured model run.
- `make-media.sh` creates an artificial test-pattern clip and tone with FFmpeg. It contains no person, face, voice or real recording.

The example deliberately distinguishes a plan from completion and a screen image from a physical object. No continuous presence, identity match or completed action should be inferred across missing footage.

For speech and OCR checks, `./make-media.sh /tmp/synthetic-speech.mp4 --speech` generates a five-second title card with a fully synthesized Flite voice saying, "We will review two designs tomorrow at ten in the morning." It is an invented future plan, not a completed action or a recording of a person. This option requires FFmpeg's `flite` and `drawtext` filters and the DejaVu Sans font at the standard Linux path used by the script. Reuse the file as consecutive numbered clips to exercise a longer speech window; assign capture times and IDs explicitly when uploading.

To check a running **isolated, empty-data** deployment, install FFmpeg with its
Flite filter and DejaVu fonts (`ffmpeg` and `fonts-dejavu-core` on Debian/Ubuntu),
then run from the repository root:

```sh
set -a
. deploy/dual-spark/.env
set +a
bash examples/synthetic-day/make-media.sh /tmp/synthetic-sf.mp4 --speech
python3 examples/synthetic-day/upload.py /tmp/synthetic-sf.mp4
```

The uploader sends the same clip twice to `POST /`, checks both returned hashes,
and requires the second upload to preserve the first durable media ID. It reads
the token from the environment and never prints it. Use `--origin` for the HTTPS
capture origin. `--captured-at` accepts an explicit timezone-qualified timestamp
when testing a previous local day for sleep. Do not insert these clips into a
personal archive. Successful upload establishes storage, not completed model
processing: inspect worker results and the graph before starting sleep acceptance.

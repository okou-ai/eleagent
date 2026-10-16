# Dual-Spark deployment validation

This record covers the local-asset deployment path on two Linux ARM64 NVIDIA
DGX Spark hosts on 2026-10-16. Application services were rebuilt from this
repository and started against empty, isolated data directories. All recordings
were generated test cards with a synthetic Flite voice. No personal recordings
or production database contents were used as test inputs.

Functional code and CI were pinned to [e08eac6](https://github.com/okou-ai/eleagent/commit/e08eac685ac9fbf33ce7187fc3a0b62edb23ec7b); [the Check run](https://github.com/okou-ai/eleagent/actions/runs/38879351166) contains the test results below. Later revisions do not automatically inherit this acceptance record.

## Completed checks

| Area | Observed result |
| --- | --- |
| Container builds | Observer, Archive, Graph API, Graph Sync, recognition, speech, OCR and Sleep built from repository Dockerfiles. MiniCPM used pinned upstream application source. |
| Local model files | The public verifier checked MiniCPM, CAM++, Qwen ASR, GLM and DFlash weight/configuration bytes against exact upstream revisions. Face, object, OCR and Silero hashes were also checked. |
| Capture and storage | Eleven synthetic clips were durably archived. The public upload helper verified that an identical retry returned the same media identity and checksum. |
| Daytime inference | MiniCPM produced real observations; face/object processing and baseline/focus OCR produced archive events and graph entities. CAM++ and Qwen ASR produced real speech events. |
| First-start backlog | A new speech database discovered and transcribed all ten existing clips, with no pending work. Its output remained isolated. Observer upload/decode/restart checks also covered a pre-existing archive backlog. |
| Atlas build | The Rust server was rebuilt from the pinned engine source. Its 14 upstream check stages ran 379 passing test executions across 21 filters; overlapping filters can execute the same test more than once. |
| Atlas conversion | Fresh GPU conversion on each host converted 864 MTP matrices and verified 9,098 copied tensors. Independent verification checked all 9,962 tensor payloads per host. Original checkpoints were mounted read-only; metadata changes stayed in the new overlay. |
| Scheduled Sleep | The scheduler acquired its normal GPU lease, brought both Atlas ranks to readiness, and completed a real Pi run in 60 seconds. Its 10 tool calls had no errors and included two `view_candidate` image checks. The scheduler recorded completion with no last error. |
| Saved memory | Independent Graph API reads confirmed one conversation, one event and one diary: three memories and two links. |
| Image use | Pi inspected the candidate images and rejected false object detections on the card's white background and heading. An independent probe kept the text prompt fixed and changed only a PNG: the model answered “Green” for a green image and “Red” for a red image, both with HTTP 200. |
| Automatic recovery | The scheduler released its leases and recorded successful restoration. Both managers returned to idle with no lease or Atlas rank; daytime readiness checks passed and pause markers were removed. Fresh recognition and speech processes were verified after restart. |
| Capture after Sleep | An eleventh clip uploaded after recovery produced new MiniCPM, recognition, OCR and speech events. MiniCPM processed five frames and 5.056 seconds of audio in 5.697 seconds. Observer and all three recognition workers reached archive cursor 11; Observer and speech had no pending work. |
| CI | Source syntax, 6 model/conversion guards, 13 browser/memory tests, 16 observer tests, 35 recognition tests, one archive test and 15 real-Neo4j API tests passed. Seven optional recognition tests skipped in CPU CI; GPU model inference was exercised separately. |

## Defects corrected during the run

- New Observer, speech and OCR state could skip clips uploaded before model
  initialization completed. First installation now reads the existing archive;
  existing cursor and pending state continue on restart.
- Focus OCR could select the next clip's first frame at the current clip's end.
  Its timestamp range now excludes that boundary. Four newly uploaded consecutive
  clips all completed focus OCR after the fix.
- The Atlas conversion guide omitted the converted MTP quantization metadata
  adjustment. The wrapper now replaces overlay metadata without modifying the
  original checkpoint.
- Local cache preparation could still require unnecessary network access, and
  the clean-host model directory permissions prevented ordinary-user writes.
  Explicit cache options, integrity checks and corrected storage ownership are
  documented in the deployment guide.

## Boundaries

Large weights, native libraries and selected dependency bases were reused from
local storage. Application source was rebuilt; this was not a fresh download of
every default base dependency. In particular, MiniCPM's default public dependency
base remains a separate clean-host build check. Installed cached PyTorch packages
were version-checked; their missing original wheel archives could not be rehashed.

This is deployment acceptance, not an accuracy benchmark or an overnight soak
test. The synthetic ASR result heard “two designs” as “new designs.” The image
checks establish that images were used in these requests, not general visual
reasoning accuracy or consistent proactive verification. Phone-specific
camera permissions, operating-system suspension and long-duration Screen Wake Lock
behavior remain separate checks. Model and upstream application licenses retain
the restrictions described in the third-party notices.

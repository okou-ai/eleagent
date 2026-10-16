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

## References

These studies directly informed Eleagent's core design; they do not imply algorithm reproduction, biological equivalence, or validation of Eleagent.

[1] T. J. Teyler and P. DiScenna, “The hippocampal memory indexing theory,” *Behavioral Neuroscience*, vol. 100, no. 2, pp. 147–154, 1986, doi: [10.1037/0735-7044.100.2.147](https://doi.org/10.1037/0735-7044.100.2.147).

[2] J. L. McClelland, B. L. McNaughton, and R. C. O'Reilly, “Why there are complementary learning systems in the hippocampus and neocortex: Insights from the successes and failures of connectionist models of learning and memory,” *Psychological Review*, vol. 102, no. 3, pp. 419–457, 1995, doi: [10.1037/0033-295X.102.3.419](https://doi.org/10.1037/0033-295X.102.3.419).

[3] P. A. Lewis and S. J. Durrant, “Overlapping memory replay during sleep builds cognitive schemata,” *Trends in Cognitive Sciences*, vol. 15, no. 8, pp. 343–351, 2011, doi: [10.1016/j.tics.2011.06.004](https://doi.org/10.1016/j.tics.2011.06.004).

[4] B. A. Richards and P. W. Frankland, “The persistence and transience of memory,” *Neuron*, vol. 94, no. 6, pp. 1071–1084, 2017, doi: [10.1016/j.neuron.2017.04.037](https://doi.org/10.1016/j.neuron.2017.04.037).

[5] J. M. Zacks, N. K. Speer, K. M. Swallow, T. S. Braver, and J. R. Reynolds, “Event perception: A mind-brain perspective,” *Psychological Bulletin*, vol. 133, no. 2, pp. 273–293, 2007, doi: [10.1037/0033-2909.133.2.273](https://doi.org/10.1037/0033-2909.133.2.273).

[6] E. K. Miller and J. D. Cohen, “An integrative theory of prefrontal cortex function,” *Annual Review of Neuroscience*, vol. 24, pp. 167–202, 2001, doi: [10.1146/annurev.neuro.24.1.167](https://doi.org/10.1146/annurev.neuro.24.1.167).

[7] M. F. Land and M. Hayhoe, “In what ways do eye movements contribute to everyday activities?,” *Vision Research*, vol. 41, nos. 25–26, pp. 3559–3565, 2001, doi: [10.1016/S0042-6989(01)00102-X](https://doi.org/10.1016/S0042-6989(01)00102-X).

[8] M. K. Johnson, S. Hashtroudi, and D. S. Lindsay, “Source monitoring,” *Psychological Bulletin*, vol. 114, no. 1, pp. 3–28, 1993, doi: [10.1037/0033-2909.114.1.3](https://doi.org/10.1037/0033-2909.114.1.3).

<details>
<summary>Design notes and implementation links</summary>

- **Source-linked memory [1].** The graph retains selected memories and links; original media stays in the [archive](services/archive), accessible through [Sleep tools](services/sleep/extensions/memory.ts).
- **Day / night integration [2].** Fast [online perception](services/observer) feeds slower [nightly consolidation](services/sleep).
- **Abstraction and forgetting [3, 4].** [Sleep](services/sleep/prompts/sleep.md) consolidates fragments into reusable memories and lets low-value fragments fade, without deleting recordings.
- **Semantic events [5].** [Sleep](services/sleep/prompts/sleep.md) groups meaningful occurrences beyond fixed-duration capture buckets.
- **Context-guided attention [6, 7].** [Online situation context](services/observer/app/situation.py) feeds recent observations and recalled memories back into activity-oriented perception.
- **Source monitoring [8].** The [perception prompt](services/observer/app/situation.py) and [Sleep evidence rules](services/sleep/prompts/sleep.md) distinguish observations, reported speech, and interpretation—including device audio versus in-person speech.

</details>

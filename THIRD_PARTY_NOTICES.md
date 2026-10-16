# Third-party notices

Eleagent's original code is licensed under AGPL-3.0-only. This license does not relicense third-party software, model weights, datasets, or downloaded artifacts. Dependencies and weights are not vendored, except for the small attributed deployment patch and configuration described below.

| Component | Upstream | License or terms |
| --- | --- | --- |
| Atlas runtime | [Enntity/atlas](https://github.com/Enntity/atlas) | AGPL-3.0-only; retain its bundled notices when building |
| SparkGLM recipes and profile | [SparkGLM](https://github.com/Enntity/SparkGLM) | AGPL-3.0-only; see exact source pins in `deploy/atlas/sources.lock.json` |
| Pi coding agent | [earendil-works/pi](https://github.com/earendil-works/pi) | MIT; installed separately through npm |
| MiniCPM-o 4.5 weights | [OpenBMB](https://huggingface.co/openbmb/MiniCPM-o-4_5) | Apache-2.0 model card |
| MiniCPM demo application | [MiniCPM-o-Demo](https://github.com/OpenBMB/MiniCPM-o-Demo) | No explicit license found at the pinned source revision; permission must be resolved before redistributing its application or image |
| GLM-5.3-Flash NVFP4 | [NVIDIA model](https://huggingface.co/nvidia/GLM-5.3-Flash-NVFP4) | MIT model card; upstream dependencies retain their own terms |
| GLM-5.3-Flash DFlash2 | [Inco model](https://huggingface.co/incoai/GLM-5.3-Flash-DFlash2) | **CC BY-NC-ND-4.0**; commercial licensing requires separate permission |
| YOLOE / Ultralytics | [Ultralytics](https://github.com/ultralytics/ultralytics) | AGPL-3.0, or a separately acquired commercial license |
| DINOv2 | [facebookresearch/dinov2](https://github.com/facebookresearch/dinov2) | Apache-2.0 |
| YuNet / SFace | [OpenCV Zoo](https://github.com/opencv/opencv_zoo) | Model-specific notices: YuNet MIT, SFace Apache-2.0 |
| Qwen3-ASR 1.7B | [Qwen model](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | Apache-2.0 |
| FunASR / CAM++ | [FunASR](https://github.com/modelscope/FunASR) | FunASR code MIT; CAM++ model card Apache-2.0; review the selected revision |
| Silero VAD | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | MIT |
| RapidOCR / PP-OCR models | [RapidOCR](https://github.com/RapidAI/RapidOCR) | Apache-2.0; downloaded artifacts retain upstream notices |
| Neo4j Community | [Neo4j](https://github.com/neo4j/neo4j) | GPL-3.0; runs as a separate service |
| FFmpeg | [FFmpeg](https://ffmpeg.org/legal.html) | LGPL/GPL depending on the distribution and enabled codecs |

The accelerated Atlas profile references restricted DFlash2 draft weights. They are not included in this repository. Conversion, redistribution, and commercial use must satisfy the weight license independently of Eleagent's code license. The current recipe is not represented as an unrestricted commercial stack.

`deploy/atlas/create-rank.sh` and `profile-4x1m.json` adapt upstream SparkGLM deployment material. The patch uses checksum-verified native libraries from a digest-pinned upstream image, retains their upstream notices, and rebuilds the server from source. Consult the upstream image's license notices for its CUDA and other native dependencies.

`deploy/models.lock.json` records model revisions and provenance. Some provisioning pins were resolved from public upstream repositories because the original local model directory did not contain revision metadata; these are not claims that every deployed byte matched that public revision. Read each pinned model card before provisioning.

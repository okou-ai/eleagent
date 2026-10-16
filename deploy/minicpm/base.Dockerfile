# syntax=docker/dockerfile:1
# Public ARM64 base candidate. Building this image does not load model weights.
FROM nvidia/cuda:13.0.2-cudnn-runtime-ubuntu24.04@sha256:e5a14fe36b99bb7ef417749837aa7a5150c9b5fbd07474835aa707c82fff85ba AS eleagent-minicpm-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv ca-certificates curl ffmpeg libsndfile1 \
    libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN python3.12 -m venv /opt/minicpm-venv
ENV PATH=/opt/minicpm-venv/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1 \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility
COPY base-requirements.lock /tmp/base-requirements.lock
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-deps --require-hashes -r /tmp/base-requirements.lock
RUN python -c 'import platform, sys, torch, torchaudio, torchvision; assert platform.machine() == "aarch64"; assert sys.version_info[:2] == (3, 12); assert torch.version.cuda and torch.version.cuda.startswith("13.")'

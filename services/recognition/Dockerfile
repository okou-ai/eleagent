# The GPU targets use official ARM64 CUDA 13 wheels for the dual-Spark deployment.
ARG RECOGNITION_BASE_IMAGE=python:3.12-slim
FROM ${RECOGNITION_BASE_IMAGE} AS base
ARG REUSE_INSTALLED_TORCH=0
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 libgl1 libglib2.0-0 gcc g++ libc6-dev cmake libeigen3-dev sox \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements*.txt requirements*.lock constraints-torch.txt install_dependencies.py ./
ENTRYPOINT ["python"]

FROM base AS object-dependencies
RUN REUSE_INSTALLED_TORCH=${REUSE_INSTALLED_TORCH} python install_dependencies.py requirements-object.lock

FROM object-dependencies AS objects
COPY entity_worker ./entity_worker
COPY *_download_models.py download_models.py ./
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 YOLO_AUTOINSTALL=false YOLO_OFFLINE=true
CMD ["-m", "entity_worker.worker", "--minicpm-gate", "off", "--objects", "--object-device", "cuda"]

FROM base AS speech-dependencies
RUN REUSE_INSTALLED_TORCH=${REUSE_INSTALLED_TORCH} python install_dependencies.py requirements-speech.lock

FROM speech-dependencies AS speech
COPY entity_worker ./entity_worker
COPY *_download_models.py download_models.py ./
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1
CMD ["-m", "entity_worker.speech"]

FROM base AS ocr-dependencies
RUN pip install --no-cache-dir -r requirements-ocr.lock

FROM ocr-dependencies AS ocr
COPY entity_worker ./entity_worker
COPY *_download_models.py download_models.py ./
CMD ["-m", "entity_worker.text_worker"]

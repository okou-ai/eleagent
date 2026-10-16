# The GPU targets use official ARM64 CUDA 13 wheels for the dual-Spark deployment.
FROM python:3.12-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 libgl1 libglib2.0-0 gcc g++ libc6-dev cmake libeigen3-dev sox \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY entity_worker ./entity_worker
COPY *_download_models.py download_models.py ./
COPY requirements*.txt requirements*.lock constraints-torch.txt ./
ENTRYPOINT ["python"]

FROM base AS objects
RUN pip install --no-cache-dir -r requirements-object.lock
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 YOLO_AUTOINSTALL=false YOLO_OFFLINE=true
CMD ["-m", "entity_worker.worker", "--minicpm-gate", "off", "--objects", "--object-device", "cuda"]

FROM base AS speech
RUN pip install --no-cache-dir -r requirements-speech.lock
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1
CMD ["-m", "entity_worker.speech"]

FROM base AS ocr
RUN pip install --no-cache-dir -r requirements-ocr.lock
CMD ["-m", "entity_worker.text_worker"]

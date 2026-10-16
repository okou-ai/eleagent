# Build from the repository root: retention is shared with recognition.
FROM python:3.12-slim
WORKDIR /app/graph-sync
COPY services/graph-sync/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/graph-sync/graph_sync.py services/graph-sync/ocr_representative.py ./
COPY services/recognition/entity_worker /app/recognition/entity_worker
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 RECOGNITION_SOURCE_DIR=/app/recognition
ENTRYPOINT ["python", "graph_sync.py"]
CMD ["60"]

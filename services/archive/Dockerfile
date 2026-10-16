FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --create-home eleagent \
    && mkdir -p /data/archive && chown 10001:10001 /data/archive
COPY --chown=10001:10001 app ./app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8090
CMD ["uvicorn", "app.archive_server:create_archive_app", "--factory", "--host", "0.0.0.0", "--port", "8090"]

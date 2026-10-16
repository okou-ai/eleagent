FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/observer/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && mkdir -p /data && chown 1000:1000 /data
COPY --chown=1000:1000 services/observer/app ./app
COPY --chown=1000:1000 services/observer/fixtures ./fixtures
COPY --chown=1000:1000 apps/web ./web
ENV SCENE_WEB_ROOT=/app/web
USER 1000:1000
EXPOSE 8080 9101
CMD ["uvicorn","app.main:create_app","--factory","--host","0.0.0.0","--port","8080","--workers","1","--no-access-log"]

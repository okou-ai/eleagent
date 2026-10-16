"""Standalone archive process: uvicorn app.archive_server:create_archive_app --factory."""
from contextlib import asynccontextmanager
import os

from fastapi import FastAPI

from .archive import Archive
from .archive_api import install_archive_routes


def create_archive_app(db_path=None, media_root=None, reserve_bytes=None):
    media_root = media_root or os.getenv('SCENE_ARCHIVE_ROOT', '/data/archive/media')
    db_path = db_path or os.getenv('SCENE_ARCHIVE_DB', '/data/archive/archive.sqlite3')
    reserve_bytes = int(os.getenv('SCENE_ARCHIVE_RESERVE_BYTES', str(100 * 1024**3))) if reserve_bytes is None else reserve_bytes
    archive = Archive(db_path, media_root, reserve_bytes)

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            archive.close()

    app = FastAPI(title='Eleagent Media Archive', version='1.0.0', lifespan=lifespan)
    app.state.archive = archive

    install_archive_routes(app, archive)
    from . import metrics
    metrics.instrument_fastapi(app)
    def archive_counts():
        import sqlite3
        db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
        try:
            media, size = db.execute('SELECT count(*), coalesce(sum(size_bytes), 0) FROM archive_media').fetchone()
            yield ('scene_archive_media', 'Archived original clips', [], [((), media)])
            yield ('scene_archive_bytes', 'Bytes of archived originals', [], [((), size)])
            yield ('scene_archive_events', 'Timeline events by kind', ['kind'], db.execute('SELECT kind, count(*) FROM archive_events GROUP BY kind').fetchall())
        finally:
            db.close()
    metrics.register_gauges(archive_counts)
    metrics.serve()
    return app

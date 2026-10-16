"""Original downloads preserve their container type and support legacy MOV records."""
from fastapi.testclient import TestClient

from fastapi import FastAPI

from app.archive import Archive
from app.archive_api import install_archive_routes


def test_original_storage_and_response_formats(tmp_path):
    archive = Archive(str(tmp_path / 'archive.sqlite3'), str(tmp_path / 'media'), reserve_bytes=0)
    app = FastAPI()
    install_archive_routes(app, archive)
    with TestClient(app) as client:
        for sequence, (content_type, extension) in enumerate([
            ('video/quicktime', '.mov'), ('video/webm', '.webm'), ('video/mp4', '.mp4'),
        ]):
            # This internal archive stores bytes already validated by ingress.
            source = tmp_path / ('synthetic' + extension)
            source.write_bytes(b'synthetic original bytes ' + extension.encode())
            metadata = {} if sequence == 0 else {'content_type': content_type}
            item = archive.put_clip(
                source, 'synthetic-capture', sequence, '2026-01-15T17:00:00Z',
                duration_seconds=1, metadata=metadata,
            )
            response = client.get('/v1/archive/media/' + item['media_id'] + '/original')
            assert response.status_code == 200
            assert response.headers['content-type'] == content_type
            assert item['media_id'] + extension in response.headers['content-disposition']
            assert response.content == source.read_bytes()
    archive.close()

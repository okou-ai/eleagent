"""Durable source archive client; inference metadata uses a local SQLite outbox."""
import asyncio
import json
import sqlite3
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask


class RemoteArchive:
    def __init__(self, url, outbox_path):
        self.client = httpx.AsyncClient(base_url=url.rstrip('/'), trust_env=False,
            timeout=httpx.Timeout(25, connect=3), limits=httpx.Limits(max_connections=6))
        self.db = sqlite3.connect(outbox_path, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS archive_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS archive_rejected (id TEXT PRIMARY KEY, body TEXT NOT NULL, error TEXT NOT NULL)')
        self.db.commit()
        self.snapshot = {'enabled': True, 'available': False, 'storage_host': 'archive',
                         'retention': 'no_auto_delete', 'error': 'not_checked'}

    async def request(self, method, path, **kwargs):
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.HTTPError:
            self.snapshot.update(available=False, error='archive_unavailable')
            raise HTTPException(503, detail={'code': 'archive_unavailable'})
        if response.status_code >= 400:
            try:
                detail = response.json().get('detail', {})
                code = detail.get('code', 'archive_request_failed') if isinstance(detail, dict) else 'archive_request_failed'
            except ValueError:
                code = 'archive_request_failed'
            if response.status_code != 404:
                self.snapshot.update(error=code)
            raise HTTPException(response.status_code, detail={'code': code})
        self.snapshot.update(available=True, error=None)
        return response.json()

    async def get_clip(self, capture_id, seq):
        try:
            return await self.request('GET', f'/v1/archive/captures/{capture_id}/clips/{seq}')
        except HTTPException as exc:
            if exc.status_code == 404:
                return None
            raise

    async def capture_state(self, capture_id):
        return await self.request('GET', f'/v1/archive/captures/{capture_id}/state')

    async def put_clip(self, path, *, capture_id, clip_seq, captured_at, **info):
        async def chunks():
            with Path(path).open('rb') as source:
                while chunk := source.read(256 * 1024):
                    yield chunk
        return await self.request('POST', '/v1/archive/clips',
            params={'capture_id': capture_id, 'clip_seq': clip_seq, 'captured_at': captured_at},
            headers={'Content-Type': info.get('metadata', {}).get('content_type', 'application/octet-stream'),
                     'X-Archive-Info': json.dumps(info, ensure_ascii=True, separators=(',', ':')),
                     'Content-Length': str(Path(path).stat().st_size)}, content=chunks())

    def enqueue(self, kind, body, **fields):
        event_id = fields.pop('event_id', None) or body.get('id') or 'gap_' + uuid.uuid4().hex
        value = {'kind': kind, 'body': body, 'event_id': event_id, **fields}
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO archive_outbox VALUES (?,?)',
                            (event_id, json.dumps(value, ensure_ascii=False)))

    def status(self):
        return {**self.snapshot, 'pending_timeline_events': self.db.execute(
            'SELECT COUNT(*) FROM archive_outbox').fetchone()[0], 'rejected_timeline_events': self.db.execute(
            'SELECT COUNT(*) FROM archive_rejected').fetchone()[0]}

    async def sync_once(self):
        # FIFO, delete only after durable remote acknowledgement; replay IDs are stable.
        for _ in range(32):
            row = self.db.execute('SELECT id,body FROM archive_outbox ORDER BY rowid LIMIT 1').fetchone()
            if row is None:
                break
            try:
                await self.request('POST', '/v1/archive/events', json=json.loads(row[1]))
            except HTTPException as exc:
                if exc.status_code not in (400, 409, 413, 422):
                    raise
                # Retain bad metadata for repair while allowing later events through.
                with self.db:
                    self.db.execute('INSERT OR REPLACE INTO archive_rejected VALUES (?,?,?)',
                                    (*row, json.dumps(exc.detail)))
                    self.db.execute('DELETE FROM archive_outbox WHERE id=?', (row[0],))
                continue
            with self.db:
                self.db.execute('DELETE FROM archive_outbox WHERE id=?', (row[0],))
        self.snapshot.update(available=True, error=None)
        if self.db.execute('SELECT 1 FROM archive_rejected LIMIT 1').fetchone():
            self.snapshot['error'] = 'timeline_events_need_repair'

    async def run(self):
        while True:
            try:
                await self.sync_once()
            except (HTTPException, httpx.HTTPError):
                self.snapshot.update(available=False)
            await asyncio.sleep(2)

    async def close(self):
        await self.client.aclose()
        self.db.close()

    async def proxy(self, request, path):
        # Read-only proxying retains archive authorization on the server.
        headers = {k: v for k, v in request.headers.items() if k.lower() in ('range', 'if-range')}
        req = self.client.build_request(request.method, '/v1/archive/' + path,
                                       params=request.query_params, headers=headers)
        try:
            response = await self.client.send(req, stream=True)
        except httpx.HTTPError:
            raise HTTPException(503, detail={'code': 'archive_unavailable'})
        copied = {k: v for k, v in response.headers.items() if k.lower().startswith('x-archive-') or k.lower() in
                  ('content-type', 'content-length', 'content-range', 'accept-ranges',
                   'etag', 'last-modified', 'content-disposition', 'cache-control')}
        return StreamingResponse(response.aiter_raw(), status_code=response.status_code,
            headers=copied, background=BackgroundTask(response.aclose))

    async def proxy_entity(self, request, base_url, path):
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 8192:
                raise HTTPException(413, detail={'code': 'entity_request_too_large'})
            body.extend(chunk)
        try:
            response = await self.client.request(request.method,
                base_url.rstrip('/') + '/v1/entities/' + path, params=request.query_params,
                content=bytes(body), headers={'Content-Type': 'application/json'}, timeout=10)
        except httpx.HTTPError:
            raise HTTPException(503, detail={'code': 'entity_service_unavailable'})
        from fastapi.responses import Response
        return Response(response.content, status_code=response.status_code,
                        media_type='application/json', headers={'Cache-Control': 'private, no-store'})

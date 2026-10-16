#!/usr/bin/env python3
"""Upload synthetic media to an isolated deployment and verify durable deduplication."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--origin', default='http://127.0.0.1:8080')
    parser.add_argument('--captured-at', help='ISO-8601 timestamp with timezone; defaults to now')
    args = parser.parse_args()
    if args.file.suffix.lower() not in {'.mp4', '.webm'}:
        parser.error('Use an MP4 or WebM synthetic clip')
    origin = urlsplit(args.origin)
    if (origin.scheme not in {'http', 'https'} or not origin.hostname or origin.username
            or origin.password or origin.path not in {'', '/'} or origin.query or origin.fragment):
        parser.error('--origin must be an HTTP(S) origin without credentials or a path')
    token = os.environ.get('SCENE_API_TOKEN', '')
    if len(token) < 16:
        parser.error('Set SCENE_API_TOKEN in the environment')
    start = datetime.fromisoformat(args.captured_at) if args.captured_at else datetime.now(timezone.utc)
    if start.utcoffset() is None:
        parser.error('--captured-at must include a timezone offset')
    duration = float(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(args.file)], text=True))
    media = args.file.read_bytes()
    checksum = hashlib.sha256(media).hexdigest()
    meta = {'capture_id': 'synthetic-sf-' + uuid.uuid4().hex, 'clip_seq': 0,
            'captured_at': start.isoformat(), 'captured_end_at': (start + timedelta(seconds=duration)).isoformat(),
            'camera': 'back', 'source': 'browser_media_recorder', 'capture_gaps': [], 'locations': []}
    boundary = uuid.uuid4().hex
    mime = 'video/webm' if args.file.suffix.lower() == '.webm' else 'video/mp4'
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n'.encode()
            + json.dumps(meta).encode()
            + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="synthetic{args.file.suffix}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
            + media + f'\r\n--{boundary}--\r\n'.encode())
    receipts = []
    connection_type = http.client.HTTPSConnection if origin.scheme == 'https' else http.client.HTTPConnection
    for duplicate in (False, True):
        connection = connection_type(origin.hostname, origin.port, timeout=90)
        try:
            connection.request('POST', '/', body, {'Authorization': 'Bearer ' + token,
                'Content-Type': 'multipart/form-data; boundary=' + boundary})
            response = connection.getresponse()
            receipt = json.loads(response.read())
            if response.status != 200 or receipt.get('sha256') != checksum or not receipt.get('archived'):
                raise RuntimeError(f'Upload was not durably acknowledged (HTTP {response.status})')
            if receipt.get('duplicate') is not duplicate:
                raise RuntimeError('Unexpected duplicate receipt')
            receipts.append(receipt)
        finally:
            connection.close()
    if receipts[0]['media_id'] != receipts[1]['media_id']:
        raise RuntimeError('Duplicate upload changed the archived media identity')
    print(json.dumps({'capture_id': meta['capture_id'], 'media_id': receipts[0]['media_id'],
                      'sha256': checksum, 'archived': True, 'duplicate_verified': True}))


if __name__ == '__main__':
    main()

"""Read one quality-selected full-resolution frame per new archive clip."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import os
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import httpx
import numpy as np

from .frame_selection import select_frame

PIPELINE = 'scene-text-v2'
# A new recognition model must continue the existing cursor, never replay history.
CURSOR_KEY = 'text_cursor:scene-text-v1'
MODEL = 'rapidocr-3.10.0-ppocrv6-small-onnx'
TEST_PREFIXES = ('archive-probe-', 'entity-acceptance-')
POSITIONS = (0.2, 0.5, 0.8)
MAX_MEDIA_BYTES = 128 * 1024 * 1024
# Focus reading: once the live MiniCPM window names what I am holding (focus + English noun), re-read
# that object's YOLOE box from the native frame. Whole-frame reading above stays unchanged.
FOCUS_PIPELINE = 'scene-text-focus-v1'
FOCUS_WAIT_SECONDS = 240
FOCUS_SKIP = {'person', 'people', 'human', 'man', 'woman', 'hand', 'arm', 'finger', 'human face', 'face'}
FOCUS_SCENE = {'laboratory', 'biology laboratory', 'physics laboratory', 'chemistry laboratory', 'scientist',
               'gallery', 'party', 'assemble', 'assembly', 'garage kit', 'bank vault', 'office', 'room',
               'living room', 'bedroom', 'kitchen', 'classroom', 'workshop', 'store', 'shop'}
FOCUS_STOPWORDS = {'the', 'and', 'with', 'that', 'this', 'what', 'which', 'from', 'into', 'onto', 'ahead', 'front', 'left',
                   'right', 'near', 'its', 'are', 'was', 'while', 'have', 'has', 'looking', 'holding', 'reading', 'watching',
                   'listening', 'talking', 'because', 'camera', 'view', 'center', 'keeps', 'attention', 'focus', 'white',
                   'black', 'blue', 'red', 'green', 'gray', 'grey', 'silver', 'small', 'large', 'big', 'hand', 'hands'}
FOCUS_SYNONYMS = {
    'bottle': {'bottle', 'water bottle', 'drop', 'tube', 'jar', 'vial', 'spray bottle'},
    'case': {'case', 'box', 'container', 'glasses case', 'pencil case', 'storage box', 'packet'},
    'box': {'box', 'case', 'package', 'packet', 'carton', 'storage box'},
    'keyboard': {'keyboard', 'remote', 'remote control', 'controller', 'game controller', 'gadget', 'device', 'keypad'},
    'device': {'device', 'gadget', 'remote', 'controller', 'phone', 'cell phone', 'electronic device'},
    'remote': {'remote', 'remote control', 'controller', 'game controller', 'gadget', 'device', 'keyboard', 'keypad'},
    'controller': {'controller', 'game controller', 'remote', 'gadget', 'device', 'keyboard'},
    'phone': {'phone', 'cell phone', 'mobile phone', 'smartphone', 'iphone'},
    'cup': {'cup', 'mug', 'paper cup', 'coffee cup'},
    'book': {'book', 'notebook', 'magazine', 'booklet', 'paper', 'document'},
    'glasses': {'glasses', 'sunglasses', 'eyeglasses', 'goggles', 'glasses case'},
    'earphones': {'earphone', 'earphones', 'earbuds', 'headphones', 'headset', 'case'},
    'card': {'card', 'id card', 'business card', 'ticket', 'label'},
    'sign': {'sign', 'traffic sign', 'street sign', 'signboard', 'billboard', 'poster', 'banner'},
    'street': {'traffic sign', 'street sign', 'signboard'},
    'screen': {'screen', 'monitor', 'tv', 'television', 'laptop', 'computer', 'display'},
    'monitor': {'monitor', 'screen', 'tv', 'laptop', 'computer', 'display'},
    'laptop': {'laptop', 'computer', 'monitor', 'screen'},
    'whiteboard': {'whiteboard', 'blackboard', 'board', 'flipchart'},
    'menu': {'menu', 'poster', 'board', 'signboard'},
    'light': {'traffic light'},
}
MODEL_HASHES = {
    'PP-OCRv6_det_small.onnx': '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
    'PP-OCRv6_rec_small.onnx': '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
    'ch_ppocr_mobile_v2.0_cls_mobile.onnx': 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
}


def extract_frames(video: Path, directory: Path, duration: float):
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('invalid_video_duration')
    frames, offsets = [], []
    for index, position in enumerate(POSITIONS):
        offset = min(duration * position, max(0.0, duration - 0.001))
        output = directory / f'frame-{index}.jpg'
        subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
            '-ss', f'{offset:.6f}', '-i', str(video), '-map', '0:v:0',
            '-frames:v', '1', '-an', '-q:v', '2', '-threads', '1', '-y', str(output),
        ], check=True, capture_output=True, timeout=20)
        frame = cv2.imread(str(output))
        if frame is None:
            raise ValueError('frame_decode_failed')
        frames.append(frame)
        offsets.append(offset)
    return frames, offsets


def convert_result(result, width: int, height: int):
    texts = list(result.txts or [])
    scores = list(result.scores or [])
    boxes = list(result.boxes) if result.boxes is not None else []
    if not len(texts) == len(scores) == len(boxes):
        raise ValueError('ocr_output_shape_mismatch')
    out = []
    for text, confidence, polygon in zip(texts, scores, boxes):
        text = str(text).strip()
        points = np.asarray(polygon, dtype=float)
        confidence = float(confidence)
        if not text:
            continue
        if points.shape != (4, 2) or not np.isfinite(points).all() or not math.isfinite(confidence):
            raise ValueError('invalid_ocr_geometry')
        x1, y1 = points.min(axis=0)
        x2, y2 = points.max(axis=0)
        box = [round(float(np.clip(v, 0, 1000)), 2) for v in
               (x1 / width * 1000, y1 / height * 1000, x2 / width * 1000, y2 / height * 1000)]
        out.append({'text': text, 'bbox_2d': box, 'confidence': confidence, 'carrier': 'other'})
    return out


class SmallOCR:
    def __init__(self, model_dir, threads=4):
        from rapidocr import RapidOCR, ModelType, OCRVersion
        root = Path(model_dir)
        for name, expected in MODEL_HASHES.items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
                raise ValueError('ocr_model_checksum_mismatch:' + name)
        classifier = root / 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'
        if not classifier.is_file():
            raise ValueError('ocr_classifier_missing')
        cv2.setNumThreads(threads)
        self.engine = RapidOCR(params={
            'Global.log_level': 'warning', 'Global.model_root_dir': str(root),
            'EngineConfig.onnxruntime.intra_op_num_threads': threads,
            'EngineConfig.onnxruntime.inter_op_num_threads': 1,
            'Det.model_type': ModelType('small'), 'Rec.model_type': ModelType('small'),
            'Det.ocr_version': OCRVersion.PPOCRV6, 'Rec.ocr_version': OCRVersion.PPOCRV6,
            'Det.model_path': str(root / 'PP-OCRv6_det_small.onnx'),
            'Rec.model_path': str(root / 'PP-OCRv6_rec_small.onnx'),
            'Cls.model_path': str(classifier),
        })

    def read(self, frame):
        result = self.engine(frame)
        height, width = frame.shape[:2]
        return convert_result(result, width, height)


class TextWorker:
    def __init__(self, store, archive_url, token, reader):
        self.store, self.reader = store, reader
        self.cursor_key = CURSOR_KEY
        self.focus_jobs = []
        self.archive = httpx.Client(
            base_url=archive_url.rstrip('/'), timeout=httpx.Timeout(60, connect=3),
            headers={'Authorization': 'Bearer ' + token}, follow_redirects=False,
        )

    def feed(self, after):
        response = self.archive.get('/v1/archive/feed', params={'after': after, 'limit': 100})
        response.raise_for_status()
        return response.json()

    def pending(self):
        cursor = self.store.config(self.cursor_key)
        if cursor is None:
            after = 0
            while True:
                page = self.feed(after)
                after = page['next_cursor']
                if not page['has_more']:
                    break
            self.store.set_config(self.cursor_key, str(after))
            return [], after
        page = self.feed(int(cursor))
        items = [a for a in page['items'] if not (
            (a.get('metadata') or {}).get('test_fixture') or a['capture_id'].startswith(TEST_PREFIXES))]
        return items, page['next_cursor'] if page['items'] else int(cursor)

    def download(self, asset, destination):
        if not 0 < int(asset['size_bytes']) <= MAX_MEDIA_BYTES:
            raise ValueError('media_size_outside_bounds')
        digest, size = hashlib.sha256(), 0
        with self.archive.stream('GET', '/v1/archive/media/' + asset['media_id'] + '/original') as response:
            response.raise_for_status()
            with destination.open('wb') as output:
                for block in response.iter_bytes(256 * 1024):
                    size += len(block)
                    if size > MAX_MEDIA_BYTES or size > asset['size_bytes']:
                        raise ValueError('media_download_exceeds_bound')
                    digest.update(block)
                    output.write(block)
        if size != asset['size_bytes'] or digest.hexdigest() != asset['sha256']:
            raise ValueError('media_download_integrity_failed')

    def handle(self, asset):
        from . import metrics
        started = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix='scene-text-') as temporary:
            directory = Path(temporary)
            video = directory / 'original.mp4'
            self.download(asset, video)
            frames, offsets = extract_frames(video, directory, float(asset['duration_seconds']))
            index, candidates = select_frame(frames, POSITIONS)
            frame = frames[index]
            offset = offsets[index]
            quality = candidates[index]
            read_start = time.perf_counter()
            texts = self.reader.read(frame)
            metrics.job('scene_text_read', 'ok', time.perf_counter() - read_start)
        height, width = frame.shape[:2]
        at = datetime.fromisoformat(asset['captured_at']) + timedelta(seconds=offset)
        # One deterministic event per clip, including successful empty observations.
        key = hashlib.sha256(f"{PIPELINE}|{asset['media_id']}".encode()).hexdigest()[:48]
        metrics.job('scene_text_clip', 'ok', time.perf_counter() - started)
        return {
            'event_id': 'scene_text_' + key, 'kind': 'scene_text', 'capture_id': asset['capture_id'],
            'started_at': at.isoformat(timespec='microseconds'),
            'ended_at': at.isoformat(timespec='microseconds'), 'model': MODEL, 'entity_ids': [],
            'media_refs': [{'media_id': asset['media_id'], 'start_offset_seconds': offset,
                            'end_offset_seconds': offset, 'alignment': 'video_frame'}],
            'body': {
                'texts': texts, 'frame_offset': offset, 'pipeline': PIPELINE,
                'frame_size': {'width': width, 'height': height},
                'frame_quality': quality['quality'],
                'frame_quality_method': 'laplacian_fft_candidate_rank',
                'frame_candidates': [{**candidate, 'frame_offset': offsets[i]}
                                     for i, candidate in enumerate(candidates)],
                'camera_facing': (asset.get('metadata') or {}).get('camera_facing', 'unknown'),
            },
        }

    def events(self, capture_id, kind, started_at, ended_at):
        response = self.archive.get('/v1/archive/events', params={
            'capture_id': capture_id, 'kind': kind, 'started_at': started_at.isoformat(),
            'ended_at': ended_at.isoformat(), 'limit': 100})
        response.raise_for_status()
        return response.json()['items']

    @staticmethod
    def focus_box(focus, objects, clip_start):
        # The live note describes where attention is in English (e.g. "the street sign ahead", "a white bottle
        # in my hand"); detector labels are matched against its words, widened by a few synonyms.
        words = {w for w in re.findall(r'[a-z]+', (focus or '').lower()) if len(w) > 2 and w not in FOCUS_STOPWORDS}
        wanted = set(words)
        for w in words:
            wanted |= FOCUS_SYNONYMS.get(w, set())
        ranked = []
        for event in objects:
            offset = (datetime.fromisoformat(event['started_at']) - clip_start).total_seconds()
            for item in (event['body'] or {}).get('observations', []):
                label = (item.get('label') or '').lower()
                width, height = item.get('frame_width') or 0, item.get('frame_height') or 0
                if not width or not height or label in FOCUS_SKIP or label in FOCUS_SCENE:
                    continue
                x0, y0, x1, y1 = item['bbox']
                area = (x1 - x0) * (y1 - y0) / (width * height)
                matched = bool(wanted) and (label in wanted or bool(set(label.split()) & words))
                if not (0.003 if matched else 0.01) <= area <= 0.45:
                    continue
                # Among matches the larger (closer, more central to the view) box is preferred.
                score = (2.0 if matched else 1.0) * float(item.get('confidence') or 0) * area
                ranked.append((matched, score, offset, item))
        if not ranked:
            return [], False
        matched = any(r[0] for r in ranked)
        pool = [r for r in ranked if r[0]] if matched else ranked
        best = max(pool, key=lambda r: r[1])
        # Candidate frames: the chosen label/cluster in each sampled frame (sharpest crop is read).
        key = best[3].get('entity_id') or best[3].get('label')
        same = [r for r in pool if (r[3].get('entity_id') or r[3].get('label')) == key]
        return sorted(same, key=lambda r: -r[1])[:5], matched

    def focus_read(self, job):
        """Returns an event, None when done without reading, or False to retry later."""
        asset = job['asset']
        start = datetime.fromisoformat(asset['captured_at'])
        end = start + timedelta(seconds=float(asset['duration_seconds']))
        windows = self.events(asset['capture_id'], 'minicpm', start - timedelta(seconds=1), end + timedelta(seconds=1))
        windows = [w for w in windows if (w['body'] or {}).get('situation_meta')]
        if not windows:
            return False
        def overlap(w):
            a = max(start, datetime.fromisoformat(w['started_at']))
            b = min(end, datetime.fromisoformat(w['ended_at']))
            return (b - a).total_seconds()
        window = max(windows, key=overlap)
        situation = window['body'].get('situation') or {}
        if not situation.get('focus'):
            return None
        objects = self.events(asset['capture_id'], 'object', start, end)
        if not objects:
            return False
        candidates, matched = self.focus_box(situation.get('focus'), objects, start)
        if not candidates:
            return None
        best = None
        with tempfile.TemporaryDirectory(prefix='scene-focus-') as temporary:
            directory = Path(temporary)
            video = directory / 'original.mp4'
            self.download(asset, video)
            for index, (_, _, offset, item) in enumerate(candidates):
                output = directory / f'focus-{index}.jpg'
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-ss', f'{max(0.0, offset):.3f}',
                                '-i', str(video), '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', '-y', str(output)],
                               check=True, capture_output=True, timeout=20)
                frame = cv2.imread(str(output))
                if frame is None:
                    continue
                h, w = frame.shape[:2]
                sx, sy = w / item['frame_width'], h / item['frame_height']
                x0, y0, x1, y1 = item['bbox']
                mx, my = (x1 - x0) * 0.12, (y1 - y0) * 0.12
                box = [max(0, int((x0 - mx) * sx)), max(0, int((y0 - my) * sy)),
                       min(w, int((x1 + mx) * sx)), min(h, int((y1 + my) * sy))]
                crop = frame[box[1]:box[3], box[0]:box[2]]
                if crop.size == 0:
                    continue
                sharp = cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
                if best is None or sharp > best[0]:
                    best = (sharp, crop, offset, item, box, (w, h))
            if best is None:
                return None
            sharp, crop, offset, item, box, size = best
            texts = self.reader.read(crop)
        at = start + timedelta(seconds=offset)
        key = hashlib.sha256(f"{FOCUS_PIPELINE}|{asset['media_id']}".encode()).hexdigest()[:48]
        return {
            'event_id': 'scene_text_focus_' + key, 'kind': 'scene_text', 'capture_id': asset['capture_id'],
            'started_at': at.isoformat(timespec='microseconds'), 'ended_at': at.isoformat(timespec='microseconds'),
            'model': MODEL, 'entity_ids': [],
            'media_refs': [{'media_id': asset['media_id'], 'start_offset_seconds': offset,
                            'end_offset_seconds': offset, 'alignment': 'video_frame'}],
            'body': {
                'texts': texts, 'frame_offset': offset, 'pipeline': FOCUS_PIPELINE,
                'frame_size': {'width': size[0], 'height': size[1]}, 'crop_box': box,
                'crop_sharpness': round(float(sharp), 1),
                'focus': situation.get('focus'),
                'object_label': item.get('label'), 'object_cluster_id': item.get('entity_id'),
                'label_matched': matched, 'minicpm_event_id': window['event_id'],
                'camera_facing': (asset.get('metadata') or {}).get('camera_facing', 'unknown'),
            },
        }

    def focus_tick(self):
        from . import metrics
        now = time.monotonic()
        remaining = []
        for job in self.focus_jobs:
            if now < job['next']:
                remaining.append(job)
                continue
            try:
                event = self.focus_read(job)
            except Exception as error:
                print(json.dumps({'status': 'focus_failed', 'media': job['asset']['media_id'],
                                  'error': type(error).__name__}), flush=True)
                metrics.job('scene_text_focus', 'error')
                continue
            if event is False:
                if now < job['deadline']:
                    job['next'] = now + 5
                    remaining.append(job)
                continue
            if event:
                self.store.record_speech([], [event])
                metrics.job('scene_text_focus', 'ok')
                print(json.dumps({'status': 'focus_read', 'texts': len(event['body']['texts']),
                                  'label': event['body']['object_label'], 'matched': event['body']['label_matched']}),
                      flush=True)
        self.focus_jobs = remaining

    def tick(self):
        from . import metrics
        self.focus_tick()
        items, cursor = self.pending()
        for asset in items:
            try:
                event = self.handle(asset)
            except Exception as error:
                metrics.job('scene_text_read', 'error')
                # No visual skip cache: the next similar clip is tried normally.
                print(json.dumps({'status': 'read_failed', 'media': asset['media_id'],
                                  'error': type(error).__name__}), flush=True)
                event = None
            if event is not None:
                # Atomic event/outbox commit precedes advancing the cursor.
                self.store.record_speech([], [event])
                now = time.monotonic()
                self.focus_jobs.append({'asset': asset, 'deadline': now + FOCUS_WAIT_SECONDS, 'next': now + 3})
                print(json.dumps({'status': 'read', 'pipeline': PIPELINE,
                                  'texts': len(event['body']['texts']),
                                  'frame_offset': event['body']['frame_offset']}), flush=True)
            self.store.set_config(self.cursor_key, str(asset['ingest_cursor']))
        if items or int(self.store.config(self.cursor_key) or 0) != cursor:
            self.store.set_config(self.cursor_key, str(cursor))
        return bool(items)


def main():
    from .store import Store
    from . import metrics
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', default='/data/entities.sqlite')
    parser.add_argument('--model-dir', default=os.environ.get('OCR_MODEL_DIR', '/models/ocr'))
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--try-media', help='Read one archived clip without writing results or state')
    parser.add_argument('--result-file', help='Save a private diagnostic result (only with --try-media)')
    args = parser.parse_args()
    reader = SmallOCR(args.model_dir, args.threads)
    # Diagnostic mode never opens the production worker state database.
    worker = TextWorker(None if args.try_media else Store(args.state),
                        os.environ['ARCHIVE_URL'], os.environ['SCENE_ARCHIVE_TOKEN'], reader)
    if args.try_media:
        response = worker.archive.get('/v1/archive/media/' + args.try_media)
        response.raise_for_status()
        start = time.perf_counter()
        event = worker.handle(response.json())
        if args.result_file:
            Path(args.result_file).write_text(json.dumps(event, ensure_ascii=False))
        print(json.dumps({'seconds': round(time.perf_counter() - start, 4),
                          'blocks': len(event['body']['texts']), 'frame_offset': event['body']['frame_offset'],
                          'frame_size': event['body']['frame_size'], 'persisted': False}), flush=True)
        return
    metrics.serve()
    print(json.dumps({'status': 'started', 'pipeline': PIPELINE, 'model': MODEL}), flush=True)
    while True:
        try:
            busy = worker.tick()
        except Exception as error:
            print(json.dumps({'status': 'retry_pending', 'error': type(error).__name__}), flush=True)
            busy = False
        if not busy:
            time.sleep(5)


if __name__ == '__main__':
    main()

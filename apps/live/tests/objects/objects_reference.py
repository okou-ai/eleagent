"""Server-side object reference for the browser object parity test (apps/live/tests/objects/parity.mjs).

Runs the production code path, entity_worker.objects.ObjectDetector.extract (YOLOE-26L-PF predict + quality gate +
DINOv2-small CLS), on every image in --images, fed the way worker.py feeds it (RGB uint8 HWC). Hooks record what the
browser must reproduce: the letterboxed predictor input, the raw head output reduced per anchor the way
ultralytics' non_max_suppression reads it (xyxy, best class probability, best class id; anchors removed by the LRPC
proposal filter are zero rows), every detection before the max_objects cap, the extract() records (boxes, quality,
blur, L2-normalised features) and the DINOv2 pixel_values. Unit cases on synthetic frames pin the OpenCV letterbox
(INTER_LINEAR / 2x area path), cvtColor + Laplacian variance and Pillow bicubic preprocessing for many sizes.

  python -I objects_reference.py --weights <ENTITY_WEIGHTS_DIR> --images <dir of jpg/png> --out <dir> \
      [--recognition-src services/recognition] [--threads 2]

--weights is the directory object_download_models.py fills (manifest-object-yoloe.json, sha256-verified by
ObjectDetector itself). Output: frame_*.rgb, lb_*.rgb (uint8 HWC RGB), raw_*.f32 ([anchors, 6]), dino_*.f32
([crops, 3, 224, 224]), unit_*.bin and reference.json.
"""
import argparse, hashlib, json, math, platform, sys
from pathlib import Path
import numpy as np

# Extra frames derived from the photos: camera-like sizes that exercise non-trivial letterbox scales.
VARIANTS = {'coco_000000172595': [(1920, 1080)], 'bus': [(1080, 1440)]}
# Synthetic letterbox frames (w, h): identity, 2x area-fast path, generic linear down/up-scaling, odd sizes.
LETTERBOX_SIZES = [(640, 480), (1280, 720), (1920, 1080), (1080, 1920), (641, 481), (320, 240), (1000, 750),
                   (333, 777), (2560, 1440), (1366, 768), (8, 8), (639, 359), (1281, 721), (4096, 2304)]


def synthetic(rng, width, height):
    """Smooth gradients + texture + noise, so both blur outcomes and all resize branches are exercised."""
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    base = np.stack([127 + 120 * np.sin(x / (7 + 13 * c) + y / (11 + 5 * c) + c) for c in range(3)], -1)
    return np.clip(base + rng.normal(0, 18, (height, width, 3)), 0, 255).astype(np.uint8)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--weights', required=True); p.add_argument('--images', required=True); p.add_argument('--out', required=True)
    p.add_argument('--recognition-src', help='dir containing entity_worker (default: this repo)')
    p.add_argument('--threads', type=int, default=2)
    a = p.parse_args()
    sys.dont_write_bytecode = True  # leave no __pycache__ beside the server code
    sys.path.insert(0, a.recognition_src or str(Path(__file__).resolve().parents[4] / 'services' / 'recognition'))
    import cv2, PIL, torch, transformers, ultralytics
    from PIL import Image
    from ultralytics.data.augment import LetterBox
    from ultralytics.engine.predictor import BasePredictor
    from ultralytics.models.yolo.segment.predict import SegmentationPredictor
    from ultralytics.utils.ops import xywh2xyxy
    from entity_worker import objects
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    detector = objects.ObjectDetector(Path(a.weights), device='cpu', threads=a.threads)
    captured = {}

    def hook(cls, name, record):
        original = getattr(cls, name)
        def wrapped(self, *args, **kwargs):
            result = original(self, *args, **kwargs)
            record(args, result)
            return result
        setattr(cls, name, wrapped)

    hook(BasePredictor, 'preprocess', lambda args, result: captured.__setitem__('input', result))
    def raw_output(args, result):
        y, index = args[0][0][0][0], args[0][1]['index']  # ((y, proto), preds) from YOLOESegment26 (end2end=False)
        x = y.transpose(0, 1)  # non_max_suppression: [anchors, 4 + nc + 32]
        nc = len(detector.detector.names)
        conf, j = x[:, 4:4 + nc].max(1, keepdim=True)  # best class only (multi_label=False)
        rows = torch.cat((xywh2xyxy(x[:, :4]), conf, j.float()), 1)
        full = torch.zeros((index.numel(), 6), dtype=torch.float32)
        full[index] = rows.float()
        captured['raw'] = full.numpy()
    hook(SegmentationPredictor, 'postprocess', raw_output)
    hook(objects.ObjectDetector, '_detect', lambda args, result: captured.__setitem__('detected', [dict(d) for d in result]))
    hook(objects.ObjectDetector, '_appearance_inputs', lambda args, result: captured.__setitem__('dino', result['pixel_values'].numpy()))

    sources = sorted(path for path in Path(a.images).iterdir() if path.suffix.lower() in ('.jpg', '.jpeg', '.png'))
    frames = []
    for path in sources:
        rgb = cv2.imread(str(path), cv2.IMREAD_COLOR)[:, :, ::-1]  # worker.py: decoded BGR frame -> frame[:, :, ::-1]
        frames.append((path.stem, path.name, np.ascontiguousarray(rgb)))
        for width, height in VARIANTS.get(path.stem, []):
            frames.append((f'{path.stem}_{width}x{height}', path.name, cv2.resize(rgb, (width, height), interpolation=cv2.INTER_CUBIC)))
    cases = []
    for name, source, frame in frames:
        captured.clear()
        records = detector.extract(frame)
        frame.tofile(out / f'frame_{name}.rgb')
        letterboxed = (captured['input'][0].permute(1, 2, 0) * 255).round().to(torch.uint8).numpy()  # exact: u8 / 255
        letterboxed.tofile(out / f'lb_{name}.rgb')
        captured['raw'].tofile(out / f'raw_{name}.f32')
        case = {'name': name, 'source': source, 'width': frame.shape[1], 'height': frame.shape[0], 'frame': f'frame_{name}.rgb',
                'letterbox': {'shape': list(letterboxed.shape[:2]), 'file': f'lb_{name}.rgb'},
                'raw': {'file': f'raw_{name}.f32', 'anchors': int(captured['raw'].shape[0])},
                'detected': [{'bbox': d['bbox'], 'class_id': d['class_id'], 'label': d['label'], 'confidence': d['confidence']}
                             for d in captured['detected']],
                'records': [{'bbox': r['bbox'], 'class_id': r['class_id'], 'label': r['label'], 'confidence': r['confidence'],
                             'quality': r['quality'], 'truncated_objects': r['truncated_objects'], 'feature': r['feature']}
                            for r in records]}
        if 'dino' in captured:
            captured['dino'].astype('<f4').tofile(out / f'dino_{name}.f32')
            case['dino'] = {'file': f'dino_{name}.f32', 'records': [i for i, r in enumerate(records) if r['quality']['accepted'] or r['quality']['unknown_reason'] == 'invalid_object_embedding']}
        cases.append(case)
        accepted = sum(r['feature'] is not None for r in records)
        print(f"{name}: {frame.shape[1]}x{frame.shape[0]} -> {letterboxed.shape[1]}x{letterboxed.shape[0]}, "
              f"{len(captured['detected'])} detections, {len(records)} records, {accepted} embedded", flush=True)

    # Unit cases. Letterbox: the exact transform BasePredictor.pre_transform builds for a .pt model (rect, stride 32).
    rng = np.random.default_rng(20261017)
    units = {'letterbox': [], 'quality': [], 'dino': []}
    stride = int(detector.detector.model.stride.max())
    for width, height in LETTERBOX_SIZES:
        frame = synthetic(rng, width, height)
        boxed = LetterBox(detector.detector.predictor.imgsz, auto=True, stride=stride)(image=np.ascontiguousarray(frame[:, :, ::-1]))[:, :, ::-1]
        name = f'unit_lb_{width}x{height}'
        frame.tofile(out / f'{name}_in.bin'); np.ascontiguousarray(boxed).tofile(out / f'{name}_out.bin')
        units['letterbox'].append({'width': width, 'height': height, 'in': f'{name}_in.bin', 'out': f'{name}_out.bin', 'shape': list(boxed.shape[:2])})
    # Quality gate (objects.py extract) and DINOv2 preprocessing (_appearance_inputs) on random boxes of one frame.
    frame = synthetic(rng, 1280, 720)
    frame[200:520, 300:900] = cv2.GaussianBlur(frame[200:520, 300:900], (0, 0), 6)  # a region that fails the blur gate
    frame.tofile(out / 'unit_crop_frame.bin')
    boxes = [[0., 0., 1280., 720.], [0.4, 0.6, 33.2, 31.9], [5.5, 7.25, 6.75, 300.], [1000.5, 700.2, 1280., 720.]]
    boxes += [[x1, y1, x1 + w, y1 + h] for x1, y1, w, h in zip(rng.uniform(0, 1100, 40), rng.uniform(0, 600, 40),
                                                                   rng.uniform(8, 600, 40), rng.uniform(8, 400, 40))]
    boxes += [[310., 210., 880., 500.], [400.3, 250.7, 470.1, 330.9]]  # inside the blurred region
    crops = []
    for x1, y1, x2, y2 in boxes:
        x2, y2 = min(x2, 1280.), min(y2, 720.)
        crop = frame[int(y1):math.ceil(y2), int(x1):math.ceil(x2)]  # objects.py extract, verbatim
        blur = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), cv2.CV_64F).var()) if crop.size else 0
        units['quality'].append({'box': [x1, y1, x2, y2], 'blur': blur})
        crops.append(Image.fromarray(crop))
    pixel_values = detector._appearance_inputs(crops)['pixel_values'].numpy()
    pixel_values.astype('<f4').tofile(out / 'unit_dino.f32')
    units['dino'] = {'file': 'unit_dino.f32', 'count': len(crops)}

    weights = json.loads((Path(a.weights) / 'manifest-object-yoloe.json').read_text())['files']
    meta = {'version': detector.version, 'torch': torch.__version__, 'ultralytics': ultralytics.__version__, 'opencv': cv2.__version__,
            'pillow': PIL.__version__, 'transformers': transformers.__version__, 'numpy': np.__version__,
            'machine': platform.machine(), 'python': platform.python_version(),
            'yoloe_sha256': weights['yoloe']['sha256'], 'dinov2_sha256': weights['dinov2']['sha256'],
            'objects_py_sha256': hashlib.sha256(Path(objects.__file__).read_bytes()).hexdigest(),
            'max_objects': detector.max_objects, 'confidence': detector.confidence}
    (out / 'reference.json').write_text(json.dumps({'meta': meta, 'cases': cases, 'units': units}))
    print(f"wrote {out / 'reference.json'}: {len(cases)} cases, {len(units['letterbox'])} letterbox / "
          f"{len(units['quality'])} quality / {units['dino']['count']} dino unit cases")


if __name__ == '__main__':
    main()

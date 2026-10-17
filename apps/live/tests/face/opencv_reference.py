"""OpenCV reference for the browser face pipeline parity test (see README.md).

For every source image and detection size it writes the resized frame as PNG (the exact pixels both sides use),
runs cv2.FaceDetectorYN + cv2.FaceRecognizerSF the way services/recognition/entity_worker/faces.py does, and
records boxes, scores, landmarks, alignCrop output and L2-normalised embeddings in reference.json. It also dumps
the raw YuNet network outputs so the Node side can check decode + NMS bit-for-bit, independent of the runtime.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.dont_write_bytecode = True  # do not leave a .pyc next to the server module
sys.path.insert(0, str(REPO / 'services' / 'recognition'))
from download_models import MODELS  # noqa: E402  pinned filenames + sha256, the server's source of truth

YUNET_OUTPUTS = [f'{kind}_{stride}' for kind in ('cls', 'obj', 'bbox', 'kps') for stride in (8, 16, 32)]


def model_path(models_dir, key):
    _, filename, sha256, _ = MODELS[key]
    path = models_dir / filename
    if hashlib.sha256(path.read_bytes()).hexdigest() != sha256:
        raise SystemExit(f'checksum mismatch: {path}')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', type=Path, default=Path('/tmp/live-face-images/src'))
    parser.add_argument('--models', type=Path, default=Path('/tmp/live-models'))
    parser.add_argument('--out', type=Path, default=Path('/tmp/live-face-images/out'))
    parser.add_argument('--sizes', type=int, nargs='+', default=[320, 640], help='longer side after resize')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    yunet, sface = model_path(args.models, 'yunet'), model_path(args.models, 'sface')
    cv2.setNumThreads(1)
    detector = cv2.FaceDetectorYN.create(str(yunet), '', (320, 320), .9, .3, 5000,
                                         cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
    recognizer = cv2.FaceRecognizerSF.create(str(sface), '', cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
    raw_net = cv2.dnn.readNet(str(yunet))
    raw_net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
    cases = []

    def run_case(name, source, frame):
        height, width = frame.shape[:2]
        cv2.imwrite(str(args.out / f'{name}.png'), frame)
        detector.setInputSize((width, height))
        _, detected = detector.detect(frame)
        faces = []
        for index, face in enumerate([] if detected is None else detected):
            aligned = recognizer.alignCrop(frame, face)
            cv2.imwrite(str(args.out / f'{name}_face{index}.png'), aligned)
            embedding = recognizer.feature(aligned).reshape(-1).astype(np.float64)
            faces.append({'box': face[:4].tolist(), 'score': float(face[14]),
                          'landmarks': face[4:14].reshape(5, 2).tolist(),
                          'embedding': (embedding / np.linalg.norm(embedding)).tolist(),
                          'aligned_png': f'{name}_face{index}.png'})
        # Same blob FaceDetectorYN builds: bottom/right zero pad to a multiple of 32, blobFromImage defaults.
        pad_w, pad_h = (width + 31) // 32 * 32, (height + 31) // 32 * 32
        padded = cv2.copyMakeBorder(frame, 0, pad_h - height, 0, pad_w - width, cv2.BORDER_CONSTANT, value=0)
        raw_net.setInput(cv2.dnn.blobFromImage(padded))
        raw = {}
        for output_name, blob in zip(YUNET_OUTPUTS, raw_net.forward(YUNET_OUTPUTS)):
            blob = np.ascontiguousarray(blob, dtype='<f4')
            blob.tofile(args.out / f'{name}_{output_name}.f32')
            raw[output_name] = {'dims': list(blob.shape), 'file': f'{name}_{output_name}.f32'}
        cases.append({'name': name, 'source': source.name, 'png': f'{name}.png', 'width': width,
                      'height': height, 'faces': faces, 'raw_outputs': raw})
        print(f'{name}: {width}x{height}, {len(faces)} face(s)')
        return faces

    for source in sorted(p for p in args.images.iterdir() if p.suffix.lower() in ('.jpg', '.jpeg', '.png')):
        image = cv2.imread(str(source), cv2.IMREAD_COLOR)
        for size in args.sizes:
            scale = size / max(image.shape[:2])
            width, height = round(image.shape[1] * scale), round(image.shape[0] * scale)
            frame = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)
            faces = run_case(f'{source.stem}_{size}', source, frame)
        if faces:
            # Edge case: crop the largest frame so the first face is cut at the top-left border, which exercises
            # warpAffine's constant border and an odd frame size.
            x, y, w, h = faces[0]['box']
            run_case(f'{source.stem}_edge', source, frame[int(y + .2 * h):, int(x + .2 * w):].copy())
    (args.out / 'reference.json').write_text(json.dumps({'opencv': cv2.__version__, 'cases': cases}))
    print(f'wrote {args.out / "reference.json"} (OpenCV {cv2.__version__})')


if __name__ == '__main__':
    main()

from __future__ import annotations
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np

class FaceModel:
    """Pinned YuNet + SFace on CPU. Output IDs are application-owned estimates."""
    def __init__(self, weights: Path):
        manifest = json.loads((weights / 'manifest.json').read_text())
        paths = {}
        for name in ('yunet', 'sface'):
            item = manifest['models'][name]
            path = weights / item['filename']
            if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('model_checksum_mismatch')
            paths[name] = str(path)
        cv2.setNumThreads(1)
        self.detector = cv2.FaceDetectorYN.create(paths['yunet'], '', (320, 320), .9, .3, 5000,
            cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
        self.recognizer = cv2.FaceRecognizerSF.create(paths['sface'], '',
            cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
        self.version = ('yunet-' + manifest['models']['yunet']['sha256'][:16] + ':sface-' +
            manifest['models']['sface']['sha256'][:16] + ':cv-' + cv2.__version__ + ':quality-v1')

    def infer(self, frame):
        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _, detected = self.detector.detect(frame)
        if detected is None:
            return []
        detected = sorted(detected, key=lambda face: (float(face[0]), float(face[1])))
        result = []
        for face in detected[:16]:
            x, y, w, h = map(float, face[:4])
            left, top = max(0, int(x)), max(0, int(y))
            right, bottom = min(width, int(x+w)), min(height, int(y+h))
            crop = frame[top:bottom, left:right]
            blur = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()) if crop.size else 0
            eye_distance = float(np.linalg.norm(face[4:6] - face[6:8]))
            reason = ('face_too_small' if min(w, h) < 64 else 'face_blurred' if blur < 50 else
                      'pose_or_landmarks_weak' if eye_distance < .20 * w else None)
            record = {'bbox_xywh': [x, y, w, h], 'frame_width': width, 'frame_height': height,
                      'detection_score': float(face[-1]), 'blur_laplacian_variance': blur,
                      'quality': 'accepted' if reason is None else 'unknown', 'unknown_reason': reason,
                      'truncated_faces': len(detected) > 16, 'embedding': None}
            if reason is None:
                aligned = self.recognizer.alignCrop(frame, face)
                embedding = self.recognizer.feature(aligned).reshape(-1).astype(np.float64)
                norm = float(np.linalg.norm(embedding))
                if not np.isfinite(embedding).all() or norm <= 0:
                    record.update(quality='unknown', unknown_reason='invalid_embedding')
                else:
                    record['embedding'] = (embedding / norm).tolist()
            result.append(record)
        return result

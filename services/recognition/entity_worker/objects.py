"""YOLOE prompt-free proposals and DINOv2 anonymous appearance descriptors."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import threading

import cv2
import numpy as np
from PIL import Image
import torch
import transformers
import ultralytics
from ultralytics import YOLOE
from transformers import AutoModel


# The separate face/person flow owns people. PF class IDs are not COCO IDs.
PERSON_LABELS = frozenset(('person', 'people', 'human', 'human being', 'man',
                          'woman', 'boy', 'girl', 'child', 'children', 'baby'))


class ObjectDetector:
    def __init__(self, weights: Path, device='cpu', confidence=.25, max_objects=8, threads=2):
        if device not in ('cpu', 'cuda'):
            raise ValueError('object_device_must_be_cpu_or_cuda')
        if not .1 <= confidence <= .95 or not 1 <= max_objects <= 16 or not 1 <= threads <= 4:
            raise ValueError('object_limits_out_of_range')
        self.weights = Path(weights)
        manifest = json.loads((self.weights / 'manifest-object-yoloe.json').read_text())
        for key in ('yoloe', 'dinov2', 'dinov2_config', 'dinov2_preprocessor'):
            item = manifest['files'][key]
            path = self.weights / item['filename']
            if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('object_model_checksum_mismatch:' + key)
        self.device = device
        self.confidence, self.max_objects = confidence, max_objects
        self.lock = threading.Lock()
        cv2.setNumThreads(threads)
        torch.set_num_threads(threads)
        self.detector = YOLOE(str(self.weights / manifest['files']['yoloe']['filename'])).to(device)
        local = self.weights / 'dinov2-small'
        # This pinned BitImageProcessor config is simple resize/crop/normalize.
        # Apply it directly with Pillow to avoid adding a platform-specific
        # torchvision binary dependency to the existing GB10 torch installation.
        self.preprocess_config = json.loads((local / 'preprocessor_config.json').read_text())
        if self.preprocess_config['image_processor_type'] != 'BitImageProcessor':
            raise ValueError('object_unsupported_appearance_preprocessor')
        self.appearance = AutoModel.from_pretrained(local, local_files_only=True, trust_remote_code=False).eval().to(device)
        self.detector_version = 'yoloe-26l-pf-' + manifest['files']['yoloe']['sha256'][:16]
        self.feature_version = 'dinov2-small-' + manifest['files']['dinov2']['sha256'][:16]
        config_hash = hashlib.sha256((manifest['files']['dinov2_config']['sha256'] +
                                     manifest['files']['dinov2_preprocessor']['sha256']).encode()).hexdigest()[:12]
        self.version = (f'{self.detector_version}:{self.feature_version}:config-{config_hash}:'
            f'ultralytics-{ultralytics.__version__}:cv-{cv2.__version__}:torch-{torch.__version__}:tf-{transformers.__version__}:'
            f'{device}:bgr640-yoloe:crop-cls-l2-v1:conf{confidence:g}:max{max_objects}')

    def _appearance_inputs(self, images):
        config = self.preprocess_config
        edge = config['size']['shortest_edge']
        crop_h, crop_w = config['crop_size']['height'], config['crop_size']['width']
        mean = np.asarray(config['image_mean'], dtype=np.float32)
        std = np.asarray(config['image_std'], dtype=np.float32)
        tensors = []
        for image in images:
            width, height = image.size
            if width <= height:
                resized = (edge, int(edge * height / width))
            else:
                resized = (int(edge * width / height), edge)
            image = image.resize(resized, resample=Image.Resampling(config['resample']))
            left, top = (resized[0] - crop_w) // 2, (resized[1] - crop_h) // 2
            image = image.crop((left, top, left + crop_w, top + crop_h))
            array = (np.asarray(image).astype(np.float32) * config['rescale_factor'] - mean) / std
            tensors.append(array.transpose(2, 0, 1))
        return {'pixel_values': torch.from_numpy(np.stack(tensors)).to(self.device)}

    def _detect(self, frame):
        height, width = frame.shape[:2]
        # Ultralytics ndarray inputs are BGR; descriptor crops below stay RGB.
        bgr = np.ascontiguousarray(frame[:, :, ::-1])
        result = self.detector.predict(bgr, imgsz=640, conf=self.confidence,
            iou=.5, max_det=100, device=self.device, quantize=16 if self.device == 'cuda' else None,
            verbose=False)[0]
        if result.boxes is None:
            return []
        output = []
        for values in result.boxes.data.detach().float().cpu().tolist():
            if len(values) != 6 or not all(math.isfinite(value) for value in values):
                raise ValueError('object_invalid_detector_output')
            x1, y1, x2, y2, confidence, class_id = values
            label = result.names[int(class_id)]
            if label.casefold() in PERSON_LABELS:
                continue
            x1, y1 = max(0., x1), max(0., y1)
            x2, y2 = min(float(width), x2), min(float(height), y2)
            if x2 > x1 and y2 > y1:
                output.append({'bbox': [x1, y1, x2, y2], 'class_id': int(class_id),
                               'label': label, 'confidence': confidence})
        return sorted(output, key=lambda item: (-item['confidence'], item['class_id'], item['bbox'][0]))

    def extract(self, frame):
        """Accept RGB uint8 HWC; return <=max_objects boxes and normalized features.

        Low-quality detections remain visible with feature=None. A feature is an
        appearance candidate only; identical objects cannot be reliably resolved.
        This instance is serialized because the detector predictor is mutable.
        """
        if (not isinstance(frame, np.ndarray) or frame.dtype != np.uint8 or frame.ndim != 3
                or frame.shape[2] != 3 or min(frame.shape[:2]) < 8 or max(frame.shape[:2]) > 4096):
            raise ValueError('object_input_requires_rgb_uint8_bounded_frame')
        with self.lock:
            detected = self._detect(frame)
            records, crops, positions = [], [], []
            for item in detected[:self.max_objects]:
                x1, y1, x2, y2 = item['bbox']
                crop = frame[int(y1):math.ceil(y2), int(x1):math.ceil(x2)]
                blur = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), cv2.CV_64F).var()) if crop.size else 0
                reason = ('object_too_small' if min(x2 - x1, y2 - y1) < 32 else
                          'object_blurred' if blur < 20 else None)
                item.update(feature=None, model=self.detector_version, feature_model=self.feature_version,
                    frame_width=int(frame.shape[1]), frame_height=int(frame.shape[0]),
                    quality={'accepted': reason is None, 'unknown_reason': reason,
                             'blur_laplacian_variance': blur,
                             'touches_frame_boundary': x1 <= 1 or y1 <= 1 or x2 >= frame.shape[1]-1 or y2 >= frame.shape[0]-1},
                    truncated_objects=len(detected) > self.max_objects,
                    identity_semantics='appearance_candidate_not_proof_of_same_physical_object')
                records.append(item)
                if reason is None:
                    crops.append(Image.fromarray(crop))
                    positions.append(len(records) - 1)
            # A bounded batch amortizes descriptor work, with at most 8 crops by
            # default. Source frame/offset provenance is attached by coordinator.
            if crops:
                inputs = self._appearance_inputs(crops)
                with torch.inference_mode():
                    output = self.appearance(**inputs)
                    embeddings = output.last_hidden_state[:, 0, :].float()
                    norms = embeddings.norm(dim=-1, keepdim=True)
                    embeddings = (embeddings / norms.clamp_min(1e-12)).cpu().numpy()
                for index, feature, norm in zip(positions, embeddings, norms.flatten().cpu().tolist()):
                    if not np.isfinite(feature).all() or norm <= 0:
                        records[index]['quality'].update(accepted=False, unknown_reason='invalid_object_embedding')
                    else:
                        records[index]['feature'] = feature.tolist()
            return records

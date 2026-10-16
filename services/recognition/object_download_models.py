"""Fetch checksum-pinned official YOLOE-26L-PF and DINOv2-S/14 assets."""
import os
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(os.environ.get('ENTITY_WEIGHTS_DIR', Path(__file__).parent / 'weights'))
YOLOE_RELEASE = 'v8.4.0'
ULTRALYTICS_VERSION = '8.4.175'
DINO_REVISION = 'ed25f3a31f01632728cabb09d1542f84ab7b0056'
YOLO_SHA = '8b0ff5ecfd5baa0ebed509efb00aacff52faae2f6770e7ffa2a223231b9653c0'
DINO_SHA = 'ae1e99fcefd534ed978cdeb8326f08030c96e28b7a81ffcbc98a857c84d14be1'


def fetch(relative, url, expected_sha=None, expected_size=None):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and expected_sha and hashlib.sha256(path.read_bytes()).hexdigest() == expected_sha:
        data = path.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read((expected_size + 1) if expected_size else 2_000_000)
        if expected_size is not None and len(data) != expected_size:
            raise RuntimeError('object_weight_size_mismatch: ' + relative)
        digest = hashlib.sha256(data).hexdigest()
        if expected_sha is not None and digest != expected_sha:
            raise RuntimeError('object_weight_checksum_mismatch: ' + relative)
        temporary = path.with_suffix(path.suffix + '.download')
        temporary.write_bytes(data)
        temporary.replace(path)
    return {'filename': relative, 'url': url, 'sha256': hashlib.sha256(data).hexdigest(), 'size_bytes': len(data)}


def main():
    ROOT.mkdir(exist_ok=True)
    model_url = f'https://github.com/ultralytics/assets/releases/download/{YOLOE_RELEASE}/yoloe-26l-seg-pf.pt'
    dino = f'https://huggingface.co/facebook/dinov2-small/resolve/{DINO_REVISION}/'
    files = {
        'yoloe': fetch('yoloe-26l-seg-pf.pt', model_url, YOLO_SHA, 94_606_901),
        'yoloe_license': fetch('object-yoloe.LICENSE',
            f'https://raw.githubusercontent.com/ultralytics/ultralytics/v{ULTRALYTICS_VERSION}/LICENSE',
            '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0', 34_523),
        'dinov2': fetch('dinov2-small/model.safetensors', dino + 'model.safetensors', DINO_SHA, 88_249_960),
        'dinov2_config': fetch('dinov2-small/config.json', dino + 'config.json',
            '1809f83e3bdb1609a501a610ad4a742f4fd8ae44d72ca4aa0df52d1f2ac8628d', 547),
        'dinov2_preprocessor': fetch('dinov2-small/preprocessor_config.json', dino + 'preprocessor_config.json',
            '14e780d86fa1861f8751f868d7f45425b5feb55c38ca26f152ca5097ab30f828', 436),
        'dinov2_license': fetch('dinov2-small/LICENSE', 'https://raw.githubusercontent.com/facebookresearch/dinov2/main/LICENSE',
            '600cc67cc4cb2f5ea317dcfc687ad1c74dc4bec8782bbe9db0afd83513b935b7', 11_359),
    }
    manifest = {'detector': {'name': 'Ultralytics YOLOE-26L prompt-free', 'revision': YOLOE_RELEASE,
                             'runtime_version': ULTRALYTICS_VERSION, 'license': 'AGPL-3.0'},
                'appearance': {'name': 'facebook/dinov2-small', 'revision': DINO_REVISION, 'license': 'Apache-2.0'},
                'files': files}
    (ROOT / 'manifest-object-yoloe.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'detector': manifest['detector'], 'appearance': manifest['appearance'],
                      'weights': {key: {'sha256': files[key]['sha256'], 'size_bytes': files[key]['size_bytes']}
                                  for key in ('yoloe', 'dinov2')}}))


if __name__ == '__main__':
    main()

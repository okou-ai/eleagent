"""Prepare pinned OpenCV Zoo files, verifying cached files before reuse."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request

REVISION = '47534e27c9851bb1128ccc0102f1145e27f23f98'
MODELS = {
    'yunet': ('face_detection_yunet', 'face_detection_yunet_2023mar.onnx',
              '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', 232589),
    'sface': ('face_recognition_sface', 'face_recognition_sface_2021dec.onnx',
              '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79', 38696353),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--weights-dir', type=Path, default=Path(os.environ.get(
        'ENTITY_WEIGHTS_DIR', Path(__file__).parent / 'weights')))
    parser.add_argument('--offline', action='store_true', help='Require existing weights and license files')
    args = parser.parse_args()
    root = args.weights_dir
    root.mkdir(parents=True, exist_ok=True)
    manifest = {'repository': 'https://github.com/opencv/opencv_zoo', 'revision': REVISION, 'models': {}}
    for key, (folder, filename, expected, expected_size) in MODELS.items():
        relative = f'models/{folder}/{filename}'
        url = f'https://media.githubusercontent.com/media/opencv/opencv_zoo/{REVISION}/{relative}'
        path = root / filename
        valid = path.is_file() and path.stat().st_size == expected_size
        valid = valid and hashlib.sha256(path.read_bytes()).hexdigest() == expected
        if not valid:
            if args.offline:
                raise ValueError('cached_weight_missing_or_invalid:' + filename)
            data = urllib.request.urlopen(url, timeout=120).read(expected_size + 1)
            if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected:
                raise ValueError('weight_checksum_mismatch:' + filename)
            temporary = path.with_suffix('.download')
            temporary.write_bytes(data)
            temporary.replace(path)
        license_url = f'https://raw.githubusercontent.com/opencv/opencv_zoo/{REVISION}/models/{folder}/LICENSE'
        license_path = root / (key + '.LICENSE')
        if not license_path.is_file() or not license_path.stat().st_size:
            if args.offline:
                raise ValueError('cached_license_missing:' + license_path.name)
            license_path.write_bytes(urllib.request.urlopen(license_url, timeout=30).read())
        manifest['models'][key] = {'filename': filename, 'sha256': expected, 'size_bytes': expected_size,
                                   'url': url, 'license_url': license_url}
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'revision': REVISION, 'models': {
        key: {'sha256': value['sha256'], 'size_bytes': value['size_bytes']}
        for key, value in manifest['models'].items()}}))


if __name__ == '__main__':
    main()

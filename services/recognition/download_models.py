"""Download official, commit-pinned OpenCV Zoo files; verify upstream Git LFS hashes."""
import os
import hashlib, json, pathlib, urllib.request
REVISION = '47534e27c9851bb1128ccc0102f1145e27f23f98'
ROOT = pathlib.Path(os.environ.get('ENTITY_WEIGHTS_DIR', pathlib.Path(__file__).parent / 'weights'))
MODELS = {
 'yunet': ('face_detection_yunet', 'face_detection_yunet_2023mar.onnx'),
 'sface': ('face_recognition_sface', 'face_recognition_sface_2021dec.onnx'),
}
def main():
 ROOT.mkdir(exist_ok=True)
 manifest = {'repository': 'https://github.com/opencv/opencv_zoo', 'revision': REVISION, 'models': {}}
 for key, (folder, filename) in MODELS.items():
  relative = f'models/{folder}/{filename}'
  raw_url = f'https://raw.githubusercontent.com/opencv/opencv_zoo/{REVISION}/{relative}'
  pointer = urllib.request.urlopen(raw_url, timeout=30).read().decode()
  expected = next(line.split('sha256:')[1] for line in pointer.splitlines() if line.startswith('oid sha256:'))
  expected_size = int(next(line.split()[1] for line in pointer.splitlines() if line.startswith('size ')))
  url = f'https://media.githubusercontent.com/media/opencv/opencv_zoo/{REVISION}/{relative}'
  path = ROOT / filename
  if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
   data = urllib.request.urlopen(url, timeout=120).read(expected_size + 1)
   if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected: raise RuntimeError('weight checksum mismatch')
   temporary = path.with_suffix('.download'); temporary.write_bytes(data); temporary.replace(path)
  license_url = f'https://raw.githubusercontent.com/opencv/opencv_zoo/{REVISION}/models/{folder}/LICENSE'
  (ROOT / (key + '.LICENSE')).write_bytes(urllib.request.urlopen(license_url, timeout=30).read())
  manifest['models'][key] = {'filename':filename, 'sha256':expected, 'size_bytes':expected_size, 'url':url, 'license_url':license_url}
 (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
 print(json.dumps({'revision':REVISION,'models':{key:{'sha256':value['sha256'],'size_bytes':value['size_bytes']} for key,value in manifest['models'].items()}}))
if __name__ == '__main__': main()

"""Server-side CAM++ reference for the browser voice parity test.

Runs the production code path on fixed clips of the sherpa-onnx test wavs:
  embedding = entity_worker.speech.Models.embed (FunASR AutoModel(...).generate, L2-normalised)
  features  = funasr.utils.fbank.fbank(num_mel_bins=80), the call funasr.models.campplus.utils.extract_feature makes
Writes clip samples (f32), raw fbank (f32, frames x 80) and reference.json to --out for parity.mjs.

  python campplus_reference.py --wavs <test_wavs dir> --campplus <funasr/campplus dir> --out <dir> \
      [--recognition-src services/recognition]   # dir containing entity_worker (cwd /app in the image)
"""
import argparse, hashlib, json, platform, sys, time, wave
from pathlib import Path
import numpy as np

SR = 16000
# name, wav, start s, end s (None = whole file). Slices cover 1.5/3/8 s plus odd and short lengths.
CLIPS = [(n, n + '.wav', None, None) for n in ('0', '1', '2', '3', '4', '46')] + [
    ('4_1.5s', '4.wav', 0.5, 2.0), ('4_3s', '4.wav', 2.0, 5.0), ('4_8s', '4.wav', 5.0, 13.0),
    ('0_1.5s', '0.wav', 0.3, 1.8), ('0_3s', '0.wav', 2.0, 5.0), ('0_8s', '0.wav', 2.0, 10.0),
    ('1_2.37s', '1.wav', 0.41, 2.78), ('3_0.6s', '3.wav', 1.0, 1.6),
]


def read_wav(path):
    with wave.open(str(path)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, SR), path
        pcm = np.frombuffer(w.readframes(w.getnframes()), '<i2')
    return (pcm.astype(np.float32) / 32768).astype(np.float32)  # exact; ffmpeg f32le decode gives the same values


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--wavs', required=True); p.add_argument('--campplus', required=True); p.add_argument('--out', required=True)
    p.add_argument('--recognition-src', help='dir containing entity_worker (default: this repo)')
    p.add_argument('--threads', type=int, default=2)
    a = p.parse_args()
    sys.dont_write_bytecode = True  # leave no __pycache__ beside the server code
    sys.path.insert(0, a.recognition_src or str(Path(__file__).resolve().parents[4] / 'services' / 'recognition'))
    import torch, funasr
    from funasr import AutoModel
    from funasr.utils import fbank as kaldi
    from entity_worker.speech import Models
    torch.set_num_threads(a.threads)
    models = Models.__new__(Models)  # only the CAM++ part of Models.__init__ (speech.py:110)
    models.campp = AutoModel(model=str(a.campplus), device='cpu', disable_update=True)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    weights = Path(a.campplus) / 'campplus_cn_common.bin'
    meta = {'torch': torch.__version__, 'funasr': funasr.__version__, 'machine': platform.machine(), 'python': platform.python_version(),
            'fbank_backend': 'torchaudio' if kaldi._HAS_TORCHAUDIO else 'kaldi-native-fbank',
            'weights_sha256': hashlib.sha256(weights.read_bytes()).hexdigest(),
            'speech_py_sha256': hashlib.sha256(Path(sys.modules['entity_worker.speech'].__file__).read_bytes()).hexdigest()}
    clips = []
    for name, wav, start, end in CLIPS:
        audio = read_wav(Path(a.wavs) / wav)
        if start is not None:
            audio = audio[round(start * SR):round(end * SR)].copy()
        audio.tofile(out / f'clip_{name}.f32')
        with torch.inference_mode():
            fb = kaldi.fbank(torch.from_numpy(audio).unsqueeze(0), num_mel_bins=80).numpy()
        fb.astype(np.float32).tofile(out / f'fbank_{name}.f32')
        started = time.perf_counter()
        embedding = models.embed(audio)  # exact server method (speech.py:122-125)
        clips.append({'name': name, 'wav': wav, 'start': start, 'end': end, 'samples': len(audio), 'frames': int(fb.shape[0]),
                      'embed_ms': round((time.perf_counter() - started) * 1000, 1), 'embedding': embedding.tolist()})
        print(name, len(audio) / SR, fb.shape, clips[-1]['embed_ms'], 'ms', flush=True)
    (out / 'reference.json').write_text(json.dumps({'meta': meta, 'clips': clips}))


if __name__ == '__main__':
    main()

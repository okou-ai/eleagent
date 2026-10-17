"""Export the server's DINOv2-small appearance model (entity_worker/objects.py) to ONNX for onnxruntime-web.

  python -I export_dinov2.py --weights <ENTITY_WEIGHTS_DIR> --out <models>/dinov2.onnx [--ref <reference dir>] \
      [--fp16-weights <models>/dinov2-fp16w.onnx]

Graph: input `pixel_values` float32 [N, 3, 224, 224] (objects.js prepareDinoInput), output `embedding` float32
[N, 384] = last_hidden_state[:, 0, :] (CLS after the final LayerNorm), not normalised. The model is loaded exactly
as ObjectDetector loads it (AutoModel.from_pretrained, local files, default attention). The one change: for a 224x224
input Dinov2Embeddings.interpolate_pos_encoding always resizes the 37x37 position grid to 16x16 with bicubic +
antialias, which has no portable ONNX/WebGPU kernel; it is evaluated once here by that same torch call and baked in
as a constant (identical values), so the graph only accepts 224x224.

With --ref (objects_reference.py output) it compares onnxruntime against the server's features on the server's own
pixel_values. --fp16-weights also writes a copy with float16-stored initializers and a Cast back to float32.
"""
import argparse, hashlib, json, sys
from pathlib import Path
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--weights', required=True); p.add_argument('--out', required=True); p.add_argument('--ref')
    p.add_argument('--fp16-weights'); p.add_argument('--opset', type=int, default=17)
    a = p.parse_args()
    weights = Path(a.weights)
    manifest = json.loads((weights / 'manifest-object-yoloe.json').read_text())['files']
    for key in ('dinov2', 'dinov2_config', 'dinov2_preprocessor'):  # ObjectDetector.__init__ checks
        if hashlib.sha256((weights / manifest[key]['filename']).read_bytes()).hexdigest() != manifest[key]['sha256']:
            raise SystemExit('checksum mismatch: ' + key)
    import torch, onnxruntime as ort
    from transformers import AutoModel
    sys.dont_write_bytecode = True  # no __pycache__ in the repo
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from export_yoloe import fp16_weights, simplify
    torch.set_num_threads(2)
    model = AutoModel.from_pretrained(weights / 'dinov2-small', local_files_only=True, trust_remote_code=False).eval()
    embeddings = model.embeddings
    with torch.no_grad():
        dummy = torch.zeros(1, 1 + (224 // embeddings.patch_size) ** 2, model.config.hidden_size)
        position = embeddings.interpolate_pos_encoding(dummy, 224, 224).clone()  # the server's own computation
    embeddings.interpolate_pos_encoding = lambda tokens, height, width: position

    class Cls(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model

        def forward(self, pixel_values):
            return self.model(pixel_values=pixel_values).last_hidden_state[:, 0, :]

    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(Cls().eval(), (torch.randn(2, 3, 224, 224),), str(out), input_names=['pixel_values'],
                          output_names=['embedding'], dynamic_axes={'pixel_values': {0: 'batch'}, 'embedding': {0: 'batch'}},
                          opset_version=a.opset, dynamo=False, do_constant_folding=True)
    import onnx
    onnx.save(simplify(out), str(out))
    del embeddings.interpolate_pos_encoding  # back to the original method for the torch comparison below
    session = ort.InferenceSession(str(out), providers=['CPUExecutionProvider'])
    batches = []
    if a.ref:
        ref = json.loads((Path(a.ref) / 'reference.json').read_text())
        for case in ref['cases']:
            if 'dino' in case:
                pixels = np.fromfile(Path(a.ref) / case['dino']['file'], '<f4').reshape(-1, 3, 224, 224)
                want = np.array([case['records'][i]['feature'] for i in case['dino']['records']], np.float32)
                batches.append((case['name'], pixels, want))
    else:
        batches.append(('random', np.random.default_rng(0).normal(0, 1, (3, 3, 224, 224)).astype(np.float32), None))
    worst = 1.
    for name, pixels, want in batches:
        with torch.inference_mode():
            torch_cls = model(pixel_values=torch.from_numpy(pixels)).last_hidden_state[:, 0, :].numpy()
        got = session.run(None, {'pixel_values': pixels})[0]
        unit = got / np.linalg.norm(got, axis=1, keepdims=True)
        line = f'{name:28s} n={len(pixels)} onnx~torch max|d| {np.abs(got - torch_cls).max():.2e}'
        if want is not None:
            cos = (unit * want).sum(1)
            worst = min(worst, float(cos.min()))
            line += f' onnx~server min cos {cos.min():.7f}'
        print(line, flush=True)
    data = out.read_bytes()
    report = {'path': str(out), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
              'inputs': [(i.name, i.shape) for i in session.get_inputs()],
              'outputs': [(o.name, o.shape) for o in session.get_outputs()], 'worst_cos': worst}
    if a.fp16_weights:
        fp16_weights(out, a.fp16_weights)
        half = Path(a.fp16_weights).read_bytes()
        report['fp16_weights'] = {'path': a.fp16_weights, 'bytes': len(half), 'sha256': hashlib.sha256(half).hexdigest()}
    print(json.dumps(report))


if __name__ == '__main__':
    main()

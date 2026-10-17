"""Export the server's CAM++ (funasr/campplus, built exactly like speech.py:110) to ONNX for onnxruntime-web.

  python export_campplus.py --campplus <funasr/campplus dir> --out /tmp/live-models/campplus.onnx [--ref <reference dir>]

Graph: input `feats` float32 [1, frames, 80] (CMN'd fbank, see voice.js prepareCamppInput),
output `embedding` float32 [1, 192] (raw, not normalised). With --ref, checks onnxruntime against
the unmodified torch model on every reference clip's server features.

Weights are byte-identical; one op is re-expressed for portability: CAMLayer.seg_pooling's
avg_pool1d(ceil_mode=True) (a partial last window divided by its real length) becomes an explicit
segment-mean matmul, so execution providers with divergent ceil_mode AveragePool (e.g. WebGPU) agree.
"""
import argparse, hashlib, json
from pathlib import Path
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--campplus', required=True); p.add_argument('--out', required=True); p.add_argument('--ref')
    a = p.parse_args()
    import torch, onnxruntime as ort
    from funasr import AutoModel
    from funasr.models.campplus import components
    model = AutoModel(model=a.campplus, device='cpu', disable_update=True).model.eval()
    if a.ref:
        from funasr.models.campplus.utils import extract_feature
        ref = json.loads((Path(a.ref) / 'reference.json').read_text())
        clips = [np.fromfile(Path(a.ref) / f"clip_{c['name']}.f32", np.float32) for c in ref['clips']]
        feats = [extract_feature([torch.from_numpy(x)])[0] for x in clips]
    else:
        feats = [torch.randn(1, n, 80) for n in (40, 58, 148, 200, 201, 235, 298, 388, 798, 1762)]
    with torch.inference_mode():
        wants = [model(f).numpy().reshape(-1) for f in feats]  # unmodified server model

    def seg_pooling(self, x, seg_len=100, stype='avg'):
        frames = torch.arange(x.shape[-1], device=x.device)
        segment = torch.div(frames, seg_len, rounding_mode='trunc')
        count = torch.div(x.shape[-1] + seg_len - 1, seg_len, rounding_mode='trunc')
        mask = (segment.unsqueeze(0) == torch.arange(count, device=x.device).unsqueeze(1)).to(x.dtype)  # [segments, frames]
        means = torch.matmul(x, (mask / mask.sum(1, keepdim=True)).transpose(0, 1))  # [B, C, segments]
        return means.index_select(-1, segment)
    components.CAMLayer.seg_pooling = seg_pooling
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(model, (torch.randn(1, 298, 80),), str(out), input_names=['feats'], output_names=['embedding'],
                      dynamic_axes={'feats': {0: 'batch', 1: 'frames'}, 'embedding': {0: 'batch'}}, opset_version=17, dynamo=False)
    session = ort.InferenceSession(str(out), providers=['CPUExecutionProvider'])
    worst = 1.
    for f, want in zip(feats, wants):
        got = session.run(None, {'feats': f.numpy()})[0].reshape(-1)
        cos = float(want @ got / np.linalg.norm(want) / np.linalg.norm(got))
        worst = min(worst, cos)
        print(f'frames {f.shape[1]:5d} cos {cos:.7f} max|d| {np.abs(want - got).max():.2e}')
    data = out.read_bytes()
    print(json.dumps({'path': str(out), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                      'inputs': [(i.name, i.shape) for i in session.get_inputs()],
                      'outputs': [(o.name, o.shape) for o in session.get_outputs()], 'worst_cos': worst}))


if __name__ == '__main__':
    main()

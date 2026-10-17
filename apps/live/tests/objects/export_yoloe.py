"""Export the server's YOLOE-26 prompt-free detector (entity_worker/objects.py) to a boxes-only ONNX for onnxruntime-web.

  python -I export_yoloe.py --weights <yoloe-26l-seg-pf.pt> --out <models>/yoloe.onnx --names <models>/yoloe-names.json \
      [--sha256 <hex>] [--ref <reference dir>] [--fp16-weights <models>/yoloe-fp16w.onnx]

Which head: the pinned .pt loads with end2end=False and objects.py predicts with the default nms=None, so the server
runs the one-to-many LRPC head + NMS (iou .5, class-agnostic: YOLOE.predict defaults agnostic_nms=True), NOT the
NMS-free one-to-one head; this export reproduces that.

Graph: input `images` float32 [1, 3, H, W] (RGB / 255, H and W multiples of 32, dynamic: the server's rect letterbox,
e.g. 1280x720 -> 640x384; a fixed 640x640 square input instead left 99 of 345 score >= 0.3 detections unmatched on the
test photos, cosine down to 0.913, and is ~45% slower; onnxruntime-web's WebGPU EP runs the dynamic shapes),
output `detections` float32 [1, anchors, 6] = per anchor x1, y1, x2, y2 (letterbox pixels), best class probability,
best class id. This is exactly what ultralytics' non_max_suppression derives from the raw head output before NMS
(xywh2xyxy, cls.max(1)); NMS, rescaling and filtering run in objects.js decodeYoloe. Removed vs the .pt forward:
the segmentation branch (mask coefficients + protos: the server only reads boxes, and SegmentationPredictor's
empty-mask filter dropped none of the detections on 73 images, 60 random COCO val2017 + the 13 test photos) and the
one-to-one branch. Re-expressed for static shapes: the LRPC proposal filter (pf sigmoid > 0.001 on levels P3/P4)
zeroes the anchor's score instead of boolean-indexing anchors away, and the max over the 4585 classes is taken on
logits per level before the sigmoid (same winner and value up to float ties), so no sigmoid over [anchors, 4585] and
the largest intermediate is one level's logits (P3 at 640x640: 6400 x 4585 floats, 117 MB, under WebGPU's default
128 MiB storage-binding limit).

With --ref (objects_reference.py output) it runs onnxruntime on the server's own letterboxed tensors and compares the
per-anchor rows with the server's raw head output. --fp16-weights additionally writes a copy whose float initializers
are stored as float16 with a Cast back to float32 (half the download, fp32 compute).
"""
import argparse, hashlib, json
from pathlib import Path
import numpy as np

YOLOE_26L_SHA256 = '8b0ff5ecfd5baa0ebed509efb00aacff52faae2f6770e7ffa2a223231b9653c0'  # object_download_models.py


def boxes_only(model):
    import torch
    from ultralytics.utils.tal import make_anchors, dist2bbox

    class BoxesOnly(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model

        def forward(self, images):
            # YOLOEModel.predict up to the head (the head ignores the class-prompt input in prompt-free mode).
            x, y = images, []
            for m in self.model.model[:-1]:
                if m.f != -1:
                    x = y[m.f] if isinstance(m.f, int) else [x if j == -1 else y[j] for j in m.f]
                x = m(x)
                y.append(x if m.i in self.model.save else None)
            head = self.model.model[-1]
            feats = [x if j == -1 else y[j] for j in head.f]
            boxes, best, classes = [], [], []
            for i in range(head.nl):  # YOLOEDetect.forward_lrpc + LRPCHead.forward(conf=head.conf)
                cls_feat, loc_feat, lrpc = head.cv3[i](feats[i]), head.cv2[i](feats[i]), head.lrpc[i]
                boxes.append(lrpc.loc(loc_feat).flatten(2))
                if lrpc.enabled:
                    value, index = lrpc.vocab(cls_feat.flatten(2).transpose(-1, -2)).max(-1)
                    keep = lrpc.pf(cls_feat)[:, 0].flatten(1).sigmoid() > head.conf
                    value = torch.where(keep, value.sigmoid(), torch.zeros_like(value))
                else:
                    value, index = lrpc.vocab(cls_feat).flatten(2).max(1)
                    value = value.sigmoid()
                best.append(value)
                classes.append(index)
            # Detect._get_decode_boxes (reg_max 1: DFL is identity), then ops.xywh2xyxy op for op (written with cat
            # instead of slice assignment, which would export as ScatterND).
            anchors, strides = (a.transpose(0, 1) for a in make_anchors(feats, head.stride, 0.5))
            dbox = dist2bbox(torch.cat(boxes, 2), anchors.unsqueeze(0), xywh=True, dim=1) * strides
            xy, wh = dbox[:, :2].transpose(1, 2), (dbox[:, 2:] / 2).transpose(1, 2)
            return torch.cat([xy - wh, xy + wh, torch.cat(best, 1)[..., None], torch.cat(classes, 1)[..., None].float()], -1)

    return BoxesOnly().eval()


def simplify(path):
    """onnxslim (as ultralytics' own ONNX export uses) folds the traced shape arithmetic; outputs are re-verified below.
    graph.value_info is dropped: onnxruntime re-infers shapes, and onnxslim's annotations vary between runs (nodes and
    weights do not), so dropping them keeps the exported bytes reproducible."""
    import onnx
    try:
        import onnxslim
        model = onnxslim.slim(onnx.load(str(path)))
    except ImportError:
        print('onnxslim not installed: graph left unsimplified')
        model = onnx.load(str(path))
    del model.graph.value_info[:]
    return model


def fix_output_shape(path):
    import onnx
    model = simplify(path)
    dims = model.graph.output[0].type.tensor_type.shape.dim
    dims[0].dim_value, dims[2].dim_value = 1, 6  # [1, anchors, 6]; the exporter leaves them symbolic
    onnx.save(model, str(path))


def fp16_weights(src, dst):
    """Store float32 initializers (>= 1024 elements) as float16 followed by a Cast to float32."""
    import onnx
    from onnx import helper, numpy_helper
    model = onnx.load(str(src))
    graph = model.graph
    keep, casts = [], []
    for init in graph.initializer:
        array = numpy_helper.to_array(init)
        if array.dtype == np.float32 and array.size >= 1024:
            half = numpy_helper.from_array(array.astype(np.float16), init.name + '__fp16')
            keep.append(half)
            casts.append(helper.make_node('Cast', [half.name], [init.name], to=onnx.TensorProto.FLOAT, name=init.name + '__cast'))
        else:
            keep.append(init)
    del graph.initializer[:]
    graph.initializer.extend(keep)
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(casts + nodes)
    onnx.save(model, str(dst))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--weights', required=True); p.add_argument('--out', required=True); p.add_argument('--names')
    p.add_argument('--sha256', default=YOLOE_26L_SHA256, help="expected sha256 of --weights ('' to only print it)")
    p.add_argument('--ref'); p.add_argument('--fp16-weights'); p.add_argument('--opset', type=int, default=17)
    a = p.parse_args()
    digest = hashlib.sha256(Path(a.weights).read_bytes()).hexdigest()
    if a.sha256 and digest != a.sha256:
        raise SystemExit(f'checksum mismatch: {a.weights} {digest}')
    import torch, onnxruntime as ort
    from ultralytics import YOLOE
    torch.set_num_threads(2)
    yoloe = YOLOE(a.weights)
    model = yoloe.model.fuse(verbose=False).eval().float()  # AutoBackend(fuse=True) as in predict
    head = model.model[-1]
    assert not head.end2end and hasattr(head, 'lrpc') and head.reg_max == 1, 'unexpected YOLOE head'
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    wrapper = boxes_only(model)
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    with torch.inference_mode(False), torch.no_grad():
        torch.onnx.export(wrapper, (torch.rand(1, 3, 384, 640),), str(out), input_names=['images'], output_names=['detections'],
                          dynamic_axes={'images': {2: 'height', 3: 'width'}, 'detections': {1: 'anchors'}},
                          opset_version=a.opset, dynamo=False, do_constant_folding=True)
    fix_output_shape(out)
    names = [yoloe.names[i] for i in range(len(yoloe.names))]
    if a.names:
        Path(a.names).write_text(json.dumps(names, ensure_ascii=False))
    session = ort.InferenceSession(str(out), providers=['CPUExecutionProvider'])
    cases = []
    if a.ref:
        ref = json.loads((Path(a.ref) / 'reference.json').read_text())
        same_weights = ref['meta']['yoloe_sha256'] == digest  # other weights (yoloe-s): only onnx vs its own torch wrapper
        for case in ref['cases']:
            h, w = case['letterbox']['shape']
            image = np.fromfile(Path(a.ref) / case['letterbox']['file'], np.uint8).reshape(h, w, 3)
            want = np.fromfile(Path(a.ref) / case['raw']['file'], np.float32).reshape(-1, 6) if same_weights else None
            cases.append((case['name'], image, want))
    else:
        rng = np.random.default_rng(0)
        cases = [(f'random{h}x{w}', rng.integers(0, 256, (h, w, 3), np.uint8), None) for h, w in ((640, 480), (384, 640))]
    with torch.no_grad():
        for name, image, want in cases:
            tensor = torch.from_numpy(image).permute(2, 0, 1)[None].float().div_(255)  # BasePredictor.preprocess
            torch_rows = wrapper(tensor)[0].numpy()
            got = session.run(None, {'images': tensor.numpy()})[0][0]
            line = f'{name:22s} {image.shape[0]}x{image.shape[1]} anchors {got.shape[0]}'
            # onnx vs torch wrapper isolates the runtime; wrapper vs server checks the re-expressed head itself.
            pairs = [('onnx~wrapper', got, torch_rows)] + ([('onnx~server', got, want), ('wrapper~server', torch_rows, want)] if want is not None else [])
            for label, ours, other in pairs:
                live = (other[:, 4] > .05) | (ours[:, 4] > .05)  # boxes/classes only matter for scoring anchors
                class_diff = int((other[live, 5] != ours[live, 5]).sum())
                line += (f' | {label}: box {np.abs(other[live, :4] - ours[live, :4]).max(initial=0):.1e}'
                         f' score {np.abs(other[:, 4] - ours[:, 4]).max():.1e} cls {class_diff}/{int(live.sum())}')
            print(line, flush=True)
    data = out.read_bytes()
    report = {'path': str(out), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'weights_sha256': digest,
              'classes': len(names), 'inputs': [(i.name, i.shape) for i in session.get_inputs()],
              'outputs': [(o.name, o.shape) for o in session.get_outputs()]}
    if a.fp16_weights:
        fp16_weights(out, a.fp16_weights)
        half = Path(a.fp16_weights).read_bytes()
        report['fp16_weights'] = {'path': a.fp16_weights, 'bytes': len(half), 'sha256': hashlib.sha256(half).hexdigest()}
    print(json.dumps(report))


if __name__ == '__main__':
    main()

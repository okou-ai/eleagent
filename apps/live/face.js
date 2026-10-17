// Browser-side face pipeline that reproduces the server's OpenCV 5.0 YuNet + SFace usage
// (services/recognition/entity_worker/faces.py) on plain typed arrays, so embeddings match the server's.
// No DOM and no onnxruntime dependency: the caller runs the two ONNX models and passes tensors in and out.
// References (opencv 5.0.0, the server pin): modules/objdetect/src/face_detect.cpp + face_recognize.cpp,
// modules/dnn/src/nms.inl.hpp, modules/imgproc/src/warp_kernels.simd.hpp. Math.fround marks float32 arithmetic.
// Verified by apps/live/tests/face (decode + NMS bit-exact on OpenCV's raw outputs, aligned crops pixel-identical).

const f32 = Math.fround;
const YUNET_DIVISOR = 32;
const YUNET_STRIDES = [8, 16, 32];
// SFace reference landmarks and their mean, verbatim from FaceRecognizerSFImpl::getSimilarityTransformMatrix.
const SFACE_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]
  .map(point => point.map(f32));
const SFACE_DST_MEAN = [f32(56.0262), f32(71.9008)];

const padTo = size => Math.floor((size - 1) / YUNET_DIVISOR + 1) * YUNET_DIVISOR;

// FaceDetectorYN::detect: copyMakeBorder(bottom/right, BORDER_CONSTANT 0) to a multiple of 32, then blobFromImage with
// its defaults (scale 1, mean 0, swapRB=false): NCHW float in BGR order, 0..255, because the server feeds BGR frames.
export function prepareYunetInput(rgba, width, height) {
  const padW = padTo(width), padH = padTo(height), plane = padW * padH;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = 4 * (y * width + x), dst = y * padW + x;
      data[dst] = rgba[src + 2];
      data[plane + dst] = rgba[src + 1];
      data[2 * plane + dst] = rgba[src];
    }
  }
  return { data, dims: [1, 3, padH, padW], inputWidth: width, inputHeight: height };
}

// FaceDetectorYNImpl::postProcess followed by dnn::NMSBoxes(Rect2i boxes, eta=1). Boxes are in padded-input pixels,
// which equal input pixels because padding is only added at the bottom/right. Faces keep OpenCV's output order.
export function decodeYunet(outputs, inputWidth, inputHeight, { scoreThreshold = 0.9, nmsThreshold = 0.3, topK = 5000 } = {}) {
  const padW = padTo(inputWidth), padH = padTo(inputHeight), threshold = f32(scoreThreshold);
  const faces = [];
  for (const stride of YUNET_STRIDES) {
    const cols = padW / stride, rows = padH / stride;
    const [cls, obj, bbox, kps] = ['cls', 'obj', 'bbox', 'kps'].map(name => outputs[`${name}_${stride}`]?.data);
    if (!cls || !obj || !bbox || !kps || cls.length !== rows * cols || kps.length !== rows * cols * 10) {
      throw new Error(`yunet_output_mismatch_stride_${stride}`);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const clsScore = Math.max(Math.min(cls[idx], 1), 0), objScore = Math.max(Math.min(obj[idx], 1), 0);
        const score = f32(Math.sqrt(f32(clsScore * objScore)));
        if (score < threshold) continue;
        const cx = f32(f32(c + bbox[idx * 4]) * stride), cy = f32(f32(r + bbox[idx * 4 + 1]) * stride);
        const w = f32(f32(Math.exp(bbox[idx * 4 + 2])) * stride), h = f32(f32(Math.exp(bbox[idx * 4 + 3])) * stride);
        const landmarks = [];
        for (let n = 0; n < 5; n++) {
          landmarks.push([f32(f32(kps[idx * 10 + 2 * n] + c) * stride), f32(f32(kps[idx * 10 + 2 * n + 1] + r) * stride)]);
        }
        faces.push({ x: f32(cx - w / 2), y: f32(cy - h / 2), w, h, score, landmarks });
      }
    }
  }
  if (faces.length <= 1) return faces; // OpenCV skips NMS (and its strict '>' threshold) for a single candidate.
  // NMSBoxes: stable sort by score desc over scores strictly above the threshold, keep topK, greedy IoU suppression.
  // IoU uses Rect2i(int(x), int(y), int(w), int(h)) truncated toward zero, as postProcess builds them.
  const boxes = faces.map(face => [Math.trunc(face.x), Math.trunc(face.y), Math.trunc(face.w), Math.trunc(face.h)]);
  let order = faces.map((face, index) => index).filter(index => faces[index].score > threshold)
    .sort((a, b) => faces[b].score - faces[a].score);
  if (topK > 0 && topK < order.length) order = order.slice(0, topK);
  const kept = [], limit = f32(nmsThreshold);
  for (const index of order) {
    if (kept.every(other => rectOverlap(boxes[index], boxes[other]) <= limit)) kept.push(index);
  }
  return kept.map(index => faces[index]);
}

// cv::dnn rectOverlap = 1.f - float(jaccardDistance(a, b)) on integer rectangles.
function rectOverlap([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const areaA = aw * ah, areaB = bw * bh;
  if (areaA + areaB <= 0) return 1;
  const iw = Math.min(ax + aw, bx + bw) - Math.max(ax, bx), ih = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  const inter = iw > 0 && ih > 0 ? iw * ih : 0;
  return f32(1 - f32(1 - inter / (areaA + areaB - inter)));
}

// FaceRecognizerSF::alignCrop similarity transform (Umeyama), source landmarks -> 112x112 template, as [a,b,c,d,e,f]
// for x' = a*x + b*y + c, y' = d*x + e*y + f. Means and de-meaned points are float32 and products are float32
// accumulated in double, as in OpenCV. OpenCV derives the rotation from a 2x2 SVD: T = U*diag(1, sign(det A))*V^T and
// scale = (s0 + sign(det A)*s1) / (var_x + var_y). For 2x2 that rotation is the proper rotation maximising trace(R^T A),
// i.e. R ~ (A00 + A11, A10 - A01), and the singular-value sum is the norm of that vector; this closed form equals the
// SVD path up to double rounding (~1e-15). Degenerate landmarks (all collinear/identical) are not meaningful in either.
export function alignmentMatrix(landmarks) {
  const src = landmarks.map(([x, y]) => [f32(x), f32(y)]);
  const mean = [0, 1].map(axis => f32(f32(f32(f32(f32(src[0][axis] + src[1][axis]) + src[2][axis]) + src[3][axis]) + src[4][axis]) / 5));
  const sd = src.map(point => [f32(point[0] - mean[0]), f32(point[1] - mean[1])]);
  const dd = SFACE_DST.map(point => [f32(point[0] - SFACE_DST_MEAN[0]), f32(point[1] - SFACE_DST_MEAN[1])]);
  const sum = fn => { let total = 0; for (let i = 0; i < 5; i++) total += fn(i); return total / 5; };
  const a00 = sum(i => f32(dd[i][0] * sd[i][0])), a01 = sum(i => f32(dd[i][0] * sd[i][1]));
  const a10 = sum(i => f32(dd[i][1] * sd[i][0])), a11 = sum(i => f32(dd[i][1] * sd[i][1]));
  const variance = sum(i => f32(sd[i][0] * sd[i][0])) + sum(i => f32(sd[i][1] * sd[i][1]));
  const cosine = a00 + a11, sine = a10 - a01, norm = Math.hypot(cosine, sine);
  const [r00, r01, r10, r11] = norm > 0 ? [cosine / norm, -sine / norm, sine / norm, cosine / norm] : [1, 0, 0, 1];
  const scale = 1 / variance * norm;
  const tx = SFACE_DST_MEAN[0] - scale * (r00 * mean[0] + r01 * mean[1]);
  const ty = SFACE_DST_MEAN[1] - scale * (r10 * mean[0] + r11 * mean[1]);
  return [r00 * scale, r01 * scale, tx, r10 * scale, r11 * scale, ty];
}

// cv::warpAffine(INTER_LINEAR, BORDER_CONSTANT 0) as implemented in OpenCV 5.0 (warpAffineLinearInvoker_8UC3 SIMD path):
// the matrix is inverted in double and cast to float32; source coordinates and bilinear weights are float32 with FMA
// (no fixed-point tables any more), out-of-image neighbours read as 0, and v_round + pack round half-to-even and
// saturate, which is exactly the Uint8ClampedArray store conversion.
// Fused multiply-adds are emulated in double, exact here because the operands carry few significant bits.
export function warpAffineBilinear(rgba, width, height, matrix, outW = 112, outH = 112) {
  let [m0, m1, m2, m3, m4, m5] = matrix;
  let det = m0 * m4 - m1 * m3;
  det = det !== 0 ? 1 / det : 0;
  const a11 = m4 * det, a22 = m0 * det;
  m0 = a11; m1 *= -det; m3 *= -det; m4 = a22;
  const b1 = -m0 * m2 - m1 * m5, b2 = -m3 * m2 - m4 * m5;
  const M = Float32Array.of(m0, m1, b1, m3, m4, b2);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const pixel = (x, y, channel) => (x >= 0 && x < width && y >= 0 && y < height ? rgba[4 * (y * width + x) + channel] : 0);
  for (let y = 0; y < outH; y++) {
    const rowX = f32(f32(y * M[1]) + M[2]), rowY = f32(f32(y * M[4]) + M[5]);
    for (let x = 0; x < outW; x++) {
      const sx = f32(M[0] * x + rowX), sy = f32(M[3] * x + rowY);
      const ix = Math.floor(sx), iy = Math.floor(sy), alpha = f32(sx - ix), beta = f32(sy - iy);
      const dst = 4 * (y * outW + x);
      for (let channel = 0; channel < 3; channel++) {
        const p00 = pixel(ix, iy, channel), p01 = pixel(ix + 1, iy, channel);
        const p10 = pixel(ix, iy + 1, channel), p11 = pixel(ix + 1, iy + 1, channel);
        const top = f32(alpha * (p01 - p00) + p00), bottom = f32(alpha * (p11 - p10) + p10);
        out[dst + channel] = f32(beta * f32(bottom - top) + top); // Uint8ClampedArray: round half-even + saturate
      }
      out[dst + 3] = 255;
    }
  }
  return out;
}

// FaceRecognizerSF::feature: blobFromImage(aligned, 1, Size(112,112), Scalar(0,0,0), swapRB=true, crop=false).
// The aligned crop is BGR on the server, so swapRB feeds RGB: NCHW float R,G,B in 0..255. The model itself
// subtracts 127.5 and multiplies by 0.0078125 (Sub/Mul nodes), so no normalisation happens here.
export function prepareSfaceInput(alignedRgba) {
  const plane = 112 * 112, data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    data[i] = alignedRgba[4 * i];
    data[plane + i] = alignedRgba[4 * i + 1];
    data[2 * plane + i] = alignedRgba[4 * i + 2];
  }
  return { data, dims: [1, 3, 112, 112] };
}

// Same validity rule as the server: a non-finite or zero-norm embedding is invalid (returns null).
export function l2normalize(vec) {
  let norm = 0;
  for (const value of vec) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return Float32Array.from(vec, value => value / norm);
}

// Server rule (store.assign): candidate score = max dot over its prototypes; accept the best when it reaches the
// threshold and leads the runner-up by the margin (a lone candidate needs no margin). Candidates without vectors are skipped.
export function matchIdentity(embedding, candidates, { threshold = 0.55, margin = 0.08 } = {}) {
  const query = l2normalize(embedding);
  if (!query) return { id: null, score: null, second: null };
  const scored = [];
  for (const candidate of candidates) {
    let best = -Infinity;
    for (const vector of candidate.vectors ?? []) {
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += query[i] * vector[i];
      best = Math.max(best, dot);
    }
    if (best > -Infinity) scored.push({ candidate, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  const score = scored[0]?.score ?? null, second = scored[1]?.score ?? null;
  if (score !== null && score >= threshold && (second === null || score - second >= margin)) {
    return { id: scored[0].candidate.id, name: scored[0].candidate.name, score, second };
  }
  return { id: null, score, second };
}

// onnxruntime-ready model bytes. These rewrite only ONNX metadata; nodes and weights are copied byte-for-byte, so
// verify the pinned sha256 on the original file first. YuNet: the pinned file declares a fixed 1x3x640x640 input (plus
// fixed output/value_info shapes), which onnxruntime enforces, while OpenCV reshapes the net to the padded frame. The
// graph is size-agnostic (Reshape [1,-1,k], Resize by scale), so input H/W and the output anchor axis become symbolic
// and graph.value_info is dropped.
export function yunetModelForOrt(modelBytes) {
  const symbolic = name => Uint8Array.of(0x12, name.length, ...[...name].map(ch => ch.charCodeAt(0))); // Dimension.dim_param
  const reshape = (valueInfo, axesByName) => {
    const axes = axesByName[protoString(valueInfo, 1)];
    if (!axes) return undefined;
    // ValueInfoProto.type(2) -> TypeProto.tensor_type(1) -> Tensor.shape(2) -> TensorShapeProto.dim(1)[axis]
    const shape = bytes => { let axis = -1; return protoEdit(bytes, no => no !== 1 ? undefined : axes[++axis] && symbolic(axes[axis])); };
    const tensor = bytes => protoEdit(bytes, (no, payload) => no === 2 ? shape(payload) : undefined);
    const type = bytes => protoEdit(bytes, (no, payload) => no === 1 ? tensor(payload) : undefined);
    return protoEdit(valueInfo, (no, payload) => no === 2 ? type(payload) : undefined);
  };
  const outputs = Object.fromEntries(['cls', 'obj', 'bbox', 'kps'].flatMap(kind => YUNET_STRIDES.map(s => [`${kind}_${s}`, { 1: 'anchors' }])));
  // ModelProto.graph(7) -> GraphProto.input(11) / output(12) / value_info(13)
  return protoEdit(asBytes(modelBytes), (no, graph) => no !== 7 ? undefined : protoEdit(graph, (no, payload) =>
    no === 13 ? null : no === 11 ? reshape(payload, { input: { 2: 'height', 3: 'width' } }) : no === 12 ? reshape(payload, outputs) : undefined));
}

// SFace (IR 6 export) also lists all 174 weights as graph inputs, which makes onnxruntime treat them as overridable and
// skip constant folding (Conv+BatchNorm fusion): dropping those input entries is ~30% faster on CPU.
export function sfaceModelForOrt(modelBytes) {
  return protoEdit(asBytes(modelBytes), (no, graph) => {
    if (no !== 7) return undefined;
    // GraphProto.initializer(5) is a TensorProto whose name is field 8; GraphProto.input(11) names are field 1.
    const weights = new Set(protoFields(graph).filter(field => field.no === 5).map(field => protoString(field.payload, 8)));
    return protoEdit(graph, (no, payload) => no === 11 && weights.has(protoString(payload, 1)) ? null : undefined);
  });
}

const asBytes = bytes => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
const protoString = (bytes, fieldNo) => new TextDecoder().decode(protoFields(bytes).find(field => field.no === fieldNo)?.payload ?? new Uint8Array());

function readVarint(bytes, offset) {
  let value = 0, scale = 1, byte;
  do {
    byte = bytes[offset++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, offset];
}

function varint(value) {
  const out = [];
  while (value >= 128) { out.push(value % 128 | 0x80); value = Math.floor(value / 128); }
  out.push(value);
  return out;
}

function protoFields(bytes) {
  const fields = [];
  for (let offset = 0; offset < bytes.length;) {
    const start = offset;
    const [key, next] = readVarint(bytes, offset);
    const no = Math.floor(key / 8), wire = key % 8;
    let payloadStart = next, end;
    if (wire === 0) end = readVarint(bytes, next)[1];
    else if (wire === 1) end = next + 8;
    else if (wire === 5) end = next + 4;
    else if (wire === 2) { const [length, at] = readVarint(bytes, next); payloadStart = at; end = at + length; }
    else throw new Error('onnx_unsupported_wire_type');
    if (end > bytes.length) throw new Error('onnx_truncated');
    fields.push({ no, wire, raw: bytes.subarray(start, end), payload: wire === 2 ? bytes.subarray(payloadStart, end) : null });
    offset = end;
  }
  return fields;
}

// edit(fieldNumber, payload) -> undefined keeps the field, null drops it, Uint8Array replaces a length-delimited payload.
function protoEdit(bytes, edit) {
  const parts = protoFields(bytes).flatMap(field => {
    const result = field.wire === 2 ? edit(field.no, field.payload) : undefined;
    if (result === undefined) return [field.raw];
    if (result === null) return [];
    return [Uint8Array.from([...varint(field.no * 8 + 2), ...varint(result.length)]), result];
  });
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

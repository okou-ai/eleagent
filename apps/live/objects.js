// Browser-side object pipeline that reproduces the server's object proposals and appearance vectors
// (services/recognition/entity_worker/objects.py ObjectDetector.extract on CPU: ultralytics 8.4.175 predict on the
// YOLOE-26L-PF .pt, opencv-python 5.0.0.93, numpy 2.2.6, Pillow 10.4.0, transformers 4.51.0 DINOv2-small).
// No DOM and no onnxruntime dependency: the caller runs yoloe.onnx (images [1,3,H,W] -> detections [1,anchors,6]) and
// dinov2.onnx (pixel_values [N,3,224,224] -> embedding [N,384]), both exported by apps/live/tests/objects. Frames are
// RGBA bytes as from getImageData; the server sees the same pixels as an RGB array. Math.fround marks float32
// arithmetic that torch/numpy perform in float32. Verified by apps/live/tests/objects (letterbox, blur and DINOv2
// pixels bit-exact; decode + NMS bit-exact on the server's raw head output).
//
//   const input = prepareYoloeInput(rgba, width, height);
//   const outputs = await yoloe.run({ images: new ort.Tensor('float32', input.data, input.dims) });
//   const { objects, truncated } = decodeYoloe(outputs, input.letterbox, width, height, names);
//   for (const object of objects) object.quality = objectQuality(rgba, width, height, object);
//   const accepted = objects.filter(object => object.quality.accepted);
//   pixel_values = accepted.map(object => prepareDinoInput(rgba, width, height, object)) stacked to [N,3,224,224]
//   const { embedding } = await dino.run(...); accepted[i].feature = dinoEmbedding(embedding.data, i);

const f32 = Math.fround;

// objects.py ObjectDetector defaults (confidence=.25, max_objects=8) and the extract() quality gate.
export const OBJECT_CONFIDENCE = 0.25, MAX_OBJECTS = 8, MIN_OBJECT_SIZE = 32, MIN_BLUR_VARIANCE = 20;
// objects.py PERSON_LABELS: the face/person flow owns people (compared casefolded; PF class ids are not COCO ids).
export const PERSON_LABELS = new Set(['person', 'people', 'human', 'human being', 'man', 'woman', 'boy', 'girl',
  'child', 'children', 'baby']);
// _detect: predict(imgsz=640, iou=.5, max_det=100); appearance crops are 224x224 DINOv2-S/14 CLS vectors.
export const YOLOE_IMAGE_SIZE = 640, OBJECT_NMS_IOU = 0.5, MAX_DETECTIONS = 100, DINO_SIZE = 224, OBJECT_EMBEDDING_DIM = 384;
// worker.py: objects are matched per class ('<version>:class-<id>') at threshold .85 with the default .08 margin.
export const OBJECT_MATCH_SIM = 0.85, OBJECT_MATCH_MARGIN = 0.08;

const STRIDE = 32, PAD_VALUE = 114; // LetterBox stride and padding value
const DBL_EPSILON = 2.220446049250313e-16;
const UNIT = Float32Array.from({ length: 256 }, (_, v) => v / 255); // im.float().div_(255), exact in float32

// Python round(): half to even (only reachable for exact .5 doubles; cvRound behaves the same for floats).
function roundHalfEven(x) {
  const r = Math.round(x) + 0; // + 0: no -0
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ultralytics LetterBox.get_params with new_shape 640, auto=True (rect: .pt predict), stride 32, center, scaleup.
function letterboxParams(width, height) {
  const r = Math.min(YOLOE_IMAGE_SIZE / height, YOLOE_IMAGE_SIZE / width);
  const newWidth = roundHalfEven(width * r), newHeight = roundHalfEven(height * r);
  const dw = ((YOLOE_IMAGE_SIZE - newWidth) % STRIDE) / 2, dh = ((YOLOE_IMAGE_SIZE - newHeight) % STRIDE) / 2;
  const top = roundHalfEven(dh - 0.1), bottom = roundHalfEven(dh + 0.1);
  const left = roundHalfEven(dw - 0.1), right = roundHalfEven(dw + 0.1);
  return { gain: r, newWidth, newHeight, top, left, inputWidth: newWidth + left + right, inputHeight: newHeight + top + bottom };
}

// cv::resize(INTER_LINEAR) on 8UC3 as OpenCV 5.0 hal::resize runs it (IPP is skipped for 8u linear; no HAL on x86_64):
// an exact 1/2 downscale becomes the INTER_AREA fast path (a+b+c+d+2)>>2; otherwise resizeGeneric_ with 11-bit
// fixed-point weights (float32 coordinates, cvRound), exact integer horizontal sums, and the uchar VResizeLinear
// specialisation, which rounds like its SIMD path: ((b0*(S0>>4))>>16) + ((b1*(S1>>4))>>16), then (+2)>>2.
// Returns packed RGB.
function resizeLinear(rgba, width, height, outW, outH) {
  const out = new Uint8Array(outW * outH * 3);
  const scaleX = 1 / (outW / width), scaleY = 1 / (outH / height);
  const iscaleX = roundHalfEven(scaleX), iscaleY = roundHalfEven(scaleY);
  if (iscaleX === 2 && iscaleY === 2 && Math.abs(scaleX - 2) < DBL_EPSILON && Math.abs(scaleY - 2) < DBL_EPSILON) {
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const a = 4 * (2 * y * width + 2 * x), b = a + 4 * width, o = 3 * (y * outW + x);
        for (let c = 0; c < 3; c++) out[o + c] = (rgba[a + c] + rgba[a + 4 + c] + rgba[b + c] + rgba[b + 4 + c] + 2) >> 2;
      }
    }
    return out;
  }
  const xofs = new Int32Array(outW), alpha0 = new Int32Array(outW), alpha1 = new Int32Array(outW);
  let xmax = outW;
  for (let dx = 0; dx < outW; dx++) {
    let fx = f32((dx + 0.5) * scaleX - 0.5);
    let sx = Math.floor(fx);
    fx = f32(fx - sx);
    if (sx < 0) { fx = 0; sx = 0; }
    if (sx + 1 >= width) {
      xmax = Math.min(xmax, dx);
      if (sx >= width - 1) { fx = 0; sx = width - 1; }
    }
    xofs[dx] = sx;
    alpha0[dx] = roundHalfEven(f32(1 - fx) * 2048);
    alpha1[dx] = roundHalfEven(fx * 2048);
  }
  const rowCache = new Map();
  const hrow = sy => { // HResizeLinear: S[sx]*a0 + S[sx+1]*a1, and S[sx]*2048 past xmax
    let row = rowCache.get(sy);
    if (row) return row;
    row = new Int32Array(outW * 3);
    const base = 4 * sy * width;
    for (let dx = 0; dx < outW; dx++) {
      const p = base + 4 * xofs[dx];
      for (let c = 0; c < 3; c++) {
        row[3 * dx + c] = dx < xmax ? rgba[p + c] * alpha0[dx] + rgba[p + 4 + c] * alpha1[dx] : rgba[p + c] * 2048;
      }
    }
    if (rowCache.size > 4) rowCache.delete(rowCache.keys().next().value);
    rowCache.set(sy, row);
    return row;
  };
  const rowWidth = outW * 3;
  for (let dy = 0; dy < outH; dy++) {
    let fy = f32((dy + 0.5) * scaleY - 0.5);
    const sy = Math.floor(fy);
    fy = f32(fy - sy);
    const beta0 = roundHalfEven(f32(1 - fy) * 2048), beta1 = roundHalfEven(fy * 2048);
    const s0 = hrow(Math.min(Math.max(sy, 0), height - 1)), s1 = hrow(Math.min(Math.max(sy + 1, 0), height - 1));
    const o = dy * rowWidth;
    for (let x = 0; x < rowWidth; x++) out[o + x] = ((((s0[x] >> 4) * beta0) >> 16) + (((s1[x] >> 4) * beta1) >> 16) + 2) >> 2;
  }
  return out;
}

// BasePredictor.preprocess for one frame: LetterBox (resize as above, cv2.copyMakeBorder with 114) then BGR->RGB,
// HWC->CHW, /255. Input H and W are multiples of 32 (e.g. 1280x720 -> 640x384), as the server's rect predict uses.
export function prepareYoloeInput(rgba, width, height) {
  const letterbox = letterboxParams(width, height);
  const { newWidth, newHeight, top, left, inputWidth, inputHeight } = letterbox;
  let resized;
  if (newWidth === width && newHeight === height) {
    resized = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < resized.length; i += 3, j += 4) { resized[i] = rgba[j]; resized[i + 1] = rgba[j + 1]; resized[i + 2] = rgba[j + 2]; }
  } else {
    resized = resizeLinear(rgba, width, height, newWidth, newHeight);
  }
  const plane = inputWidth * inputHeight, data = new Float32Array(3 * plane).fill(UNIT[PAD_VALUE]);
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const src = 3 * (y * newWidth + x), dst = (y + top) * inputWidth + x + left;
      data[dst] = UNIT[resized[src]];
      data[plane + dst] = UNIT[resized[src + 1]];
      data[2 * plane + dst] = UNIT[resized[src + 2]];
    }
  }
  return { data, dims: [1, 3, inputHeight, inputWidth], letterbox };
}

// The rest of predict + _detect on the `detections` rows [x1, y1, x2, y2, best class probability, class id] (letterbox
// pixels, float32): non_max_suppression (score > conf, best class only; class-AGNOSTIC because YOLOE.predict defaults
// agnostic_nms=True, so person boxes still suppress overlapping objects; torchvision nms with a stable score sort and
// float32 IoU > .5; max_det 100), ops.scale_boxes (+ clip), then objects.py: drop person-like labels, clip, sort by
// (-confidence, class_id, x1) and keep MAX_OBJECTS. `total` counts objects before that cap (the server's
// truncated_objects is total > MAX_OBJECTS). Coordinates are original-frame pixels.
export function decodeYoloe(outputs, letterbox, width, height, names, { confidence = OBJECT_CONFIDENCE, maxObjects = MAX_OBJECTS } = {}) {
  const output = outputs.detections ?? Object.values(outputs)[0];
  const { data, dims } = output;
  const anchors = dims[1], conf = f32(confidence);
  if (dims.length !== 3 || dims[0] !== 1 || dims[2] !== 6 || data.length !== anchors * 6) throw new Error('yoloe_output_mismatch');
  const candidates = [];
  for (let i = 0; i < anchors; i++) if (data[6 * i + 4] > conf) candidates.push(i);
  candidates.sort((a, b) => data[6 * b + 4] - data[6 * a + 4] || a - b);
  const count = candidates.length, boxes = new Float32Array(count * 4), areas = new Float32Array(count);
  candidates.forEach((anchor, k) => {
    for (let c = 0; c < 4; c++) boxes[4 * k + c] = data[6 * anchor + c];
    areas[k] = f32(f32(boxes[4 * k + 2] - boxes[4 * k]) * f32(boxes[4 * k + 3] - boxes[4 * k + 1]));
  });
  const suppressed = new Uint8Array(count), kept = [];
  for (let i = 0; i < count && kept.length < MAX_DETECTIONS; i++) {
    if (suppressed[i]) continue;
    kept.push(candidates[i]);
    const [ix1, iy1, ix2, iy2] = boxes.subarray(4 * i, 4 * i + 4);
    for (let j = i + 1; j < count; j++) {
      if (suppressed[j]) continue;
      const w = Math.max(0, f32(Math.min(ix2, boxes[4 * j + 2]) - Math.max(ix1, boxes[4 * j])));
      const h = Math.max(0, f32(Math.min(iy2, boxes[4 * j + 3]) - Math.max(iy1, boxes[4 * j + 1])));
      const inter = f32(w * h);
      if (f32(inter / f32(f32(areas[i] + areas[j]) - inter)) > OBJECT_NMS_IOU) suppressed[j] = 1;
    }
  }
  // ops.scale_boxes(img1_shape=letterboxed, img0_shape=frame): per-axis gains from the rounded resized size.
  const gain = Math.min(letterbox.inputHeight / height, letterbox.inputWidth / width);
  const newHeight = roundHalfEven(height * gain), newWidth = roundHalfEven(width * gain);
  const gainX = f32(newWidth / width), gainY = f32(newHeight / height);
  const padX = roundHalfEven((letterbox.inputWidth - newWidth) / 2 - 0.1), padY = roundHalfEven((letterbox.inputHeight - newHeight) / 2 - 0.1);
  const clamp = (value, limit) => Math.min(Math.max(value, 0), limit);
  const objects = [];
  for (const anchor of kept) {
    const row = data.subarray(6 * anchor, 6 * anchor + 6), classId = row[5], label = names[classId];
    if (PERSON_LABELS.has(String(label).toLowerCase())) continue;
    const x1 = clamp(f32(f32(row[0] - padX) / gainX), width), y1 = clamp(f32(f32(row[1] - padY) / gainY), height);
    const x2 = clamp(f32(f32(row[2] - padX) / gainX), width), y2 = clamp(f32(f32(row[3] - padY) / gainY), height);
    if (x2 > x1 && y2 > y1) objects.push({ x1, y1, x2, y2, score: row[4], classId, label });
  }
  objects.sort((a, b) => b.score - a.score || a.classId - b.classId || a.x1 - b.x1);
  return { objects: objects.slice(0, maxObjects), truncated: objects.length > maxObjects, total: objects.length };
}

// extract() quality gate on crop = frame[int(y1):ceil(y2), int(x1):ceil(x2)]: 'object_too_small' when the box (not
// the crop) is under 32 px on a side, else 'object_blurred' when Laplacian variance < 20. blur reproduces
// cv2.cvtColor(RGB2GRAY) (15-bit fixed point, OpenCV 5.0) -> cv2.Laplacian(ksize=1, CV_64F, BORDER_REFLECT_101)
// -> ndarray.var() (numpy pairwise summation), so it is computed for every box as the server records it.
export function objectQuality(rgba, width, height, { x1, y1, x2, y2 }) {
  const left = Math.trunc(x1), top = Math.trunc(y1), right = Math.min(Math.ceil(x2), width), bottom = Math.min(Math.ceil(y2), height);
  const w = Math.max(0, right - left), h = Math.max(0, bottom - top), n = w * h;
  let blur = 0;
  if (n) {
    const gray = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0, p = 4 * ((top + y) * width + left); x < w; x++, p += 4) {
        gray[y * w + x] = (rgba[p] * 9798 + rgba[p + 1] * 19235 + rgba[p + 2] * 3735 + 16384) >> 15;
      }
    }
    const reflect = (i, size) => (size === 1 ? 0 : i < 0 ? -i : i >= size ? 2 * size - 2 - i : i);
    const laplacian = new Float64Array(n);
    for (let y = 0; y < h; y++) {
      const up = reflect(y - 1, h) * w, down = reflect(y + 1, h) * w, row = y * w;
      for (let x = 0; x < w; x++) {
        laplacian[row + x] = gray[up + x] + gray[down + x] + gray[row + reflect(x - 1, w)] + gray[row + reflect(x + 1, w)] - 4 * gray[row + x];
      }
    }
    const mean = reduceSum(laplacian) / n;
    for (let i = 0; i < n; i++) laplacian[i] = (laplacian[i] - mean) * (laplacian[i] - mean);
    blur = reduceSum(laplacian) / n;
  }
  const reason = Math.min(x2 - x1, y2 - y1) < MIN_OBJECT_SIZE ? 'object_too_small' : blur < MIN_BLUR_VARIANCE ? 'object_blurred' : null;
  return { accepted: reason === null, reason, blur,
    touchesFrameBoundary: x1 <= 1 || y1 <= 1 || x2 >= width - 1 || y2 >= height - 1 };
}

// np.add.reduce on a contiguous float64 array: the iterator hands the inner loop 8192-element buffers, each summed by
// DOUBLE_pairwise_sum (8 accumulators up to 128 elements, halving above) into a running total.
function reduceSum(a) {
  let sum = 0;
  for (let start = 0; start < a.length; start += 8192) sum += pairwiseSum(a, start, Math.min(8192, a.length - start));
  return sum;
}

function pairwiseSum(a, start, n) {
  if (n < 8) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[start + i];
    return sum;
  }
  if (n <= 128) {
    const r = Array.from(a.subarray(start, start + 8));
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[start + i + j];
    let sum = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) sum += a[start + i];
    return sum;
  }
  let half = Math.floor(n / 2);
  half -= half % 8;
  return pairwiseSum(a, start, half) + pairwiseSum(a, start + half, n - half);
}

// Pillow 10.4 ImagingResample, BICUBIC (a = -0.5, support 2 scaled by the downscale factor) on 8-bit RGB: double
// coefficients normalised per output pixel, converted to 22-bit fixed point, separable horizontal-then-vertical
// passes, each rounding (+2^21) and clipping to uint8.
function bicubic(x) {
  if (x < 0) x = -x;
  if (x < 1) return ((-0.5 + 2) * x - (-0.5 + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * -0.5;
  return 0;
}

function resampleCoefficients(inSize, outSize) { // precompute_coeffs + normalize_coeffs_8bpc
  const scale = inSize / outSize, filterscale = Math.max(scale, 1), support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1, bounds = new Int32Array(outSize * 2), kk = new Int32Array(outSize * ksize);
  const weights = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale, ss = 1 / filterscale;
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
    const count = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
    let ww = 0;
    for (let x = 0; x < count; x++) ww += (weights[x] = bicubic((x + xmin - center + 0.5) * ss));
    for (let x = 0; x < count; x++) {
      const k = ww !== 0 ? weights[x] / ww : weights[x];
      kk[xx * ksize + x] = k < 0 ? Math.trunc(-0.5 + k * 4194304) : Math.trunc(0.5 + k * 4194304);
    }
    bounds[2 * xx] = xmin;
    bounds[2 * xx + 1] = count;
  }
  return { ksize, bounds, kk };
}

const clip8 = sum => { const v = Math.floor(sum / 4194304); return v < 0 ? 0 : v > 255 ? 255 : v; };
let dinoTables;

// ObjectDetector._appearance_inputs for one detection: crop as extract() does, PIL resize so the shorter side is 256
// (longer side int(256 * long / short)), BICUBIC (preprocessor_config resample 3), center crop 224, then float32
// (x * rescale_factor - mean) / std, CHW. Only the 224x224 window is resampled (pixels are independent).
// Returns Float32Array(3 * 224 * 224); stack crops into pixel_values [N, 3, 224, 224].
export function prepareDinoInput(rgba, width, height, { x1, y1, x2, y2 }) {
  if (!dinoTables) {
    const rescale = f32(0.00392156862745098), mean = [0.485, 0.456, 0.406].map(f32), std = [0.229, 0.224, 0.225].map(f32);
    dinoTables = mean.map((m, c) => Float32Array.from({ length: 256 }, (_, v) => f32(f32(f32(v * rescale) - m) / std[c])));
  }
  const left = Math.trunc(x1), top = Math.trunc(y1);
  const w = Math.min(Math.ceil(x2), width) - left, h = Math.min(Math.ceil(y2), height) - top;
  if (!(w > 0 && h > 0)) throw new Error('object_crop_empty');
  const [outW, outH] = w <= h ? [256, Math.trunc(256 * h / w)] : [Math.trunc(256 * w / h), 256];
  const cropX = (outW - DINO_SIZE) >> 1, cropY = (outH - DINO_SIZE) >> 1;
  const pixel = (x, y, c) => rgba[4 * ((top + y) * width + left + x) + c];
  // Horizontal pass over the source rows the vertical pass reads (all rows when there is no vertical pass).
  const vertical = outH !== h ? resampleCoefficients(h, outH) : null;
  const rowStart = vertical ? vertical.bounds[2 * cropY] : cropY;
  const rowEnd = vertical ? Math.max(...Array.from({ length: DINO_SIZE }, (_, i) => vertical.bounds[2 * (cropY + i)] + vertical.bounds[2 * (cropY + i) + 1])) : cropY + DINO_SIZE;
  const rows = rowEnd - rowStart, temp = new Uint8Array(rows * DINO_SIZE * 3);
  if (outW !== w) {
    const { ksize, bounds, kk } = resampleCoefficients(w, outW);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < DINO_SIZE; x++) {
        const xx = cropX + x, xmin = bounds[2 * xx], count = bounds[2 * xx + 1], k = xx * ksize;
        for (let c = 0; c < 3; c++) {
          let sum = 2097152;
          for (let i = 0; i < count; i++) sum += pixel(xmin + i, rowStart + y, c) * kk[k + i];
          temp[3 * (y * DINO_SIZE + x) + c] = clip8(sum);
        }
      }
    }
  } else {
    for (let y = 0; y < rows; y++) for (let x = 0; x < DINO_SIZE; x++) for (let c = 0; c < 3; c++) temp[3 * (y * DINO_SIZE + x) + c] = pixel(cropX + x, rowStart + y, c);
  }
  const plane = DINO_SIZE * DINO_SIZE, data = new Float32Array(3 * plane);
  for (let y = 0; y < DINO_SIZE; y++) {
    for (let x = 0; x < DINO_SIZE; x++) {
      for (let c = 0; c < 3; c++) {
        let value;
        if (vertical) {
          const yy = cropY + y, ymin = vertical.bounds[2 * yy] - rowStart, count = vertical.bounds[2 * yy + 1], k = yy * vertical.ksize;
          let sum = 2097152;
          for (let i = 0; i < count; i++) sum += temp[3 * ((ymin + i) * DINO_SIZE + x) + c] * vertical.kk[k + i];
          value = clip8(sum);
        } else {
          value = temp[3 * (y * DINO_SIZE + x) + c];
        }
        data[c * plane + y * DINO_SIZE + x] = dinoTables[c][value];
      }
    }
  }
  return data;
}

// extract(): CLS embedding / max(||e||, 1e-12); a non-finite or zero-norm vector is invalid (null), as on the server.
export function dinoEmbedding(outputData, index = 0) {
  const start = index * OBJECT_EMBEDDING_DIM;
  if (!outputData || outputData.length < start + OBJECT_EMBEDDING_DIM) return null;
  const vector = outputData.subarray(start, start + OBJECT_EMBEDDING_DIM);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return Float32Array.from(vector, value => value / Math.max(norm, 1e-12));
}

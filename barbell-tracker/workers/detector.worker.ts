import * as ort from 'onnxruntime-web';

let session: ort.InferenceSession | null = null;
let inputName  = 'images';
let outputName = 'output0';

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function iou(a: number[], b: number[]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = a[2] * a[3];
  const bArea = b[2] * b[3];
  return intersection / (aArea + bArea - intersection);
}

function nms(boxes: number[][], scores: number[], iouThreshold: number): number[] {
  const indices = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const kept: number[] = [];
  const suppressed = new Set<number>();

  for (const i of indices) {
    if (suppressed.has(i)) continue;
    kept.push(i);
    for (const j of indices) {
      if (i === j || suppressed.has(j)) continue;
      if (iou(boxes[i], boxes[j]) > iouThreshold) suppressed.add(j);
    }
  }
  return kept;
}

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  // ── Load model ────────────────────────────────────────────────────────────
  if (type === 'load') {
    try {
      ort.env.wasm.wasmPaths = '/';
      ort.env.wasm.numThreads = 1;

      session = await ort.InferenceSession.create(payload.modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      inputName  = session.inputNames[0];
      outputName = session.outputNames[0];

      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({
        type: 'error',
        payload: err instanceof Error ? err.message : 'Failed to load model'
      });
    }
  }

  // ── Run detection ─────────────────────────────────────────────────────────
  if (type === 'detect' && session) {
    try {
      const {
        float32, shape,
        srcWidth, srcHeight,
        padX, padY, scale,
        scoreThreshold, iouThreshold, topK,
      } = payload;

      const tensor  = new ort.Tensor('float32', float32, shape);
      const results = await session.run({ [inputName]: tensor });
      const output  = results[outputName];
      const data    = output.data as Float32Array;
      const dims    = output.dims;

      const detections: Array<{
        x: number; y: number;
        width: number; height: number;
        centerX: number; centerY: number;
        score: number; label: number;
      }> = [];

      // ── Raw YOLOv8 [1, 5, 8400] ──────────────────────────────────────────
      if (dims.length === 3 && dims[1] < dims[2]) {
        const numAnchors = dims[2];
        const numAttribs = dims[1];
        const boxes:  number[][] = [];
        const scores: number[]   = [];

        for (let i = 0; i < numAnchors; i++) {
          const cx = data[0 * numAnchors + i];
          const cy = data[1 * numAnchors + i];
          const w  = data[2 * numAnchors + i];
          const h  = data[3 * numAnchors + i];

          let maxScore = -Infinity;
          let maxClass = 0;
          for (let c = 4; c < numAttribs; c++) {
            const s = data[c * numAnchors + i];
            if (s > maxScore) { maxScore = s; maxClass = c - 4; }
          }

          const score = sigmoid(maxScore);
          if (score < scoreThreshold) continue;

          const x  = ((cx - w / 2) - padX) / scale;
          const y  = ((cy - h / 2) - padY) / scale;
          const bw = w / scale;
          const bh = h / scale;

          const clampedX = Math.max(0, x);
          const clampedY = Math.max(0, y);
          const clampedW = Math.max(0, Math.min(srcWidth  - clampedX, bw));
          const clampedH = Math.max(0, Math.min(srcHeight - clampedY, bh));

          if (clampedW < 5 || clampedH < 5) continue;

          boxes.push([clampedX, clampedY, clampedW, clampedH]);
          scores.push(score);
          detections.push({
            x: clampedX, y: clampedY,
            width: clampedW, height: clampedH,
            centerX: clampedX + clampedW / 2,
            centerY: clampedY + clampedH / 2,
            score, label: maxClass,
          });
        }

        const kept  = nms(boxes, scores, iouThreshold).slice(0, topK);
        const final = kept.map(i => detections[i]);
        self.postMessage({ type: 'result', payload: final });
      }

      // ── Baked NMS [1, 300, 6] ─────────────────────────────────────────────
      else if (dims.length === 3 && dims[2] === 6) {
        const numDets = dims[1];
        const final = [];

        for (let i = 0; i < numDets; i++) {
          const offset = i * 6;
          const score  = data[offset + 4];
          if (score < scoreThreshold) continue;

          const x  = (data[offset + 0] - padX) / scale;
          const y  = (data[offset + 1] - padY) / scale;
          const bw = (data[offset + 2] - data[offset + 0]) / scale;
          const bh = (data[offset + 3] - data[offset + 1]) / scale;

          final.push({
            x: Math.max(0, x),
            y: Math.max(0, y),
            width:   Math.max(0, bw),
            height:  Math.max(0, bh),
            centerX: Math.max(0, x) + Math.max(0, bw) / 2,
            centerY: Math.max(0, y) + Math.max(0, bh) / 2,
            score,
            label: Math.round(data[offset + 5]),
          });

          if (final.length >= topK) break;
        }

        self.postMessage({ type: 'result', payload: final });
      }

    } catch (err) {
      self.postMessage({
        type: 'error',
        payload: err instanceof Error ? err.message : 'Inference failed'
      });
    }
  }
};
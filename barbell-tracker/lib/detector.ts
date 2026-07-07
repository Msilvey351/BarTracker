import type { Tensor as TensorType } from 'onnxruntime-web';

export interface Detection {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  score: number;
  label: number;
}

export interface ModelConfig {
  modelPath: string;
  nmsPath: string;
  inputWidth: number;
  inputHeight: number;
  topK: number;
  iouThreshold: number;
  scoreThreshold: number;
}

export const DEFAULT_CONFIG: ModelConfig = {
  modelPath: '/models/barbell.onnx',
  nmsPath: '',
  inputWidth: 640,
  inputHeight: 640,
  topK: 10,
  iouThreshold: 0.45,
  scoreThreshold: 0.25,
};

export function preprocessFrame(
  imageData: ImageData,
  modelWidth: number,
  modelHeight: number,
  ort: typeof import('onnxruntime-web')
): { tensor: TensorType; xRatio: number; yRatio: number; padX: number; padY: number } {
  const { width: srcW, height: srcH } = imageData;

  const scale = Math.min(modelWidth / srcW, modelHeight / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);
  const padX = Math.floor((modelWidth  - scaledW) / 2);
  const padY = Math.floor((modelHeight - scaledH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = modelWidth;
  canvas.height = modelHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, modelWidth, modelHeight);

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  srcCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
  ctx.drawImage(srcCanvas, padX, padY, scaledW, scaledH);

  const resized = ctx.getImageData(0, 0, modelWidth, modelHeight);
  const float32 = new Float32Array(3 * modelWidth * modelHeight);

  for (let i = 0; i < modelWidth * modelHeight; i++) {
    float32[i]                                = resized.data[i * 4]     / 255.0;
    float32[modelWidth * modelHeight + i]     = resized.data[i * 4 + 1] / 255.0;
    float32[2 * modelWidth * modelHeight + i] = resized.data[i * 4 + 2] / 255.0;
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, modelHeight, modelWidth]);
  return { tensor, xRatio: scale, yRatio: scale, padX, padY };
}

// ── Sigmoid ───────────────────────────────────────────────────────────────────
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── IoU for NMS ───────────────────────────────────────────────────────────────
function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width,  b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  return intersection / (aArea + bArea - intersection);
}

// ── NMS ───────────────────────────────────────────────────────────────────────
function nms(detections: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (iou(sorted[i], sorted[j]) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

// ── Postprocess ───────────────────────────────────────────────────────────────
export function postprocess(
  output: TensorType,
  xRatio: number,
  yRatio: number,
  srcWidth: number,
  srcHeight: number,
  modelWidth: number,
  modelHeight: number,
  padX: number = 0,
  padY: number = 0,
  scoreThreshold: number = 0.25,
  iouThreshold: number = 0.45,
  topK: number = 10,
): Detection[] {
  const data = output.data as Float32Array;
  const dims = output.dims;

  let detections: Detection[] = [];

  // ── Format 1: [1, 5, 8400] — raw YOLOv8 without NMS ─────────────────────
  if (dims.length === 3 && dims[1] < dims[2]) {
    const numAnchors = dims[2];
    const numAttribs = dims[1]; // 4 box coords + num_classes

    for (let i = 0; i < numAnchors; i++) {
      const cx = data[0 * numAnchors + i];
      const cy = data[1 * numAnchors + i];
      const w  = data[2 * numAnchors + i];
      const h  = data[3 * numAnchors + i];

      // Find best class score
      let maxScore = -Infinity;
      let maxClass = 0;
      for (let c = 4; c < numAttribs; c++) {
        const s = data[c * numAnchors + i];
        if (s > maxScore) {
          maxScore = s;
          maxClass = c - 4;
        }
      }

      // Sigmoid to convert logits → probabilities
      const score = sigmoid(maxScore);
      if (score < scoreThreshold) continue;

      // Convert model space → original image pixels
      const x  = ((cx - w / 2) - padX) / xRatio;
      const y  = ((cy - h / 2) - padY) / yRatio;
      const bw = w / xRatio;
      const bh = h / yRatio;

      const clampedX  = Math.max(0, x);
      const clampedY  = Math.max(0, y);
      const clampedW  = Math.max(0, Math.min(srcWidth  - clampedX, bw));
      const clampedH  = Math.max(0, Math.min(srcHeight - clampedY, bh));

      if (clampedW < 5 || clampedH < 5) continue;

      detections.push({
        x:       clampedX,
        y:       clampedY,
        width:   clampedW,
        height:  clampedH,
        centerX: clampedX + clampedW / 2,
        centerY: clampedY + clampedH / 2,
        score,
        label:   maxClass,
      });
    }

    // Apply NMS then take top K
    detections = nms(detections, iouThreshold).slice(0, topK);
  }

  // ── Format 2: [1, 300, 6] — baked NMS output ─────────────────────────────
  else if (dims.length === 3 && dims[2] === 6) {
    const numDetections = dims[1];

    for (let i = 0; i < numDetections; i++) {
      const offset = i * 6;
      const score  = data[offset + 4];
      if (score < scoreThreshold) continue;

      const x1 = data[offset + 0];
      const y1 = data[offset + 1];
      const x2 = data[offset + 2];
      const y2 = data[offset + 3];

      const x  = (x1 - padX) / xRatio;
      const y  = (y1 - padY) / yRatio;
      const bw = (x2 - x1) / xRatio;
      const bh = (y2 - y1) / yRatio;

      const clampedX = Math.max(0, x);
      const clampedY = Math.max(0, y);
      const clampedW = Math.max(0, Math.min(srcWidth  - clampedX, bw));
      const clampedH = Math.max(0, Math.min(srcHeight - clampedY, bh));

      if (clampedW < 5 || clampedH < 5) continue;

      detections.push({
        x:       clampedX,
        y:       clampedY,
        width:   clampedW,
        height:  clampedH,
        centerX: clampedX + clampedW / 2,
        centerY: clampedY + clampedH / 2,
        score,
        label:   Math.round(data[offset + 5]),
      });
    }
  }

  if (detections.length > 0 && Math.random() < 0.05) {
    console.log(`✅ Detections: ${detections.length} | Best score: ${detections[0].score.toFixed(3)} | Center: (${detections[0].centerX.toFixed(0)}, ${detections[0].centerY.toFixed(0)})`);
  }

  return detections;
}
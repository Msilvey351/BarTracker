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
  scoreThreshold: 0.05,
};

export function preprocessFrame(
  imageData: ImageData,
  modelWidth: number,
  modelHeight: number,
  ort: typeof import('onnxruntime-web')
): { tensor: TensorType; xRatio: number; yRatio: number; padX: number; padY: number } {
  const { width: srcW, height: srcH } = imageData;

  // ── Letterbox: scale to fit inside modelWidth×modelHeight with black padding ──
  const scale = Math.min(modelWidth / srcW, modelHeight / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);

  // Padding to centre the image (black edges)
  const padX = Math.floor((modelWidth - scaledW) / 2);
  const padY = Math.floor((modelHeight - scaledH) / 2);

  // Draw onto letterboxed canvas
  const canvas = document.createElement('canvas');
  canvas.width = modelWidth;
  canvas.height = modelHeight;
  const ctx = canvas.getContext('2d')!;

  // Fill black
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, modelWidth, modelHeight);

  // Draw source image scaled + centred
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  srcCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
  ctx.drawImage(srcCanvas, padX, padY, scaledW, scaledH);

  const resized = ctx.getImageData(0, 0, modelWidth, modelHeight);

  // ── Convert to float32 CHW RGB normalised 0-1 ─────────────────────────────
  const float32 = new Float32Array(3 * modelWidth * modelHeight);
  const pixels = resized.data;

  for (let i = 0; i < modelWidth * modelHeight; i++) {
    float32[i] = pixels[i * 4] / 255.0;                          // R
    float32[modelWidth * modelHeight + i] = pixels[i * 4 + 1] / 255.0;     // G
    float32[2 * modelWidth * modelHeight + i] = pixels[i * 4 + 2] / 255.0; // B
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, modelHeight, modelWidth]);
  return { tensor, xRatio: scale, yRatio: scale, padX, padY };
}

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
): Detection[] {
  const detections: Detection[] = [];
  const data = output.data as Float32Array;
  const numDetections = output.dims[1];

  // ── Find the highest scoring detection regardless of threshold ────────────
  let maxScore = 0;
  let maxIdx = 0;
  for (let i = 0; i < numDetections; i++) {
    const score = data[i * 6 + 4];
    if (score > maxScore) {
      maxScore = score;
      maxIdx = i;
    }
  }
  console.log(`Best detection: score=${maxScore.toFixed(4)} at index ${maxIdx}`);
  console.log(`Best box: [${data[maxIdx*6].toFixed(1)}, ${data[maxIdx*6+1].toFixed(1)}, ${data[maxIdx*6+2].toFixed(1)}, ${data[maxIdx*6+3].toFixed(1)}]`);
  // ─────────────────────────────────────────────────────────────────────────

  for (let i = 0; i < numDetections; i++) {
    const offset = i * 6;
    const x1    = data[offset + 0];
    const y1    = data[offset + 1];
    const x2    = data[offset + 2];
    const y2    = data[offset + 3];
    const score = data[offset + 4];
    const label = Math.round(data[offset + 5]);

    if (score < 0.05) continue;

    const x = (x1 - padX) / xRatio;
    const y = (y1 - padY) / yRatio;
    const w = (x2 - x1) / xRatio;
    const h = (y2 - y1) / yRatio;

    detections.push({
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(0, w),
      height: Math.max(0, h),
      centerX: Math.max(0, x) + Math.max(0, w) / 2,
      centerY: Math.max(0, y) + Math.max(0, h) / 2,
      score,
      label,
    });
  }

  return detections;
}
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

  // Scale to fit inside model dimensions preserving aspect ratio
  const scale = Math.min(modelWidth / srcW, modelHeight / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);

  // Centre padding — this is what shifts detections
  const padX = Math.floor((modelWidth  - scaledW) / 2);
  const padY = Math.floor((modelHeight - scaledH) / 2);

  if (Math.random() < 0.02) {
    console.log(`Preprocess: src=${srcW}x${srcH} scale=${scale.toFixed(3)} scaled=${scaledW}x${scaledH} pad=${padX},${padY}`);
  }

  // Draw letterboxed image
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

  // Draw centred
  ctx.drawImage(srcCanvas, padX, padY, scaledW, scaledH);

  const resized = ctx.getImageData(0, 0, modelWidth, modelHeight);

  // Convert to float32 CHW RGB
  const float32 = new Float32Array(3 * modelWidth * modelHeight);
  for (let i = 0; i < modelWidth * modelHeight; i++) {
    float32[i]                            = resized.data[i * 4]     / 255.0; // R
    float32[modelWidth * modelHeight + i] = resized.data[i * 4 + 1] / 255.0; // G
    float32[2 * modelWidth * modelHeight + i] = resized.data[i * 4 + 2] / 255.0; // B
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

  // Find best detection for debug
  let maxScore = 0;
  for (let i = 0; i < numDetections; i++) {
    const score = data[i * 6 + 4];
    if (score > maxScore) maxScore = score;
  }
  if (Math.random() < 0.05) {
    console.log(`Best score: ${maxScore.toFixed(3)} | scale: ${xRatio.toFixed(3)} | pad: ${padX},${padY} | src: ${srcWidth}x${srcHeight}`);
  }

  for (let i = 0; i < numDetections; i++) {
    const offset = i * 6;

    const x1    = data[offset + 0];
    const y1    = data[offset + 1];
    const x2    = data[offset + 2];
    const y2    = data[offset + 3];
    const score = data[offset + 4];
    const label = Math.round(data[offset + 5]);

    if (score < 0.05) continue;

    // ── Correct coordinate mapping ─────────────────────────────────────────
    // 1. Remove padding offset (centres the image in model space)
    // 2. Divide by scale to get back to original image pixels
    const x = (x1 - padX) / xRatio;
    const y = (y1 - padY) / yRatio;
    const w = (x2 - x1) / xRatio;
    const h = (y2 - y1) / yRatio;

    // Clamp to image bounds
    const cx = Math.max(0, Math.min(srcWidth, x));
    const cy = Math.max(0, Math.min(srcHeight, y));
    const cw = Math.max(0, Math.min(srcWidth - cx, w));
    const ch = Math.max(0, Math.min(srcHeight - cy, h));

    if (cw < 5 || ch < 5) continue; // skip tiny detections

    detections.push({
      x: cx,
      y: cy,
      width: cw,
      height: ch,
      centerX: cx + cw / 2,
      centerY: cy + ch / 2,
      score,
      label,
    });
  }

  return detections;
}
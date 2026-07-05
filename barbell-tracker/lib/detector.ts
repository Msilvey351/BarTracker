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
  inputWidth: 416,
  inputHeight: 416,
  topK: 10,
  iouThreshold: 0.45,
  scoreThreshold: 0.25,
};

export function preprocessFrame(
  imageData: ImageData,
  modelWidth: number,
  modelHeight: number,
  ort: typeof import('onnxruntime-web')
): { tensor: TensorType; xRatio: number; yRatio: number } {
  const { width: srcW, height: srcH } = imageData;

  const maxSide = Math.max(srcW, srcH);
  const xRatio = maxSide / srcW;
  const yRatio = maxSide / srcH;

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = modelWidth;
  tmpCanvas.height = modelHeight;
  const ctx = tmpCanvas.getContext('2d')!;

  const scaledW = Math.round(srcW * (modelWidth / maxSide));
  const scaledH = Math.round(srcH * (modelHeight / maxSide));
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, modelWidth, modelHeight);

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  srcCanvas.getContext('2d')!.putImageData(imageData, 0, 0);
  ctx.drawImage(srcCanvas, 0, 0, scaledW, scaledH);

  const resized = ctx.getImageData(0, 0, modelWidth, modelHeight);

  const float32 = new Float32Array(3 * modelWidth * modelHeight);
  const rOffset = 0;
  const gOffset = modelWidth * modelHeight;
  const bOffset = 2 * modelWidth * modelHeight;

  for (let i = 0; i < modelWidth * modelHeight; i++) {
    float32[rOffset + i] = resized.data[i * 4 + 0] / 255.0;
    float32[gOffset + i] = resized.data[i * 4 + 1] / 255.0;
    float32[bOffset + i] = resized.data[i * 4 + 2] / 255.0;
  }

  const tensor = new ort.Tensor('float32', float32, [1, 3, modelHeight, modelWidth]);
  return { tensor, xRatio, yRatio };
}

export function postprocess(
  output: TensorType,
  xRatio: number,
  yRatio: number,
  srcWidth: number,
  srcHeight: number,
  modelWidth: number,
  modelHeight: number
): Detection[] {
  const detections: Detection[] = [];
  const data = output.data as Float32Array;

  // YOLOv8 with baked NMS output shape: [1, num_detections, 6]
  // Each detection: [x1, y1, x2, y2, score, class_id]
  const numDetections = output.dims[1];

  for (let i = 0; i < numDetections; i++) {
    const offset = i * 6;

    const x1    = data[offset + 0];
    const y1    = data[offset + 1];
    const x2    = data[offset + 2];
    const y2    = data[offset + 3];
    const score = data[offset + 4];
    const label = Math.round(data[offset + 5]);

    if (score < 0.25) continue;

    // Scale from model space back to original image space
    const scaleX = srcWidth / (modelWidth / xRatio);
    const scaleY = srcHeight / (modelHeight / yRatio);

    const x = x1 * scaleX;
    const y = y1 * scaleY;
    const w = (x2 - x1) * scaleX;
    const h = (y2 - y1) * scaleY;

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
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Detection, ModelConfig } from '@/lib/detector';
import { DEFAULT_CONFIG, preprocessFrame } from '@/lib/detector';

export type DetectorStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useDetectorWorker(config: ModelConfig = DEFAULT_CONFIG) {
  const [status, setStatus] = useState<DetectorStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const ortRef = useRef<typeof import('onnxruntime-web') | null>(null);
  const pendingRef = useRef<((d: Detection[]) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      setStatus('loading');
      try {
        const ort = await import('onnxruntime-web');
        ortRef.current = ort;

        const worker = new Worker(
          new URL('../workers/detector.worker.ts', import.meta.url),
          { type: 'module' }
        );

        worker.onmessage = (e) => {
          const { type, payload } = e.data;
          if (type === 'ready') {
            if (!cancelled) setStatus('ready');
          }
          if (type === 'result') {
            if (pendingRef.current) {
              pendingRef.current(payload as Detection[]);
              pendingRef.current = null;
            }
          }
          if (type === 'error') {
            console.error('Worker error:', payload);
            if (!cancelled) {
              setError(payload);
              setStatus('error');
            }
          }
        };

        worker.onerror = (e) => {
          console.error('Worker crashed:', e);
          if (!cancelled) {
            setError('Worker crashed');
            setStatus('error');
          }
        };

        workerRef.current = worker;
        worker.postMessage({
          type: 'load',
          payload: { modelPath: config.modelPath }
        });

      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to init worker');
          setStatus('error');
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [config.modelPath]);

  const detect = useCallback(
    async (imageData: ImageData): Promise<Detection[]> => {
      const ort = ortRef.current;
      const worker = workerRef.current;

      if (!ort || !worker || status !== 'ready') return [];

      const { inputWidth: mW, inputHeight: mH } = config;
      const { width: srcW, height: srcH } = imageData;

      const { tensor, xRatio, padX, padY } = preprocessFrame(imageData, mW, mH, ort);

      // ── Zero-copy transfer to worker ──────────────────────────────────────
      const float32 = new Float32Array(tensor.data as Float32Array);

      return new Promise((resolve) => {
        pendingRef.current = resolve;

        worker.postMessage(
          {
            type: 'detect',
            payload: {
              float32,
              shape: tensor.dims,
              srcWidth: srcW,
              srcHeight: srcH,
              padX,
              padY,
              scale: xRatio,
              scoreThreshold: config.scoreThreshold,
              iouThreshold: config.iouThreshold,
              topK: config.topK,
            }
          },
          [float32.buffer] // ← transfer ownership, zero copy
        );
      });
    },
    [status, config]
  );

  return { status, error, detect };
}
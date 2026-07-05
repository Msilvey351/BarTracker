'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { DEFAULT_CONFIG, preprocessFrame, postprocess } from '@/lib/detector';
import type { ModelConfig, Detection } from '@/lib/detector';

export type DetectorStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useDetector(config: ModelConfig = DEFAULT_CONFIG) {
  const [status, setStatus] = useState<DetectorStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const netSession = useRef<import('onnxruntime-web').InferenceSession | null>(null);
  const ortRef = useRef<typeof import('onnxruntime-web') | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus('loading');
      try {
        const ort = await import('onnxruntime-web');

        // Point to ALL ort files in public root
        ort.env.wasm.wasmPaths = '/';
        ort.env.wasm.numThreads = 1; // ← add this — disables threading, avoids .jsep issues

        const net = await ort.InferenceSession.create(config.modelPath, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });

        if (cancelled) return;

        netSession.current = net;
        ortRef.current = ort;
        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load model');
          setStatus('error');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [config.modelPath]);

  const detect = useCallback(
    async (imageData: ImageData): Promise<Detection[]> => {
      const ort = ortRef.current;
      const net = netSession.current;

      if (!ort || !net || status !== 'ready') return [];

      const { width: srcW, height: srcH } = imageData;
      const { inputWidth: mW, inputHeight: mH } = config;

      // Preprocess
      const { tensor, xRatio, yRatio } = preprocessFrame(imageData, mW, mH, ort);

      // Run model
      const results = await net.run({ images: tensor });

      // ── DEBUG — log everything the model outputs ──────────────────────────
      console.log('=== MODEL OUTPUT DEBUG ===');
      console.log('Output keys:', Object.keys(results));
      for (const [key, value] of Object.entries(results)) {
        console.log(`Key: "${key}"`);
        console.log(`  dims:`, value.dims);
        console.log(`  type:`, value.type);
        console.log(`  first 12 values:`, Array.from(value.data as Float32Array).slice(0, 12));
      }
      // ─────────────────────────────────────────────────────────────────────

      const output = results['output0'];
      if (!output) {
        console.error('No output0 found! Keys were:', Object.keys(results));
        return [];
      }

      return postprocess(output, xRatio, yRatio, srcW, srcH, mW, mH);
    },
    [status, config]
  );

  return { status, error, detect };
}
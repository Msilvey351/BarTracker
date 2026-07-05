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

        ort.env.wasm.wasmPaths = '/';
        ort.env.wasm.numThreads = 1;

        const net = await ort.InferenceSession.create(config.modelPath, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });

        if (cancelled) return;

        console.log('✅ Model loaded!');
        console.log('Input names:', net.inputNames);
        console.log('Output names:', net.outputNames);

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
      const { tensor, xRatio, yRatio, padX, padY } = preprocessFrame(imageData, mW, mH, ort);

      // ── Sanity check tensor values ──────────────────────────────────────────
      const tensorData = tensor.data as Float32Array;
      const nonZero = tensorData.filter(v => v > 0).length;
      const maxVal = Math.max(...Array.from(tensorData.slice(0, 1000)));
      console.log(`Tensor: ${tensorData.length} values, ${nonZero} non-zero, max=${maxVal.toFixed(3)}`);
      // ───────────────────────────────────────────────────────────────────────

      // Run model using actual input/output names
      const inputName = net.inputNames[0];
      const results = await net.run({ [inputName]: tensor });

      const outputName = net.outputNames[0];
      const output = results[outputName];

      if (!output) {
        console.error('No output found! Output names:', net.outputNames);
        return [];
      }

      // Log occasionally to avoid spam
      if (Math.random() < 0.033) {
        console.log(`Input: "${inputName}" Output: "${outputName}"`);
        console.log('dims:', output.dims);
        console.log('first 6 vals:', Array.from(output.data as Float32Array).slice(0, 6));
      }

      return postprocess(output, xRatio, yRatio, srcW, srcH, mW, mH, padX, padY);
    },
    [status, config]
  );

  return { status, error, detect };
}
// hooks/useTracker.ts
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'seeded' | 'lost' | 'error';

export interface TrackedPoint {
  x: number;
  y: number;
  tracked: boolean;
  videoTimestamp: number;
}

export function useTracker() {
  const [status, setStatus] = useState<TrackerStatus>('idle');
  const workerRef = useRef<Worker | null>(null);

  // Pending resolve for async track calls
  const pendingTrackRef = useRef<((p: TrackedPoint) => void) | null>(null);
  const pendingSeedRef  = useRef<((p: { x: number; y: number }) => void) | null>(null);

  useEffect(() => {
    setStatus('loading');

    const worker = new Worker(
      new URL('../workers/tracker.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const { type, payload } = e.data;

      if (type === 'ready') {
        setStatus('ready');
      }

      if (type === 'seeded') {
        setStatus('seeded');
        if (pendingSeedRef.current) {
          pendingSeedRef.current(payload);
          pendingSeedRef.current = null;
        }
      }

      if (type === 'tracked') {
        if (payload.tracked) {
          setStatus('seeded');
        } else {
          setStatus('lost');
        }
        if (pendingTrackRef.current) {
          pendingTrackRef.current(payload as TrackedPoint);
          pendingTrackRef.current = null;
        }
      }

      if (type === 'reset_ok') {
        setStatus('ready');
      }

      if (type === 'error') {
        setStatus('error');
      }
    };

    worker.onerror = () => setStatus('error');
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Seed — call once when user taps ──────────────────────────────────────
  const seed = useCallback(async (
    imageData: ImageData,
    x: number,
    y: number
  ): Promise<{ x: number; y: number }> => {
    const worker = workerRef.current;
    if (!worker) return { x, y };

    return new Promise((resolve) => {
      pendingSeedRef.current = resolve;

      // Transfer image data as transferable for zero-copy
      const buffer = new Uint8ClampedArray(imageData.data);
      const transferableImageData = new ImageData(buffer, imageData.width, imageData.height);

      worker.postMessage({
        type: 'seed',
        payload: {
          imageData: transferableImageData,
          x,
          y,
          width:  imageData.width,
          height: imageData.height,
        }
      });
    });
  }, []);

  // ── Track — call every frame ──────────────────────────────────────────────
  const track = useCallback(async (
    imageData: ImageData,
    videoTimestamp: number = performance.now()
  ): Promise<TrackedPoint> => {
    const worker = workerRef.current;
    if (!worker) return { x: 0, y: 0, tracked: false, videoTimestamp };

    return new Promise((resolve) => {
      pendingTrackRef.current = resolve;

      worker.postMessage({
        type: 'track',
        payload: {
          imageData,
          width:  imageData.width,
          height: imageData.height,
          videoTimestamp,
        }
      });
    });
  }, []);

  // ── Reset — clear seed ────────────────────────────────────────────────────
  const reset = useCallback(() => {
    workerRef.current?.postMessage({ type: 'reset' });
  }, []);

  return { status, seed, track, reset };
}
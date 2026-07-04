'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

export interface WebcamState {
  isReady: boolean;
  error: string | null;
  width: number;
  height: number;
}

export function useWebcam(videoRef: React.RefObject<HTMLVideoElement>) {
  const [state, setState] = useState<WebcamState>({
    isReady: false,
    error: null,
    width: 0,
    height: 0,
  });

  const streamRef = useRef<MediaStream | null>(null);

  // Stop is stable — no setState, just kills the stream
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        setState({
          isReady: true,
          error: null,
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight,
        });
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isReady: false,
        error: err instanceof Error ? err.message : 'Camera access denied',
      }));
    }
  }, [videoRef]);

  const stop = useCallback(() => {
    stopStream();
    setState((prev) => ({ ...prev, isReady: false }));
  }, [stopStream]);

  const captureFrame = useCallback(
    (offscreenCanvas: HTMLCanvasElement): ImageData | null => {
      const video = videoRef.current;
      if (!video || !state.isReady) return null;

      const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;

      offscreenCanvas.width = video.videoWidth;
      offscreenCanvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);

      return ctx.getImageData(0, 0, offscreenCanvas.width, offscreenCanvas.height);
    },
    [videoRef, state.isReady]
  );

  // Cleanup on unmount — use stopStream, NOT stop (avoids setState on unmounted component)
  useEffect(() => {
    return () => stopStream();
  }, [stopStream]);

  return { ...state, start, stop, captureFrame };
}
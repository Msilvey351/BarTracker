'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useWebcam } from '@/hooks/useWebcam';
import { useDetector } from '@/hooks/useDetector';
import { useKinematics } from '@/hooks/useKinematics';
import { renderFrame, DEFAULT_RENDER_OPTIONS } from '@/lib/renderer';
import { DEFAULT_CONFIG } from '@/lib/detector';

export default function BarbellTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const isRunningRef = useRef(false);

  const webcam = useWebcam(videoRef);
  const detector = useDetector(DEFAULT_CONFIG);
  const { kinematics, update: updateKinematics, reset: resetKinematics } = useKinematics();

  const [isTracking, setIsTracking] = useState(false);
  const [fps, setFps] = useState(0);
  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // ── Stable refs so the loop/effects never have stale or changing dependencies ──
  const kinematicsRef = useRef(kinematics);
  useEffect(() => { kinematicsRef.current = kinematics; }, [kinematics]);

  const webcamRef = useRef(webcam);
  useEffect(() => { webcamRef.current = webcam; }, [webcam]);

  const detectorRef = useRef(detector);
  useEffect(() => { detectorRef.current = detector; }, [detector]);

  const updateKinematicsRef = useRef(updateKinematics);
  useEffect(() => { updateKinematicsRef.current = updateKinematics; }, [updateKinematics]);

  // Create offscreen canvas once
  useEffect(() => {
    offscreenCanvasRef.current = document.createElement('canvas');
  }, []);

  // ── Animation loop — stable, no changing deps ─────────────────────────────
  const loop = useCallback(async () => {
    if (!isRunningRef.current) return;

    const video = videoRef.current;
    const overlay = overlayCanvasRef.current;
    const offscreen = offscreenCanvasRef.current;

    if (video && overlay && offscreen) {
      const imageData = webcamRef.current.captureFrame(offscreen);

      if (imageData) {
        const detections = await detectorRef.current.detect(imageData);
        updateKinematicsRef.current(detections);

        renderFrame(
          overlay,
          video.videoWidth,
          video.videoHeight,
          detections,
          kinematicsRef.current,
          DEFAULT_RENDER_OPTIONS
        );

        // FPS counter
        fpsRef.current.frames++;
        const now = performance.now();
        if (now - fpsRef.current.last > 1000) {
          setFps(fpsRef.current.frames);
          fpsRef.current = { frames: 0, last: now };
        }
      }
    }

    animFrameRef.current = requestAnimationFrame(loop);
  }, []); // ← no dependencies, uses refs only

  // ── Start / stop ──────────────────────────────────────────────────────────
  const startTracking = useCallback(async () => {
    if (!webcamRef.current.isReady) await webcamRef.current.start();
    isRunningRef.current = true;
    setIsTracking(true);
    animFrameRef.current = requestAnimationFrame(loop);
  }, [loop]);

  const stopTracking = useCallback(() => {
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
  }, []);

  // ── Cleanup on unmount only — stable, no deps ─────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      webcamRef.current.stop();
    };
  }, []); // ← empty, runs once on unmount only

  return (
    <div className="flex flex-col items-center gap-4 p-4 bg-slate-950 min-h-screen text-white">
      <h1 className="text-2xl font-bold tracking-tight">🏋️ Barbell Tracker</h1>

      <div className="flex gap-3 text-sm flex-wrap justify-center">
        <StatusBadge label="Model" value={detector.status} ok={detector.status === 'ready'} />
        <StatusBadge label="Camera" value={webcam.isReady ? 'ready' : 'off'} ok={webcam.isReady} />
        <StatusBadge label="FPS" value={fps.toString()} ok={fps > 5} />
      </div>

      <div
        className="relative rounded-xl overflow-hidden border border-slate-700 bg-black w-full"
        style={{ maxWidth: 720, aspectRatio: '16/9' }}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          playsInline
          muted
        />
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
        />
        {!webcam.isReady && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
            Camera not started
          </div>
        )}
      </div>

      <div className="flex gap-3 flex-wrap justify-center">
        <button
          onClick={isTracking ? stopTracking : startTracking}
          disabled={detector.status === 'loading'}
          className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors
            ${isTracking
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed'
            }`}
        >
          {detector.status === 'loading'
            ? 'Loading model...'
            : isTracking ? '⏹ Stop' : '▶ Start Tracking'}
        </button>

        <button
          onClick={resetKinematics}
          className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600"
        >
          🔄 Reset Set
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-xl">
        <StatCard
          label="Velocity"
          value={kinematics.pixelsPerMetre ? `${kinematics.velocity.toFixed(2)} m/s` : '-- m/s'}
          highlight={kinematics.velocity > 0.5}
        />
        <StatCard
          label="Peak"
          value={kinematics.pixelsPerMetre ? `${kinematics.peakVelocity.toFixed(2)} m/s` : '-- m/s'}
        />
        <StatCard label="Reps" value={kinematics.repCount.toString()} large />
        <StatCard label="Phase" value={kinematics.phase.toUpperCase()} />
      </div>

      {(webcam.error || detector.error) && (
        <div className="text-red-400 text-sm bg-red-950 px-4 py-2 rounded-lg">
          {webcam.error || detector.error}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className={`px-3 py-1 rounded-full text-xs font-mono border
      ${ok ? 'border-green-700 text-green-400' : 'border-slate-600 text-slate-400'}`}>
      {label}: <span className="font-bold">{value}</span>
    </div>
  );
}

function StatCard({
  label, value, highlight = false, large = false,
}: {
  label: string; value: string; highlight?: boolean; large?: boolean;
}) {
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-center">
      <div className="text-slate-400 text-xs mb-1">{label}</div>
      <div className={`font-bold font-mono ${large ? 'text-3xl' : 'text-lg'}
        ${highlight ? 'text-green-400' : 'text-white'}`}>
        {value}
      </div>
    </div>
  );
}
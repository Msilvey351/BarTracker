'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useWebcam } from '@/hooks/useWebcam';
import { useDetector } from '@/hooks/useDetector';
import { useKinematics } from '@/hooks/useKinematics';
import { renderFrame, DEFAULT_RENDER_OPTIONS } from '@/lib/renderer';
import { DEFAULT_CONFIG } from '@/lib/detector';

type Mode = 'camera' | 'upload';

export default function BarbellTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number>(0);
  const isRunningRef = useRef(false);

  const webcam = useWebcam(videoRef);
  const detector = useDetector(DEFAULT_CONFIG);
  const { kinematics, update: updateKinematics, reset: resetKinematics } = useKinematics();

  const [mode, setMode] = useState<Mode>('camera');
  const [isTracking, setIsTracking] = useState(false);
  const [fps, setFps] = useState(0);
  const [uploadedVideo, setUploadedVideo] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // Stable refs
  const kinematicsRef = useRef(kinematics);
  useEffect(() => { kinematicsRef.current = kinematics; }, [kinematics]);
  const webcamRef = useRef(webcam);
  useEffect(() => { webcamRef.current = webcam; }, [webcam]);
  const detectorRef = useRef(detector);
  useEffect(() => { detectorRef.current = detector; }, [detector]);
  const updateKinematicsRef = useRef(updateKinematics);
  useEffect(() => { updateKinematicsRef.current = updateKinematics; }, [updateKinematics]);

  useEffect(() => {
    offscreenCanvasRef.current = document.createElement('canvas');
  }, []);

  // ── Animation loop ────────────────────────────────────────────────────────
  const loop = useCallback(async () => {
    if (!isRunningRef.current) return;

    const video = videoRef.current;
    const overlay = overlayCanvasRef.current;
    const offscreen = offscreenCanvasRef.current;

    // Stop loop when uploaded video ends
    if (video && video.ended) {
      isRunningRef.current = false;
      setIsTracking(false);
      return;
    }

    if (video && overlay && offscreen && !video.paused) {
      offscreen.width = video.videoWidth;
      offscreen.height = video.videoHeight;
      const ctx = offscreen.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);

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

        fpsRef.current.frames++;
        const now = performance.now();
        if (now - fpsRef.current.last > 1000) {
          setFps(fpsRef.current.frames);
          fpsRef.current = { frames: 0, last: now };
        }
      }
    }

    animFrameRef.current = requestAnimationFrame(loop);
  }, []);

  // ── Camera mode ───────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (!webcamRef.current.isReady) await webcamRef.current.start();
    isRunningRef.current = true;
    setIsTracking(true);
    animFrameRef.current = requestAnimationFrame(loop);
  }, [loop]);

  const stopCamera = useCallback(() => {
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
  }, []);

  // ── Upload mode ───────────────────────────────────────────────────────────
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Revoke previous URL
    if (uploadedVideo) URL.revokeObjectURL(uploadedVideo);

    const url = URL.createObjectURL(file);
    setUploadedVideo(url);
    setVideoReady(false);
    resetKinematics();

    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.load();
    }
  }, [uploadedVideo, resetKinematics]);

  const startVideoAnalysis = useCallback(() => {
    const video = videoRef.current;
    if (!video || !videoReady) return;

    video.currentTime = 0;
    video.playbackRate = playbackSpeed;
    video.play();

    isRunningRef.current = true;
    setIsTracking(true);
    animFrameRef.current = requestAnimationFrame(loop);
  }, [videoReady, playbackSpeed, loop]);

  const pauseVideoAnalysis = useCallback(() => {
    videoRef.current?.pause();
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
  }, []);

  // ── Mode switching ────────────────────────────────────────────────────────
  const switchMode = useCallback((newMode: Mode) => {
    // Stop everything first
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);

    if (newMode === 'camera') {
      webcamRef.current.stop();
      if (videoRef.current) {
        videoRef.current.src = '';
        videoRef.current.srcObject = null;
      }
    } else {
      webcamRef.current.stop();
    }

    resetKinematics();
    setMode(newMode);
    setVideoReady(false);
  }, [resetKinematics]);

  // ── Playback speed ────────────────────────────────────────────────────────
  const handleSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, []);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      webcamRef.current.stop();
      if (uploadedVideo) URL.revokeObjectURL(uploadedVideo);
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 p-4 bg-slate-950 min-h-screen text-white">
      <h1 className="text-2xl font-bold tracking-tight">🏋️ Barbell Tracker</h1>

      {/* Status badges */}
      <div className="flex gap-3 text-sm flex-wrap justify-center">
        <StatusBadge label="Model" value={detector.status} ok={detector.status === 'ready'} />
        <StatusBadge label="Camera" value={webcam.isReady ? 'ready' : 'off'} ok={webcam.isReady} />
        <StatusBadge label="FPS" value={fps.toString()} ok={fps > 5} />
      </div>

      {/* Mode toggle */}
      <div className="flex bg-slate-800 rounded-lg p-1 gap-1">
        <button
          onClick={() => switchMode('camera')}
          className={`px-5 py-2 rounded-md text-sm font-semibold transition-colors
            ${mode === 'camera' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
        >
          📷 Live Camera
        </button>
        <button
          onClick={() => switchMode('upload')}
          className={`px-5 py-2 rounded-md text-sm font-semibold transition-colors
            ${mode === 'upload' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
        >
          📁 Upload Video
        </button>
      </div>

      {/* Video area */}
      <div
        className="relative rounded-xl overflow-hidden border border-slate-700 bg-black w-full"
        style={{ maxWidth: 720, aspectRatio: '16/9' }}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          playsInline
          muted
          onLoadedData={() => setVideoReady(true)}
        />
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
        />
        {/* Empty state */}
        {!webcam.isReady && !uploadedVideo && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
            {mode === 'camera' ? 'Camera not started' : 'No video uploaded'}
          </div>
        )}
      </div>

      {/* ── Camera controls ── */}
      {mode === 'camera' && (
        <div className="flex gap-3 flex-wrap justify-center">
          <button
            onClick={isTracking ? stopCamera : startCamera}
            disabled={detector.status !== 'ready'}
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
      )}

      {/* ── Upload controls ── */}
      {mode === 'upload' && (
        <div className="flex flex-col items-center gap-3 w-full max-w-xl">

          {/* File picker */}
          <label className="w-full cursor-pointer">
            <div className="border-2 border-dashed border-slate-600 hover:border-blue-500
              rounded-xl p-6 text-center transition-colors">
              <div className="text-3xl mb-2">📹</div>
              <div className="text-sm text-slate-300 font-semibold">
                {uploadedVideo ? 'Click to change video' : 'Click to upload a video'}
              </div>
              <div className="text-xs text-slate-500 mt-1">MP4, MOV, WebM supported</div>
            </div>
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>

          {/* Playback speed */}
          {uploadedVideo && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">Speed:</span>
              {[0.25, 0.5, 1, 1.5, 2].map((speed) => (
                <button
                  key={speed}
                  onClick={() => handleSpeedChange(speed)}
                  className={`px-3 py-1 rounded-md text-xs font-mono transition-colors
                    ${playbackSpeed === speed
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          )}

          {/* Play/pause + reset */}
          {uploadedVideo && (
            <div className="flex gap-3">
              <button
                onClick={isTracking ? pauseVideoAnalysis : startVideoAnalysis}
                disabled={!videoReady || detector.status !== 'ready'}
                className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors
                  ${isTracking
                    ? 'bg-yellow-600 hover:bg-yellow-700'
                    : 'bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed'
                  }`}
              >
                {!videoReady
                  ? 'Loading video...'
                  : isTracking ? '⏸ Pause' : '▶ Analyse Video'}
              </button>
              <button
                onClick={resetKinematics}
                className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600"
              >
                🔄 Reset
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stats */}
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

      {/* Errors */}
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
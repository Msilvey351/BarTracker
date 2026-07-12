'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useWebcam } from '@/hooks/useWebcam';
import { useDetectorWorker } from '@/hooks/useDetectorWorker';
import { useKinematics } from '@/hooks/useKinematics';
import { renderFrame, DEFAULT_RENDER_OPTIONS } from '@/lib/renderer';
import { DEFAULT_CONFIG, PLATE_CONFIG } from '@/lib/detector';
import type { Detection } from '@/lib/detector';
import type { RepStats } from '@/lib/kinematics';

type Mode = 'camera' | 'upload';
type AnalysisState = 'idle' | 'analysing' | 'complete';

export default function BarbellTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Camera loop refs
  const animFrameRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const inferenceInFlightRef = useRef(false);
  const plateInFlightRef = useRef(false);
  const lastDetectionsRef = useRef<Detection[]>([]);

  // Frame-by-frame refs
  const analysisAbortRef = useRef(false);

  const webcam = useWebcam(videoRef);
  const detector = useDetectorWorker(DEFAULT_CONFIG);
  const plateDetector = useDetectorWorker(PLATE_CONFIG);
  const {
    kinematics,
    update: updateKinematics,
    updateWithTimestamp,
    updateCalibration,
    reset: resetKinematics,
    resetAll,
    setCalibration,
  } = useKinematics();

  const [mode, setMode] = useState<Mode>('camera');
  const [isTracking, setIsTracking] = useState(false);
  const [fps, setFps] = useState(0);
  const [uploadedVideo, setUploadedVideo] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [setComplete, setSetComplete] = useState(false);
  const [completedReps, setCompletedReps] = useState<RepStats[]>([]);
  const [manualCal, setManualCal] = useState<string>('');
  const [analysisState, setAnalysisState] = useState<AnalysisState>('idle');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);

  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // Stable refs
  const kinematicsRef = useRef(kinematics);
  useEffect(() => { kinematicsRef.current = kinematics; }, [kinematics]);
  const webcamRef = useRef(webcam);
  useEffect(() => { webcamRef.current = webcam; }, [webcam]);
  const detectorRef = useRef(detector);
  useEffect(() => { detectorRef.current = detector; }, [detector]);
  const plateDetectorRef = useRef(plateDetector);
  useEffect(() => { plateDetectorRef.current = plateDetector; }, [plateDetector]);
  const updateKinematicsRef = useRef(updateKinematics);
  useEffect(() => { updateKinematicsRef.current = updateKinematics; }, [updateKinematics]);
  const updateWithTimestampRef = useRef(updateWithTimestamp);
  useEffect(() => { updateWithTimestampRef.current = updateWithTimestamp; }, [updateWithTimestamp]);
  const updateCalibrationRef = useRef(updateCalibration);
  useEffect(() => { updateCalibrationRef.current = updateCalibration; }, [updateCalibration]);

  useEffect(() => {
    offscreenCanvasRef.current = document.createElement('canvas');
  }, []);

  // ── End set (camera mode) ─────────────────────────────────────────────────
  const endSet = useCallback(() => {
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
    const reps = kinematicsRef.current.repHistory;
    if (reps.length > 0) {
      setCompletedReps(reps);
      setSetComplete(true);
    }
  }, []);

  // ── Display offset ────────────────────────────────────────────────────────
  const getDisplayOffset = useCallback(() => {
    const video = videoRef.current;
    const overlay = overlayCanvasRef.current;
    if (!video || !overlay) return { scale: 1, offsetX: 0, offsetY: 0 };
    const displayW = overlay.clientWidth;
    const displayH = overlay.clientHeight;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    if (!videoW || !videoH) return { scale: 1, offsetX: 0, offsetY: 0 };
    const scale   = Math.min(displayW / videoW, displayH / videoH);
    const offsetX = (displayW - videoW * scale) / 2;
    const offsetY = (displayH - videoH * scale) / 2;
    return { scale, offsetX, offsetY };
  }, []);

  // ── Capture current video frame ───────────────────────────────────────────
  const captureCurrentFrame = useCallback((): ImageData | null => {
    const video = videoRef.current;
    const offscreen = offscreenCanvasRef.current;
    if (!video || !offscreen) return null;
    offscreen.width  = video.videoWidth;
    offscreen.height = video.videoHeight;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return ctx.getImageData(0, 0, offscreen.width, offscreen.height);
  }, []);

  // ── Render overlay ────────────────────────────────────────────────────────
  const renderCurrentFrame = useCallback((detections: Detection[]) => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const { scale, offsetX, offsetY } = getDisplayOffset();
    renderFrame(
      overlay,
      overlay.clientWidth,
      overlay.clientHeight,
      detections,
      kinematicsRef.current,
      DEFAULT_RENDER_OPTIONS,
      scale,
      offsetX,
      offsetY,
    );
  }, [getDisplayOffset]);

  // ── Frame-by-frame video analysis ─────────────────────────────────────────
  const analyseVideoFrameByFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    resetAll();
    analysisAbortRef.current = false;
    setAnalysisState('analysing');
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisProgress(0);

    const videoFps  = 30;
    const frameTime = 1 / videoFps;
    const duration  = video.duration;
    const estimated = Math.floor(duration * videoFps);
    setTotalFrames(estimated);

    video.pause();
    video.currentTime = 0;

    // Wait for seek
    await new Promise<void>(resolve => {
      const handler = () => { video.removeEventListener('seeked', handler); resolve(); };
      video.addEventListener('seeked', handler);
    });

    let frameIndex = 0;
    let calibrationAttempted = false;

    while (video.currentTime < duration && !analysisAbortRef.current) {
      const imageData = captureCurrentFrame();

      if (imageData) {
        // ── Plate calibration — first 90 frames only ──────────────────────
        if (!kinematicsRef.current.calibrationLocked && !calibrationAttempted) {
          const plateResult = await plateDetectorRef.current.detect(imageData);
          if (plateResult.length > 0) {
            updateCalibrationRef.current(plateResult);
            calibrationAttempted = true;
          }
          if (frameIndex > 90) calibrationAttempted = true;
        }

        // ── Barbell detection — use VIDEO timestamp for determinism ────────
        const result = await detectorRef.current.detect(imageData);
        if (result.length > 0) {
          // video.currentTime is in seconds → convert to ms
          updateWithTimestampRef.current(result, video.currentTime * 1000);
          renderCurrentFrame(result);
        }
      }

      frameIndex++;
      setAnalysisProgress(frameIndex);

      // Advance exactly one frame
      const nextTime = video.currentTime + frameTime;
      if (nextTime >= duration) break;

      video.currentTime = nextTime;

      // Wait for seek
      await new Promise<void>(resolve => {
        const handler = () => { video.removeEventListener('seeked', handler); resolve(); };
        video.addEventListener('seeked', handler);
        setTimeout(resolve, 100); // fallback
      });
    }

    if (!analysisAbortRef.current) {
      setAnalysisState('complete');
      const reps = kinematicsRef.current.repHistory;
      if (reps.length > 0) {
        setCompletedReps(reps);
        setSetComplete(true);
      } else {
        setAnalysisState('idle');
      }
    } else {
      setAnalysisState('idle');
    }
  }, [captureCurrentFrame, renderCurrentFrame, resetAll]);

  const stopAnalysis = useCallback(() => {
    analysisAbortRef.current = true;
    setAnalysisState('idle');
  }, []);

  // ── Camera animation loop ─────────────────────────────────────────────────
  const loop = useCallback(() => {
    if (!isRunningRef.current) return;

    const video     = videoRef.current;
    const overlay   = overlayCanvasRef.current;
    const offscreen = offscreenCanvasRef.current;

    if (video && video.ended) {
      endSet();
      return;
    }

    if (video && overlay && offscreen && !video.paused) {
      offscreen.width  = video.videoWidth;
      offscreen.height = video.videoHeight;
      const ctx = offscreen.getContext('2d', { willReadFrequently: true });

      if (ctx) {
        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);

        // Barbell — tracking with wall clock time
        if (!inferenceInFlightRef.current && detectorRef.current.status === 'ready') {
          inferenceInFlightRef.current = true;
          detectorRef.current.detect(imageData).then((result) => {
            if (result.length > 0) {
              lastDetectionsRef.current = result;
              updateKinematicsRef.current(result);
            }
            inferenceInFlightRef.current = false;
          });
        }

        // Plate — calibration once only
        if (
          !plateInFlightRef.current &&
          !kinematicsRef.current.calibrationLocked &&
          plateDetectorRef.current.status === 'ready'
        ) {
          plateInFlightRef.current = true;
          plateDetectorRef.current.detect(imageData).then((result) => {
            if (result.length > 0) updateCalibrationRef.current(result);
            plateInFlightRef.current = false;
          });
        }

        const { scale, offsetX, offsetY } = getDisplayOffset();
        renderFrame(
          overlay,
          overlay.clientWidth,
          overlay.clientHeight,
          lastDetectionsRef.current,
          kinematicsRef.current,
          DEFAULT_RENDER_OPTIONS,
          scale,
          offsetX,
          offsetY,
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
  }, [getDisplayOffset, endSet]);

  // ── Camera controls ───────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (!webcamRef.current.isReady) await webcamRef.current.start();
    inferenceInFlightRef.current = false;
    plateInFlightRef.current = false;
    lastDetectionsRef.current = [];
    isRunningRef.current = true;
    setIsTracking(true);
    setSetComplete(false);
    setCompletedReps([]);
    animFrameRef.current = requestAnimationFrame(loop);
  }, [loop]);

  const stopCamera = useCallback(() => {
    isRunningRef.current = false;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
  }, []);

  // ── Upload controls ───────────────────────────────────────────────────────
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (uploadedVideo) URL.revokeObjectURL(uploadedVideo);
    const url = URL.createObjectURL(file);
    setUploadedVideo(url);
    setVideoReady(false);
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    resetAll();
    if (videoRef.current) {
      videoRef.current.src = url;
      videoRef.current.load();
    }
  }, [uploadedVideo, resetAll]);

  // ── New set ───────────────────────────────────────────────────────────────
  const startNewSet = useCallback(() => {
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    resetKinematics();
    lastDetectionsRef.current = [];
    inferenceInFlightRef.current = false;
    plateInFlightRef.current = false;
  }, [resetKinematics]);

  // ── Mode switching ────────────────────────────────────────────────────────
  const switchMode = useCallback((newMode: Mode) => {
    isRunningRef.current = false;
    analysisAbortRef.current = true;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
    webcamRef.current.stop();
    if (videoRef.current) {
      videoRef.current.src = '';
      videoRef.current.srcObject = null;
    }
    resetAll();
    setMode(newMode);
    setVideoReady(false);
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    inferenceInFlightRef.current = false;
    plateInFlightRef.current = false;
    lastDetectionsRef.current = [];
  }, [resetAll]);

  // ── Manual calibration ────────────────────────────────────────────────────
  const applyManualCal = useCallback(() => {
    const val = parseFloat(manualCal);
    if (isNaN(val) || val <= 0) return;
    setCalibration(val);
  }, [manualCal, setCalibration]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      analysisAbortRef.current = true;
      webcamRef.current.stop();
      if (uploadedVideo) URL.revokeObjectURL(uploadedVideo);
    };
  }, []);

  // ── Set summary stats ─────────────────────────────────────────────────────
  const avgSetVelocity = completedReps.length > 0
    ? completedReps.reduce((sum, r) => sum + r.concentricVelocity, 0) / completedReps.length
    : 0;
  const bestRep = completedReps.length > 0
    ? completedReps.reduce((a, b) => a.concentricVelocity > b.concentricVelocity ? a : b)
    : null;
  const velocityLoss = bestRep && completedReps.length > 1
    ? (() => {
        const worst = completedReps.reduce((a, b) =>
          a.concentricVelocity < b.concentricVelocity ? a : b
        );
        return (bestRep.concentricVelocity - worst.concentricVelocity) / bestRep.concentricVelocity * 100;
      })()
    : 0;

  const modelsReady   = detector.status === 'ready' && plateDetector.status === 'ready';
  const modelsLoading = detector.status === 'loading' || plateDetector.status === 'loading';
  const progressPct   = totalFrames > 0
    ? Math.min(100, (analysisProgress / totalFrames) * 100)
    : 0;

  return (
    <div className="flex flex-col items-center gap-4 p-4 bg-slate-950 min-h-screen text-white">
      <h1 className="text-2xl font-bold tracking-tight">🏋️ Barbell Tracker</h1>

      {/* Status */}
      {!setComplete && (
        <div className="flex gap-3 text-sm flex-wrap justify-center">
          <StatusBadge label="Barbell" value={detector.status}       ok={detector.status === 'ready'} />
          <StatusBadge label="Plate"   value={plateDetector.status}  ok={plateDetector.status === 'ready'} />
          <StatusBadge label="Camera"  value={webcam.isReady ? 'ready' : 'off'} ok={webcam.isReady} />
          <StatusBadge label="FPS"     value={fps.toString()}        ok={fps > 5} />
          <div className={`px-3 py-1 rounded-full text-xs font-mono border
            ${kinematics.calibrationLocked
              ? 'border-green-700 text-green-400'
              : 'border-orange-700 text-orange-400'}`}>
            CAL: {kinematics.calibrationLocked
              ? `${kinematics.pixelsPerMetre!.toFixed(0)} px/m 🔒`
              : 'awaiting...'}
          </div>
        </div>
      )}

      {/* ── Set complete summary ───────────────────────────────────────────── */}
      {setComplete && completedReps.length > 0 ? (
        <div className="w-full max-w-xl flex flex-col gap-4">

          <div className="text-center">
            <div className="text-2xl font-bold text-green-400 mb-1">✅ Set Complete</div>
            <div className="text-slate-400 text-sm">
              {completedReps.length} rep{completedReps.length !== 1 ? 's' : ''}
              {kinematics.calibrationLocked && (
                <span className="ml-2 text-slate-500">
                  · CAL {kinematics.pixelsPerMetre!.toFixed(0)} px/m
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-center">
              <div className="text-slate-400 text-xs mb-1">Avg Velocity</div>
              <div className={`font-bold font-mono text-xl
                ${avgSetVelocity > 0.5 ? 'text-green-400'
                : avgSetVelocity > 0.3 ? 'text-yellow-400'
                : 'text-red-400'}`}>
                {avgSetVelocity.toFixed(2)} m/s
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-center">
              <div className="text-slate-400 text-xs mb-1">Best Rep</div>
              <div className="font-bold font-mono text-xl text-green-400">
                {bestRep ? `${bestRep.concentricVelocity.toFixed(2)} m/s` : '--'}
              </div>
              <div className="text-slate-500 text-xs">
                {bestRep ? `Rep #${bestRep.repNumber}` : ''}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-center">
              <div className="text-slate-400 text-xs mb-1">Velocity Loss</div>
              <div className={`font-bold font-mono text-xl
                ${velocityLoss < 10 ? 'text-green-400'
                : velocityLoss < 20 ? 'text-yellow-400'
                : 'text-red-400'}`}>
                {velocityLoss.toFixed(0)}%
              </div>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700">
              <h2 className="text-sm font-semibold text-slate-300">
                Rep Breakdown — Concentric Velocity
              </h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs border-b border-slate-700">
                  <th className="px-4 py-2 text-left">Rep</th>
                  <th className="px-4 py-2 text-right">Avg</th>
                  <th className="px-4 py-2 text-right">Peak</th>
                  <th className="px-4 py-2 text-right">Distance</th>
                  <th className="px-4 py-2 text-right">vs Best</th>
                </tr>
              </thead>
              <tbody>
                {completedReps.map((rep) => {
                  const drop = bestRep
                    ? (bestRep.concentricVelocity - rep.concentricVelocity) / bestRep.concentricVelocity * 100
                    : 0;
                  return (
                    <tr key={rep.repNumber} className="border-b border-slate-800 last:border-0">
                      <td className="px-4 py-2 font-mono text-slate-300">#{rep.repNumber}</td>
                      <td className={`px-4 py-2 font-mono text-right font-bold
                        ${rep.concentricVelocity > 0.5 ? 'text-green-400'
                        : rep.concentricVelocity > 0.3 ? 'text-yellow-400'
                        : 'text-red-400'}`}>
                        {rep.concentricVelocity.toFixed(2)} m/s
                      </td>
                      <td className="px-4 py-2 font-mono text-right text-blue-400">
                        {rep.peakVelocity.toFixed(2)} m/s
                      </td>
                      <td className="px-4 py-2 font-mono text-right text-slate-400">
                        {(rep.concentricDistance * 100).toFixed(0)}cm
                      </td>
                      <td className={`px-4 py-2 font-mono text-right text-xs
                        ${drop < 5 ? 'text-green-400'
                        : drop < 15 ? 'text-yellow-400'
                        : 'text-red-400'}`}>
                        {drop < 1 ? '🏆 best' : `-${drop.toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button
            onClick={startNewSet}
            className="w-full py-3 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-700 transition-colors"
          >
            🔄 Start New Set
          </button>
        </div>

      ) : (
        <>
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

          {/* Manual calibration */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-400 text-xs">Manual cal (px/m):</span>
            <input
              type="number"
              value={manualCal}
              onChange={(e) => setManualCal(e.target.value)}
              placeholder="e.g. 400"
              className="w-24 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs font-mono"
            />
            <button
              onClick={applyManualCal}
              className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs"
            >
              Apply
            </button>
            {kinematics.calibrationLocked && (
              <button
                onClick={resetAll}
                className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs text-orange-400"
              >
                🔓 Unlock
              </button>
            )}
          </div>

          {/* Video */}
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

            {/* Analysis progress overlay */}
            {analysisState === 'analysing' && (
              <div className="absolute inset-0 flex flex-col items-center justify-end pb-4 bg-black/30">
                <div className="w-4/5 bg-slate-700 rounded-full h-2 mb-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="text-white text-xs font-mono">
                  Frame {analysisProgress} / ~{totalFrames} ({progressPct.toFixed(0)}%)
                </div>
              </div>
            )}

            {!webcam.isReady && !uploadedVideo && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                {mode === 'camera' ? 'Camera not started' : 'No video uploaded'}
              </div>
            )}
          </div>

          {/* Camera controls */}
          {mode === 'camera' && (
            <div className="flex gap-3 flex-wrap justify-center">
              <button
                onClick={isTracking ? stopCamera : startCamera}
                disabled={!modelsReady}
                className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-colors
                  ${isTracking
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed'
                  }`}
              >
                {modelsLoading
                  ? 'Loading models...'
                  : isTracking ? '⏹ Stop' : '▶ Start Tracking'}
              </button>

              {isTracking && (
                <button
                  onClick={endSet}
                  className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-700 transition-colors"
                >
                  🏁 End Set
                </button>
              )}

              <button
                onClick={resetKinematics}
                className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600"
              >
                🔄 Reset Set
              </button>
            </div>
          )}

          {/* Upload controls */}
          {mode === 'upload' && (
            <div className="flex flex-col items-center gap-3 w-full max-w-xl">
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

              {uploadedVideo && (
                <div className="flex gap-3">
                  {analysisState === 'analysing' ? (
                    <button
                      onClick={stopAnalysis}
                      className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-red-600 hover:bg-red-700 transition-colors"
                    >
                      ⏹ Stop Analysis
                    </button>
                  ) : (
                    <button
                      onClick={analyseVideoFrameByFrame}
                      disabled={!videoReady || !modelsReady}
                      className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed transition-colors"
                    >
                      {!videoReady
                        ? 'Loading video...'
                        : modelsLoading
                        ? 'Loading models...'
                        : '▶ Analyse Video'}
                    </button>
                  )}
                  <button
                    onClick={() => { resetAll(); setAnalysisState('idle'); setAnalysisProgress(0); }}
                    disabled={analysisState === 'analysing'}
                    className="px-6 py-2.5 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    🔄 Reset
                  </button>
                </div>
              )}

              {uploadedVideo && analysisState === 'idle' && (
                <p className="text-xs text-slate-500 text-center">
                  Frame-by-frame analysis — deterministic results every run
                </p>
              )}
            </div>
          )}

          {/* Live stats */}
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

          {/* Live rep history */}
          {kinematics.repHistory.length > 0 && (
            <div className="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-700">
                <h2 className="text-sm font-semibold text-slate-300">Rep History</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 text-xs border-b border-slate-700">
                    <th className="px-4 py-2 text-left">Rep</th>
                    <th className="px-4 py-2 text-right">Con. Avg</th>
                    <th className="px-4 py-2 text-right">Peak</th>
                    <th className="px-4 py-2 text-right">Ecc. Avg</th>
                    <th className="px-4 py-2 text-right">Distance</th>
                  </tr>
                </thead>
                <tbody>
                  {kinematics.repHistory.map((rep) => (
                    <tr key={rep.repNumber} className="border-b border-slate-800 last:border-0">
                      <td className="px-4 py-2 font-mono text-slate-300">#{rep.repNumber}</td>
                      <td className={`px-4 py-2 font-mono text-right font-bold
                        ${rep.concentricVelocity > 0.5 ? 'text-green-400'
                        : rep.concentricVelocity > 0.3 ? 'text-yellow-400'
                        : 'text-red-400'}`}>
                        {rep.concentricVelocity.toFixed(2)} m/s
                      </td>
                      <td className="px-4 py-2 font-mono text-right text-blue-400">
                        {rep.peakVelocity.toFixed(2)} m/s
                      </td>
                      <td className="px-4 py-2 font-mono text-right text-slate-400">
                        {rep.eccentricVelocity > 0
                          ? `${rep.eccentricVelocity.toFixed(2)} m/s`
                          : '--'}
                      </td>
                      <td className="px-4 py-2 font-mono text-right text-slate-400">
                        {(rep.concentricDistance * 100).toFixed(0)}cm
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Errors */}
      {(webcam.error || detector.error || plateDetector.error) && (
        <div className="text-red-400 text-sm bg-red-950 px-4 py-2 rounded-lg">
          {webcam.error || detector.error || plateDetector.error}
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
'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useWebcam } from '@/hooks/useWebcam';
import { useTracker } from '@/hooks/useTracker';
import { useDetectorWorker } from '@/hooks/useDetectorWorker';
import { useKinematics } from '@/hooks/useKinematics';
import { renderFrame, DEFAULT_RENDER_OPTIONS } from '@/lib/renderer';
import { PLATE_CONFIG } from '@/lib/detector';
import type { RepStats } from '@/lib/kinematics';

type Mode = 'camera' | 'upload';
type AnalysisState = 'idle' | 'analysing' | 'complete';

export default function BarbellTracker() {
  const videoRef           = useRef<HTMLVideoElement>(null);
  const overlayCanvasRef   = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const animFrameRef     = useRef<number>(0);
  const isRunningRef     = useRef(false);
  const plateInFlightRef = useRef(false);
  const trackInFlightRef = useRef(false);
  const lastPointRef     = useRef<{ x: number; y: number; tracked: boolean } | null>(null);
  const analysisAbortRef = useRef(false);

  const webcam        = useWebcam(videoRef);
  const tracker       = useTracker();
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

  const [mode, setMode]                         = useState<Mode>('camera');
  const [isTracking, setIsTracking]             = useState(false);
  const [fps, setFps]                           = useState(0);
  const [uploadedVideo, setUploadedVideo]       = useState<string | null>(null);
  const [videoReady, setVideoReady]             = useState(false);
  const [setComplete, setSetComplete]           = useState(false);
  const [completedReps, setCompletedReps]       = useState<RepStats[]>([]);
  const [manualCal, setManualCal]               = useState<string>('');
  const [analysisState, setAnalysisState]       = useState<AnalysisState>('idle');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [totalFrames, setTotalFrames]           = useState(0);
  const [isSeeded, setIsSeeded]                 = useState(false);
  const [showTips, setShowTips]                 = useState(false);
  const [showCalInput, setShowCalInput]         = useState(false);

  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // Stable refs
  const kinematicsRef          = useRef(kinematics);
  useEffect(() => { kinematicsRef.current = kinematics; }, [kinematics]);
  const webcamRef              = useRef(webcam);
  useEffect(() => { webcamRef.current = webcam; }, [webcam]);
  const trackerRef             = useRef(tracker);
  useEffect(() => { trackerRef.current = tracker; }, [tracker]);
  const plateDetectorRef       = useRef(plateDetector);
  useEffect(() => { plateDetectorRef.current = plateDetector; }, [plateDetector]);
  const updateKinematicsRef    = useRef(updateKinematics);
  useEffect(() => { updateKinematicsRef.current = updateKinematics; }, [updateKinematics]);
  const updateWithTimestampRef = useRef(updateWithTimestamp);
  useEffect(() => { updateWithTimestampRef.current = updateWithTimestamp; }, [updateWithTimestamp]);
  const updateCalibrationRef   = useRef(updateCalibration);
  useEffect(() => { updateCalibrationRef.current = updateCalibration; }, [updateCalibration]);

  useEffect(() => {
    offscreenCanvasRef.current = document.createElement('canvas');
  }, []);

  // ── End set ───────────────────────────────────────────────────────────────
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
    const video   = videoRef.current;
    const overlay = overlayCanvasRef.current;
    if (!video || !overlay) return { scale: 1, offsetX: 0, offsetY: 0 };
    const displayW = overlay.clientWidth;
    const displayH = overlay.clientHeight;
    const videoW   = video.videoWidth;
    const videoH   = video.videoHeight;
    if (!videoW || !videoH) return { scale: 1, offsetX: 0, offsetY: 0 };
    const scale   = Math.min(displayW / videoW, displayH / videoH);
    const offsetX = (displayW - videoW * scale) / 2;
    const offsetY = (displayH - videoH * scale) / 2;
    return { scale, offsetX, offsetY };
  }, []);

  // ── Capture frame ─────────────────────────────────────────────────────────
  const captureFrame = useCallback((): ImageData | null => {
    const video     = videoRef.current;
    const offscreen = offscreenCanvasRef.current;
    if (!video || !offscreen) return null;
    offscreen.width  = video.videoWidth;
    offscreen.height = video.videoHeight;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return ctx.getImageData(0, 0, offscreen.width, offscreen.height);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const { scale, offsetX, offsetY } = getDisplayOffset();
    renderFrame(
      overlay,
      overlay.clientWidth,
      overlay.clientHeight,
      lastPointRef.current,
      kinematicsRef.current,
      DEFAULT_RENDER_OPTIONS,
      scale,
      offsetX,
      offsetY,
    );
  }, [getDisplayOffset]);

  // ── Handle tap ────────────────────────────────────────────────────────────
  const handleTap = useCallback(async (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>
  ) => {
    const overlay = overlayCanvasRef.current;
    const video   = videoRef.current;
    if (!overlay || !video) return;
    if (mode === 'camera' && !isTracking) return;
    if (mode === 'upload' && !videoReady) return;
    if (analysisState === 'analysing') return;

    const tStatus = trackerRef.current.status;
    if (tStatus === 'idle' || tStatus === 'loading' || tStatus === 'error') return;

    const rect    = overlay.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const tapX    = clientX - rect.left;
    const tapY    = clientY - rect.top;

    const { scale, offsetX, offsetY } = getDisplayOffset();
    const videoX = (tapX - offsetX) / scale;
    const videoY = (tapY - offsetY) / scale;

    const clampedX = Math.max(0, Math.min(video.videoWidth,  videoX));
    const clampedY = Math.max(0, Math.min(video.videoHeight, videoY));

    const imageData = captureFrame();
    if (!imageData) return;

    await trackerRef.current.seed(imageData, clampedX, clampedY);
    lastPointRef.current = { x: clampedX, y: clampedY, tracked: true };
    setIsSeeded(true);
  }, [mode, isTracking, videoReady, analysisState, getDisplayOffset, captureFrame]);

  // ── Camera loop ───────────────────────────────────────────────────────────
  const loop = useCallback(() => {
    if (!isRunningRef.current) return;
    const video   = videoRef.current;
    const overlay = overlayCanvasRef.current;
    if (video && video.ended) { endSet(); return; }
    if (video && overlay && !video.paused) {
      const imageData = captureFrame();
      if (imageData) {
        if (!trackInFlightRef.current && trackerRef.current.status === 'seeded') {
          trackInFlightRef.current = true;
          trackerRef.current.track(imageData, performance.now()).then((result) => {
            lastPointRef.current = result;
            if (result.tracked) {
              updateKinematicsRef.current([{
                x: result.x - 5, y: result.y - 5,
                width: 10, height: 10,
                centerX: result.x, centerY: result.y,
                score: 1.0, label: 0,
              }]);
            }
            trackInFlightRef.current = false;
          });
        }
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
        render();
        fpsRef.current.frames++;
        const now = performance.now();
        if (now - fpsRef.current.last > 1000) {
          setFps(fpsRef.current.frames);
          fpsRef.current = { frames: 0, last: now };
        }
      }
    }
    animFrameRef.current = requestAnimationFrame(loop);
  }, [captureFrame, render, endSet]);

  // ── Camera controls ───────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (!webcamRef.current.isReady) await webcamRef.current.start();
    lastPointRef.current = null;
    isRunningRef.current = true;
    setIsTracking(true);
    setIsSeeded(false);
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
    setIsSeeded(false);
    lastPointRef.current = null;
    resetAll();
    trackerRef.current.reset();
    if (videoRef.current) {
      videoRef.current.playbackRate = 1.0;
      videoRef.current.src = url;
      videoRef.current.load();
    }
  }, [uploadedVideo, resetAll]);

  // ── Seek-based 30fps analysis ─────────────────────────────────────────────
  const analyseVideoFrameByFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !isSeeded) return;

    resetAll();
    analysisAbortRef.current = false;
    setAnalysisState('analysing');
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisProgress(0);

    const SAMPLE_FPS = 30;
    const frameTime  = 1 / SAMPLE_FPS;
    const duration   = video.duration;
    const estimated  = Math.floor(duration * SAMPLE_FPS);
    setTotalFrames(estimated);

    video.pause();
    video.currentTime = 0;
    await new Promise<void>(resolve => {
      const h = () => { video.removeEventListener('seeked', h); resolve(); };
      video.addEventListener('seeked', h);
    });

    const firstFrame = captureFrame();
    if (firstFrame && lastPointRef.current) {
      await trackerRef.current.seed(
        firstFrame,
        lastPointRef.current.x,
        lastPointRef.current.y
      );
    }

    let frameIndex           = 0;
    let calibrationAttempted = kinematicsRef.current.calibrationLocked;

    while (!analysisAbortRef.current) {
      const targetTime = frameIndex * frameTime;
      if (targetTime >= duration) break;

      if (frameIndex > 0) {
        video.currentTime = targetTime;
        await new Promise<void>(resolve => {
          const h = () => { video.removeEventListener('seeked', h); resolve(); };
          video.addEventListener('seeked', h);
          setTimeout(resolve, 500);
        });
      }

      const imageData = captureFrame();
      if (imageData) {
        if (!calibrationAttempted && !kinematicsRef.current.calibrationLocked) {
          const plateResult = await plateDetectorRef.current.detect(imageData);
          if (plateResult.length > 0) {
            updateCalibrationRef.current(plateResult);
            calibrationAttempted = true;
          }
          if (targetTime > 3) calibrationAttempted = true;
        }

        const result = await trackerRef.current.track(imageData, targetTime * 1000);
        lastPointRef.current = result;

        if (result.tracked) {
          updateWithTimestampRef.current([{
            x: result.x - 5, y: result.y - 5,
            width: 10, height: 10,
            centerX: result.x, centerY: result.y,
            score: 1.0, label: 0,
          }], targetTime * 1000);
          render();
        }
      }

      frameIndex++;
      setAnalysisProgress(frameIndex);
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
  }, [isSeeded, captureFrame, render, resetAll]);

  const stopAnalysis = useCallback(() => {
    analysisAbortRef.current = true;
    if (videoRef.current) videoRef.current.pause();
    setAnalysisState('idle');
  }, []);

  // ── New set ───────────────────────────────────────────────────────────────
  const startNewSet = useCallback(() => {
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    setIsSeeded(false);
    lastPointRef.current = null;
    resetKinematics();
    trackerRef.current.reset();
  }, [resetKinematics]);

  // ── Mode switching ────────────────────────────────────────────────────────
  const switchMode = useCallback((newMode: Mode) => {
    isRunningRef.current = false;
    analysisAbortRef.current = true;
    cancelAnimationFrame(animFrameRef.current);
    setIsTracking(false);
    webcamRef.current.stop();
    if (videoRef.current) {
      videoRef.current.playbackRate = 1.0;
      videoRef.current.src = '';
      videoRef.current.srcObject = null;
    }
    resetAll();
    trackerRef.current.reset();
    setMode(newMode);
    setVideoReady(false);
    setSetComplete(false);
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    setIsSeeded(false);
    lastPointRef.current = null;
    plateInFlightRef.current = false;
    trackInFlightRef.current = false;
  }, [resetAll]);

  // ── Manual calibration ────────────────────────────────────────────────────
  const applyManualCal = useCallback(() => {
    const val = parseFloat(manualCal);
    if (isNaN(val) || val <= 0) return;
    setCalibration(val);
    setShowCalInput(false);
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

  // ── Summary stats ─────────────────────────────────────────────────────────
  const avgSetVelocity = completedReps.length > 0
    ? completedReps.reduce((s, r) => s + r.concentricVelocity, 0) / completedReps.length
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

  const trackerReady  = tracker.status === 'ready' || tracker.status === 'seeded' || tracker.status === 'lost';
  const plateReady    = plateDetector.status === 'ready';
  const modelsLoading = !trackerReady || !plateReady;
  const progressPct   = totalFrames > 0 ? Math.min(100, (analysisProgress / totalFrames) * 100) : 0;

  const tapHintText = () => {
    if (tracker.status === 'lost')
      return { text: '⚠️ Tracking lost — tap on the bar to re-seed', colour: 'text-orange-400 bg-orange-950' };
    if (isSeeded)
      return { text: mode === 'upload' ? '✅ Point set — click Analyse Video' : '✅ Tracking active', colour: 'text-green-400 bg-slate-800' };
    if (mode === 'camera' && isTracking)
      return { text: '👆 Tap the end of the bar to start tracking', colour: 'text-slate-300 bg-slate-800' };
    if (mode === 'upload' && videoReady && analysisState === 'idle')
      return { text: '👆 Tap the end of the bar, then click Analyse Video', colour: 'text-slate-300 bg-slate-800' };
    return null;
  };
  const hint = tapHintText();

  // ── Set complete ──────────────────────────────────────────────────────────
  if (setComplete && completedReps.length > 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-4 bg-slate-950 min-h-screen text-white">
        <h1 className="text-xl font-bold tracking-tight">🏋️ Barbell Tracker</h1>

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

        <div className="grid grid-cols-3 gap-3 w-full max-w-xl">
          <SummaryCard
            label="Avg Velocity"
            value={`${avgSetVelocity.toFixed(2)} m/s`}
            colour={avgSetVelocity > 0.5 ? 'text-green-400' : avgSetVelocity > 0.3 ? 'text-yellow-400' : 'text-red-400'}
          />
          <SummaryCard
            label="Best Rep"
            value={bestRep ? `${bestRep.concentricVelocity.toFixed(2)} m/s` : '--'}
            sub={bestRep ? `Rep #${bestRep.repNumber}` : ''}
            colour="text-green-400"
          />
          <SummaryCard
            label="Vel. Loss"
            value={`${velocityLoss.toFixed(0)}%`}
            colour={velocityLoss < 10 ? 'text-green-400' : velocityLoss < 20 ? 'text-yellow-400' : 'text-red-400'}
          />
        </div>

        <div className="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700">
            <h2 className="text-sm font-semibold text-slate-300">Rep Breakdown</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 text-xs border-b border-slate-700">
                <th className="px-3 py-2 text-left">Rep</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="px-3 py-2 text-right">Peak</th>
                <th className="px-3 py-2 text-right">Dist</th>
                <th className="px-3 py-2 text-right">vs Best</th>
              </tr>
            </thead>
            <tbody>
              {completedReps.map((rep) => {
                const drop = bestRep
                  ? (bestRep.concentricVelocity - rep.concentricVelocity) / bestRep.concentricVelocity * 100
                  : 0;
                return (
                  <tr key={rep.repNumber} className="border-b border-slate-800 last:border-0">
                    <td className="px-3 py-2 font-mono text-slate-300">#{rep.repNumber}</td>
                    <td className={`px-3 py-2 font-mono text-right font-bold
                      ${rep.concentricVelocity > 0.5 ? 'text-green-400'
                      : rep.concentricVelocity > 0.3 ? 'text-yellow-400'
                      : 'text-red-400'}`}>
                      {rep.concentricVelocity.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 font-mono text-right text-blue-400">
                      {rep.peakVelocity.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 font-mono text-right text-slate-400">
                      {(rep.concentricDistance * 100).toFixed(0)}cm
                    </td>
                    <td className={`px-3 py-2 font-mono text-right text-xs
                      ${drop < 5 ? 'text-green-400' : drop < 15 ? 'text-yellow-400' : 'text-red-400'}`}>
                      {drop < 1 ? '🏆' : `-${drop.toFixed(0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <button
          onClick={startNewSet}
          className="w-full max-w-xl py-3 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-700 transition-colors"
        >
          🔄 Start New Set
        </button>
      </div>
    );
  }

  // ── Main tracking UI ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col bg-slate-950 min-h-screen text-white">

      {/* ── Top bar ── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <h1 className="text-base font-bold">🏋️ Barbell Tracker</h1>

        {/* Status dots — compact */}
        <div className="flex items-center gap-2 text-xs">
          <StatusDot ok={trackerReady}  label={`T:${tracker.status.slice(0,4)}`} />
          <StatusDot ok={plateReady}    label={`P:${plateDetector.status.slice(0,4)}`} />
          <StatusDot ok={fps > 5}       label={`${fps}fps`} />
          <StatusDot
            ok={!!kinematics.calibrationLocked}
            label={kinematics.calibrationLocked ? `${kinematics.pixelsPerMetre!.toFixed(0)}px/m` : 'NO CAL'}
          />
        </div>
      </div>

      {/* ── Mode toggle ── */}
      <div className="flex bg-slate-900 border-b border-slate-800">
        <button
          onClick={() => switchMode('camera')}
          className={`flex-1 py-2.5 text-sm font-semibold transition-colors
            ${mode === 'camera' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
        >
          📷 Live Camera
        </button>
        <button
          onClick={() => switchMode('upload')}
          className={`flex-1 py-2.5 text-sm font-semibold transition-colors
            ${mode === 'upload' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
        >
          📁 Upload Video
        </button>
      </div>

      {/* ── VIDEO — takes up as much space as possible ── */}
      <div
        className="relative bg-black w-full cursor-crosshair"
        style={{ minHeight: '50vh', maxHeight: '65vh' }}
        onClick={handleTap}
        onTouchStart={handleTap}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          style={{ minHeight: '50vh', maxHeight: '65vh' }}
          playsInline
          muted
          onLoadedData={() => {
            setVideoReady(true);
            if (videoRef.current) videoRef.current.playbackRate = 1.0;
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
        />

        {/* Progress bar */}
        {analysisState === 'analysing' && (
          <div className="absolute inset-x-0 bottom-0 pb-2 px-4 bg-gradient-to-t from-black/70 to-transparent">
            <div className="w-full bg-slate-700 rounded-full h-1.5 mb-1">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="text-white text-xs font-mono text-center">
              {progressPct.toFixed(0)}% · {analysisProgress}/{totalFrames} frames
            </div>
          </div>
        )}

        {!webcam.isReady && !uploadedVideo && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
            {mode === 'camera' ? 'Tap Start Camera below' : 'Upload a video below'}
          </div>
        )}
      </div>

      {/* ── Tap hint ── */}
      {hint && (
        <div className={`px-4 py-2 text-xs text-center ${hint.colour}`}>
          {hint.text}
        </div>
      )}

      {/* ── Controls ── */}
      <div className="flex flex-col gap-2 px-3 py-3">

        {/* Camera controls */}
        {mode === 'camera' && (
          <div className="flex gap-2">
            <button
              onClick={isTracking ? stopCamera : startCamera}
              disabled={modelsLoading}
              className={`flex-1 py-3 rounded-lg font-semibold text-sm transition-colors
                ${isTracking
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed'
                }`}
            >
              {modelsLoading ? 'Loading...' : isTracking ? '⏹ Stop' : '▶ Start Camera'}
            </button>

            {isTracking && isSeeded && (
              <button
                onClick={endSet}
                className="flex-1 py-3 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-700"
              >
                🏁 End Set
              </button>
            )}

            <button
              onClick={resetKinematics}
              className="px-4 py-3 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600"
            >
              🔄
            </button>
          </div>
        )}

        {/* Upload controls */}
        {mode === 'upload' && (
          <>
            {/* File picker */}
            <label className="cursor-pointer">
              <div className="border border-dashed border-slate-600 hover:border-blue-500
                rounded-lg py-3 text-center transition-colors">
                <span className="text-sm text-slate-300">
                  {uploadedVideo ? '📹 Change video' : '📹 Upload video'}
                </span>
              </div>
              <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
            </label>

            {/* Analyse / stop / reset */}
            {uploadedVideo && (
              <div className="flex gap-2">
                {analysisState === 'analysing' ? (
                  <button
                    onClick={stopAnalysis}
                    className="flex-1 py-3 rounded-lg font-semibold text-sm bg-red-600 hover:bg-red-700"
                  >
                    ⏹ Stop
                  </button>
                ) : (
                  <button
                    onClick={analyseVideoFrameByFrame}
                    disabled={!videoReady || modelsLoading || !isSeeded}
                    className="flex-1 py-3 rounded-lg font-semibold text-sm bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed"
                  >
                    {!videoReady ? 'Loading...' : modelsLoading ? 'Loading...' : !isSeeded ? 'Tap bar first' : '▶ Analyse'}
                  </button>
                )}
                <button
                  onClick={() => {
                    resetAll();
                    trackerRef.current.reset();
                    setAnalysisState('idle');
                    setAnalysisProgress(0);
                    setIsSeeded(false);
                    lastPointRef.current = null;
                  }}
                  disabled={analysisState === 'analysing'}
                  className="px-4 py-3 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-50"
                >
                  🔄
                </button>
              </div>
            )}
          </>
        )}

        {/* Live stats — compact row */}
        <div className="grid grid-cols-4 gap-2">
          <MiniStat
            label="Velocity"
            value={kinematics.pixelsPerMetre ? `${kinematics.velocity.toFixed(2)}` : '--'}
            unit="m/s"
            highlight={kinematics.velocity > 0.5}
          />
          <MiniStat
            label="Peak"
            value={kinematics.pixelsPerMetre ? `${kinematics.peakVelocity.toFixed(2)}` : '--'}
            unit="m/s"
          />
          <MiniStat label="Reps" value={kinematics.repCount.toString()} large />
          <MiniStat label="Phase" value={kinematics.phase.slice(0, 3).toUpperCase()} />
        </div>

        {/* Settings row — cal + tips */}
        <div className="flex gap-2">
          <button
            onClick={() => setShowCalInput(v => !v)}
            className="flex-1 py-2 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            ⚙️ {kinematics.calibrationLocked ? `CAL: ${kinematics.pixelsPerMetre!.toFixed(0)} px/m 🔒` : 'Manual Calibration'}
          </button>
          <button
            onClick={() => setShowTips(v => !v)}
            className="px-4 py-2 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            💡 Tips
          </button>
        </div>

        {/* Calibration input — collapsible */}
        {showCalInput && (
          <div className="flex gap-2 items-center bg-slate-800 rounded-lg px-3 py-2">
            <span className="text-xs text-slate-400 shrink-0">px/m:</span>
            <input
              type="number"
              value={manualCal}
              onChange={(e) => setManualCal(e.target.value)}
              placeholder="e.g. 400"
              className="flex-1 bg-transparent text-white text-sm font-mono outline-none"
            />
            <button
              onClick={applyManualCal}
              className="px-3 py-1 rounded bg-blue-600 text-xs font-semibold"
            >
              Apply
            </button>
            {kinematics.calibrationLocked && (
              <button
                onClick={() => { resetAll(); setShowCalInput(false); }}
                className="px-3 py-1 rounded bg-slate-600 text-xs text-orange-400"
              >
                🔓
              </button>
            )}
          </div>
        )}

        {/* Tips — collapsible */}
        {showTips && (
          <div className="bg-slate-800 rounded-lg p-3 text-xs text-slate-300 space-y-2">
            <p className="font-semibold text-white">📹 How to film:</p>
            <ul className="space-y-1 list-none">
              <li>✅ Camera side-on, perpendicular to bar path</li>
              <li>✅ Bar end fully visible throughout the lift</li>
              <li>✅ Camera stable — don't move it during the set</li>
              <li>✅ Weight plate visible for auto-calibration</li>
              <li>⚠️ Do not walk between the camera and bar</li>
              <li>⚠️ If someone crosses the bar path, trim the video first</li>
            </ul>
            <p className="font-semibold text-white mt-2">🎯 Tracking tips:</p>
            <ul className="space-y-1 list-none">
              <li>👆 Tap precisely on the end of the bar sleeve</li>
              <li>🔄 Re-tap if tracking is lost</li>
              <li>💡 Good lighting improves plate calibration</li>
            </ul>
          </div>
        )}
      </div>

      {/* Live rep history */}
      {kinematics.repHistory.length > 0 && (
        <div className="mx-3 mb-3 bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-700">
            <h2 className="text-xs font-semibold text-slate-300">Rep History</h2>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="px-3 py-1.5 text-left">Rep</th>
                <th className="px-3 py-1.5 text-right">Avg</th>
                <th className="px-3 py-1.5 text-right">Peak</th>
                <th className="px-3 py-1.5 text-right">Ecc</th>
                <th className="px-3 py-1.5 text-right">Dist</th>
              </tr>
            </thead>
            <tbody>
              {kinematics.repHistory.map((rep) => (
                <tr key={rep.repNumber} className="border-b border-slate-800 last:border-0">
                  <td className="px-3 py-1.5 font-mono text-slate-300">#{rep.repNumber}</td>
                  <td className={`px-3 py-1.5 font-mono text-right font-bold
                    ${rep.concentricVelocity > 0.5 ? 'text-green-400'
                    : rep.concentricVelocity > 0.3 ? 'text-yellow-400'
                    : 'text-red-400'}`}>
                    {rep.concentricVelocity.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-right text-blue-400">
                    {rep.peakVelocity.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-right text-slate-400">
                    {rep.eccentricVelocity > 0 ? rep.eccentricVelocity.toFixed(2) : '--'}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-right text-slate-400">
                    {(rep.concentricDistance * 100).toFixed(0)}cm
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(webcam.error || plateDetector.error) && (
        <div className="mx-3 mb-3 text-red-400 text-xs bg-red-950 px-3 py-2 rounded-lg">
          {webcam.error || plateDetector.error}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-1 text-xs font-mono
      ${ok ? 'text-green-400' : 'text-slate-500'}`}>
      <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-400' : 'bg-slate-600'}`} />
      {label}
    </div>
  );
}

function MiniStat({
  label, value, unit, highlight, large
}: {
  label: string; value: string; unit?: string; highlight?: boolean; large?: boolean;
}) {
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-2 text-center">
      <div className="text-slate-500 text-xs leading-none mb-1">{label}</div>
      <div className={`font-bold font-mono leading-none ${large ? 'text-2xl' : 'text-base'}
        ${highlight ? 'text-green-400' : 'text-white'}`}>
        {value}
      </div>
      {unit && <div className="text-slate-500 text-xs leading-none mt-0.5">{unit}</div>}
    </div>
  );
}

function SummaryCard({
  label, value, sub, colour
}: {
  label: string; value: string; sub?: string; colour: string;
}) {
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-center">
      <div className="text-slate-400 text-xs mb-1">{label}</div>
      <div className={`font-bold font-mono text-lg ${colour}`}>{value}</div>
      {sub && <div className="text-slate-500 text-xs mt-0.5">{sub}</div>}
    </div>
  );
}
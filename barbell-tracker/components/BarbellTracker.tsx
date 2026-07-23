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
type PostAnalysisView = 'choice' | 'playback' | 'results';

const isMobile = typeof navigator !== 'undefined' &&
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

function getSampleFps(duration: number): number {
  if (duration > 90) return isMobile ? 10 : 20;
  if (duration > 45) return isMobile ? 12 : 24;
  return isMobile ? 15 : 30;
}

const SEEK_TIMEOUT_MS = isMobile ? 150 : 80;
const TRACKING_WIDTH  = isMobile ? 320 : 480;

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

  // Stores full tracked path for playback
  const trackedPathRef = useRef<Array<{ x: number; y: number; timestamp: number }>>([]);

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

  const [mode, setMode]                           = useState<Mode>('camera');
  const [isTracking, setIsTracking]               = useState(false);
  const [fps, setFps]                             = useState(0);
  const [uploadedVideo, setUploadedVideo]         = useState<string | null>(null);
  const [videoReady, setVideoReady]               = useState(false);
  const [completedReps, setCompletedReps]         = useState<RepStats[]>([]);
  const [manualCal, setManualCal]                 = useState<string>('');
  const [analysisState, setAnalysisState]         = useState<AnalysisState>('idle');
  const [analysisProgress, setAnalysisProgress]   = useState(0);
  const [totalFrames, setTotalFrames]             = useState(0);
  const [isSeeded, setIsSeeded]                   = useState(false);
  const [showTips, setShowTips]                   = useState(false);
  const [showCalInput, setShowCalInput]           = useState(false);
  const [currentSampleFps, setCurrentSampleFps]   = useState(0);
  const [postAnalysisView, setPostAnalysisView]   = useState<PostAnalysisView>('choice');
  const [isPlayingBack, setIsPlayingBack]         = useState(false);

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

  // ── Capture full-res frame ────────────────────────────────────────────────
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

  // ── Capture scaled frame for optical flow ─────────────────────────────────
  const captureScaledFrame = useCallback((): {
    imageData: ImageData;
    scaleX: number;
    scaleY: number;
  } | null => {
    const video     = videoRef.current;
    const offscreen = offscreenCanvasRef.current;
    if (!video || !offscreen) return null;
    const scale  = Math.min(1, TRACKING_WIDTH / video.videoWidth);
    const width  = Math.round(video.videoWidth  * scale);
    const height = Math.round(video.videoHeight * scale);
    offscreen.width  = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return {
      imageData: ctx.getImageData(0, 0, width, height),
      scaleX: video.videoWidth  / width,
      scaleY: video.videoHeight / height,
    };
  }, []);

  // ── Render overlay ────────────────────────────────────────────────────────
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
    if (postAnalysisView === 'playback') return;

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

    const scaled = captureScaledFrame();
    if (!scaled) return;

    await trackerRef.current.seed(
      scaled.imageData,
      clampedX / scaled.scaleX,
      clampedY / scaled.scaleY
    );
    lastPointRef.current = { x: clampedX, y: clampedY, tracked: true };
    setIsSeeded(true);
  }, [mode, isTracking, videoReady, analysisState, postAnalysisView, getDisplayOffset, captureScaledFrame]);

  // ── Camera loop ───────────────────────────────────────────────────────────
  const loop = useCallback(() => {
    if (!isRunningRef.current) return;
    const video   = videoRef.current;
    const overlay = overlayCanvasRef.current;
    if (video && video.ended) { endSet(); return; }

    if (video && overlay && !video.paused) {
      const scaled = captureScaledFrame();
      if (scaled) {
        if (!trackInFlightRef.current && trackerRef.current.status === 'seeded') {
          trackInFlightRef.current = true;
          trackerRef.current.track(scaled.imageData, performance.now()).then((result) => {
            if (result.tracked) {
              const fullX = result.x * scaled.scaleX;
              const fullY = result.y * scaled.scaleY;
              lastPointRef.current = { x: fullX, y: fullY, tracked: true };
              updateKinematicsRef.current([{
                x: fullX - 5, y: fullY - 5,
                width: 10, height: 10,
                centerX: fullX, centerY: fullY,
                score: 1.0, label: 0,
              }]);
            } else {
              lastPointRef.current = { x: 0, y: 0, tracked: false };
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
          const fullFrame = captureFrame();
          if (fullFrame) {
            plateDetectorRef.current.detect(fullFrame).then((result) => {
              if (result.length > 0) updateCalibrationRef.current(result);
              plateInFlightRef.current = false;
            });
          } else {
            plateInFlightRef.current = false;
          }
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
  }, [captureScaledFrame, captureFrame, render, endSet]);

  // ── Camera controls ───────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (!webcamRef.current.isReady) await webcamRef.current.start();
    lastPointRef.current = null;
    isRunningRef.current = true;
    setIsTracking(true);
    setIsSeeded(false);
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
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    setIsSeeded(false);
    setPostAnalysisView('choice');
    setIsPlayingBack(false);
    lastPointRef.current = null;
    trackedPathRef.current = [];
    resetAll();
    trackerRef.current.reset();
    if (videoRef.current) {
      videoRef.current.playbackRate = 1.0;
      videoRef.current.src = url;
      videoRef.current.load();
    }
  }, [uploadedVideo, resetAll]);

  // ── Seek helper ───────────────────────────────────────────────────────────
  const seekTo = useCallback((video: HTMLVideoElement, time: number): Promise<void> => {
    return new Promise<void>(resolve => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
      setTimeout(resolve, SEEK_TIMEOUT_MS);
    });
  }, []);

  // ── Seek-based deterministic analysis ─────────────────────────────────────
  const analyseVideoFrameByFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !isSeeded) return;

    resetAll();
    trackedPathRef.current = [];
    analysisAbortRef.current = false;
    setAnalysisState('analysing');
    setCompletedReps([]);
    setAnalysisProgress(0);
    setPostAnalysisView('choice');

    const SAMPLE_FPS = getSampleFps(video.duration);
    setCurrentSampleFps(SAMPLE_FPS);
    const frameTime = 1 / SAMPLE_FPS;
    const duration  = video.duration;
    const estimated = Math.floor(duration * SAMPLE_FPS);
    setTotalFrames(estimated);

    video.pause();
    await seekTo(video, 0);

    const firstScaled = captureScaledFrame();
    if (firstScaled && lastPointRef.current) {
      await trackerRef.current.seed(
        firstScaled.imageData,
        lastPointRef.current.x / firstScaled.scaleX,
        lastPointRef.current.y / firstScaled.scaleY
      );
    }

    let frameIndex           = 0;
    let calibrationAttempted = kinematicsRef.current.calibrationLocked;

    while (!analysisAbortRef.current) {
      const targetTime = frameIndex * frameTime;
      if (targetTime >= duration) break;

      if (frameIndex > 0) {
        await seekTo(video, targetTime);
      }

      const scaled = captureScaledFrame();
      if (scaled) {
        // Plate calibration — first 3s only
        if (!calibrationAttempted && !kinematicsRef.current.calibrationLocked) {
          const fullFrame = captureFrame();
          if (fullFrame) {
            const plateResult = await plateDetectorRef.current.detect(fullFrame);
            if (plateResult.length > 0) {
              updateCalibrationRef.current(plateResult);
              calibrationAttempted = true;
            }
          }
          if (targetTime > 3) calibrationAttempted = true;
        }

        // Track
        const result = await trackerRef.current.track(scaled.imageData, targetTime * 1000);

        if (result.tracked) {
          const fullX = result.x * scaled.scaleX;
          const fullY = result.y * scaled.scaleY;

          lastPointRef.current = { x: fullX, y: fullY, tracked: true };

          // Store for playback
          trackedPathRef.current.push({
            x: fullX,
            y: fullY,
            timestamp: targetTime * 1000,
          });

          updateWithTimestampRef.current([{
            x: fullX - 5, y: fullY - 5,
            width: 10, height: 10,
            centerX: fullX, centerY: fullY,
            score: 1.0, label: 0,
          }], targetTime * 1000);
        } else {
          lastPointRef.current = { x: 0, y: 0, tracked: false };
        }
      }

      frameIndex++;
      setAnalysisProgress(frameIndex);
    }

    if (!analysisAbortRef.current) {
      setAnalysisState('complete');
      const reps = kinematicsRef.current.repHistory;
      setCompletedReps(reps);
      setPostAnalysisView('choice');
    } else {
      setAnalysisState('idle');
    }
  }, [isSeeded, captureFrame, captureScaledFrame, resetAll, seekTo]);

  const stopAnalysis = useCallback(() => {
    analysisAbortRef.current = true;
    if (videoRef.current) videoRef.current.pause();
    setAnalysisState('idle');
  }, []);

  // ── Playback ──────────────────────────────────────────────────────────────
  const startPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || trackedPathRef.current.length === 0) return;

    setPostAnalysisView('playback');
    setIsPlayingBack(true);

    // Reset kinematics bar path for visual replay
    // (don't reset reps/velocity — keep the results)
    lastPointRef.current = null;

    video.currentTime = 0;
    video.playbackRate = 1.0;
    video.play();

    const path = trackedPathRef.current;
    let pathIndex = 0;

    const playbackLoop = () => {
      if (!video || video.ended) {
        setIsPlayingBack(false);
        return;
      }

      if (video.paused) {
        animFrameRef.current = requestAnimationFrame(playbackLoop);
        return;
      }

      const currentMs = video.currentTime * 1000;

      // Advance to the correct path position for current video time
      while (pathIndex < path.length - 1 && path[pathIndex + 1].timestamp <= currentMs) {
        pathIndex++;
      }

      if (path[pathIndex]) {
        const point = path[pathIndex];
        lastPointRef.current = { x: point.x, y: point.y, tracked: true };
        render();
      }

      animFrameRef.current = requestAnimationFrame(playbackLoop);
    };

    // Reset path index
    pathIndex = 0;
    animFrameRef.current = requestAnimationFrame(playbackLoop);

    // Clean up when video ends
    video.addEventListener('ended', () => {
      setIsPlayingBack(false);
    }, { once: true });

  }, [render]);

  const stopPlayback = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    if (videoRef.current) videoRef.current.pause();
    setIsPlayingBack(false);
  }, []);

  // ── New set ───────────────────────────────────────────────────────────────
  const startNewSet = useCallback(() => {
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    setIsSeeded(false);
    setPostAnalysisView('choice');
    setIsPlayingBack(false);
    lastPointRef.current = null;
    trackedPathRef.current = [];
    resetKinematics();
    trackerRef.current.reset();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
    cancelAnimationFrame(animFrameRef.current);
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
    setCompletedReps([]);
    setAnalysisState('idle');
    setAnalysisProgress(0);
    setIsSeeded(false);
    setPostAnalysisView('choice');
    setIsPlayingBack(false);
    lastPointRef.current = null;
    trackedPathRef.current = [];
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
    if (postAnalysisView === 'playback') return null;
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

  // ── Results screen ────────────────────────────────────────────────────────
  if (postAnalysisView === 'results' && completedReps.length > 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-4 bg-slate-950 min-h-screen text-white">
        <h1 className="text-xl font-bold">🏋️ Barbell Tracker</h1>

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

        <div className="flex gap-3 w-full max-w-xl">
          {trackedPathRef.current.length > 0 && (
            <button
              onClick={() => { setPostAnalysisView('playback'); startPlayback(); }}
              className="flex-1 py-3 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600"
            >
              ▶ Play Back
            </button>
          )}
          <button
            onClick={startNewSet}
            className="flex-1 py-3 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-700"
          >
            🔄 New Set
          </button>
        </div>
      </div>
    );
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col bg-slate-950 min-h-screen text-white">

      {/* Top bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <h1 className="text-base font-bold">🏋️ Barbell Tracker</h1>
        <div className="flex items-center gap-2 text-xs">
          <StatusDot ok={trackerReady}  label={`T:${tracker.status.slice(0,4)}`} />
          <StatusDot ok={plateReady}    label={`P:${plateDetector.status.slice(0,4)}`} />
          <StatusDot ok={fps > 5}       label={`${fps}fps`} />
          <StatusDot
            ok={!!kinematics.calibrationLocked}
            label={kinematics.calibrationLocked
              ? `${kinematics.pixelsPerMetre!.toFixed(0)}px/m`
              : 'NO CAL'}
          />
        </div>
      </div>

      {/* Mode toggle — hide during analysis and playback */}
      {analysisState !== 'analysing' && postAnalysisView !== 'playback' && (
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
      )}

      {/* ── Analysis progress screen ── */}
      {analysisState === 'analysing' ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-6 p-8"
          style={{ minHeight: '60vh' }}>
          <div className="text-4xl">⚙️</div>
          <div className="text-center">
            <div className="text-white font-semibold text-lg mb-1">Analysing video...</div>
            <div className="text-slate-400 text-sm">
              {currentSampleFps}fps · {isMobile ? 'mobile' : 'desktop'} mode
            </div>
          </div>
          <div className="w-full max-w-sm">
            <div className="w-full bg-slate-700 rounded-full h-3 mb-2">
              <div
                className="bg-blue-500 h-3 rounded-full transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="text-slate-400 text-xs font-mono text-center">
              {progressPct.toFixed(0)}% · {analysisProgress} / {totalFrames} frames
            </div>
          </div>
          <button
            onClick={stopAnalysis}
            className="px-8 py-3 rounded-lg font-semibold text-sm bg-red-600 hover:bg-red-700"
          >
            ⏹ Stop
          </button>
        </div>

      ) : (
        <>
          {/* ── Video area ── */}
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
              onEnded={() => setIsPlayingBack(false)}
            />
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 w-full h-full"
              style={{ pointerEvents: 'none' }}
            />

            {!webcam.isReady && !uploadedVideo && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm">
                {mode === 'camera' ? 'Tap Start Camera below' : 'Upload a video below'}
              </div>
            )}
          </div>

          {/* Tap hint */}
          {hint && (
            <div className={`px-4 py-2 text-xs text-center ${hint.colour}`}>
              {hint.text}
            </div>
          )}

          {/* ── Post-analysis choice screen ── */}
          {analysisState === 'complete' && postAnalysisView === 'choice' && (
            <div className="flex flex-col items-center gap-3 px-3 py-4">
              <div className="text-green-400 font-semibold text-center">
                ✅ Analysis complete — {completedReps.length} rep{completedReps.length !== 1 ? 's' : ''} detected
              </div>
              <div className="flex gap-3 w-full">
                <button
                  onClick={() => { startPlayback(); }}
                  className="flex-1 py-3 rounded-lg font-semibold text-sm bg-slate-700 hover:bg-slate-600"
                >
                  ▶ Play Back
                </button>
                <button
                  onClick={() => setPostAnalysisView('results')}
                  className="flex-1 py-3 rounded-lg font-semibold text-sm bg-green-600 hover:bg-green-700"
                >
                  📊 View Results
                </button>
              </div>
              <button
                onClick={startNewSet}
                className="w-full py-2.5 rounded-lg text-sm bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                🔄 Start New Set
              </button>
            </div>
          )}

          {/* ── Playback controls ── */}
          {postAnalysisView === 'playback' && (
            <div className="flex flex-col gap-2 px-3 py-3">
              <div className="flex gap-2">
                <button
                  onClick={isPlayingBack ? stopPlayback : startPlayback}
                  className={`flex-1 py-3 rounded-lg font-semibold text-sm
                    ${isPlayingBack ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-green-600 hover:bg-green-700'}`}
                >
                  {isPlayingBack ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  onClick={() => {
                    stopPlayback();
                    setPostAnalysisView('results');
                  }}
                  className="flex-1 py-3 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-700"
                >
                  📊 Results
                </button>
                <button
                  onClick={() => {
                    stopPlayback();
                    setPostAnalysisView('choice');
                  }}
                  className="px-4 py-3 rounded-lg text-sm bg-slate-700 hover:bg-slate-600"
                >
                  ✕
                </button>
              </div>

              {/* Live stats during playback */}
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
            </div>
          )}

          {/* ── Normal camera/upload controls ── */}
          {postAnalysisView === 'choice' && analysisState !== 'complete' && (
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
                    className="px-4 py-3 rounded-lg text-sm bg-slate-700 hover:bg-slate-600"
                  >
                    🔄
                  </button>
                </div>
              )}

              {/* Upload controls */}
              {mode === 'upload' && (
                <>
                  <label className="cursor-pointer">
                    <div className="border border-dashed border-slate-600 hover:border-blue-500
                      rounded-lg py-3 text-center transition-colors">
                      <span className="text-sm text-slate-300">
                        {uploadedVideo ? '📹 Change video' : '📹 Upload video'}
                      </span>
                    </div>
                    <input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} />
                  </label>

                  {uploadedVideo && (
                    <div className="flex gap-2">
                      <button
                        onClick={analyseVideoFrameByFrame}
                        disabled={!videoReady || modelsLoading || !isSeeded}
                        className="flex-1 py-3 rounded-lg font-semibold text-sm bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed"
                      >
                        {!videoReady ? 'Loading...'
                          : modelsLoading ? 'Loading...'
                          : !isSeeded ? 'Tap bar first'
                          : '▶ Analyse'}
                      </button>
                      <button
                        onClick={() => {
                          resetAll();
                          trackerRef.current.reset();
                          setAnalysisState('idle');
                          setAnalysisProgress(0);
                          setIsSeeded(false);
                          setPostAnalysisView('choice');
                          lastPointRef.current = null;
                          trackedPathRef.current = [];
                        }}
                        className="px-4 py-3 rounded-lg text-sm bg-slate-700 hover:bg-slate-600"
                      >
                        🔄
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Live stats */}
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

              {/* Settings */}
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCalInput(v => !v)}
                  className="flex-1 py-2 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  ⚙️ {kinematics.calibrationLocked
                    ? `CAL: ${kinematics.pixelsPerMetre!.toFixed(0)} px/m 🔒`
                    : 'Manual Calibration'}
                </button>
                <button
                  onClick={() => setShowTips(v => !v)}
                  className="px-4 py-2 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  💡 Tips
                </button>
              </div>

              {/* Calibration input */}
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

              {/* Tips */}
              {showTips && (
                <div className="bg-slate-800 rounded-lg p-3 text-xs text-slate-300 space-y-2">
                  <p className="font-semibold text-white">📹 How to film:</p>
                  <ul className="space-y-1">
                    <li>✅ Camera side-on, perpendicular to bar path</li>
                    <li>✅ Bar end fully visible throughout the lift</li>
                    <li>✅ Camera stable — don't move during the set</li>
                    <li>✅ Weight plate visible for auto-calibration</li>
                    <li>⚠️ Do not walk between camera and bar</li>
                    <li>⚠️ If someone crosses the bar path, trim first</li>
                  </ul>
                  <p className="font-semibold text-white">🎯 Tracking tips:</p>
                  <ul className="space-y-1">
                    <li>👆 Tap precisely on the end of the bar sleeve</li>
                    <li>🔄 Re-tap if tracking is lost</li>
                    <li>💡 Good lighting improves plate calibration</li>
                    <li>📏 Runs at {currentSampleFps > 0 ? `${currentSampleFps}fps` : `${isMobile ? '10–15' : '20–30'}fps`}</li>
                  </ul>
                </div>
              )}

              {/* Live rep history */}
              {kinematics.repHistory.length > 0 && (
                <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
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
            </div>
          )}
        </>
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
  label, value, unit, highlight, large,
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
  label, value, sub, colour,
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
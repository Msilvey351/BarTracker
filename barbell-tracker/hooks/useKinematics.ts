'use client';

import { useRef, useState, useCallback } from 'react';
import {
  INITIAL_STATE,
  updateKinematics,
  applyCalibration,
  resetSet,
  fullReset,
  type KinematicsState,
} from '@/lib/kinematics';
import type { Detection } from '@/lib/detector';

export function useKinematics() {
  const [state, setState] = useState<KinematicsState>(INITIAL_STATE);
  const stateRef = useRef(INITIAL_STATE);

  // ── Live camera — uses wall clock time ───────────────────────────────────
  const update = useCallback((detections: Detection[]) => {
    if (detections.length === 0) return;
    const best = detections[0];

    const next = updateKinematics(
      stateRef.current,
      { x: best.centerX, y: best.centerY },
      performance.now(),
    );

    stateRef.current = next;
    setState(next);
  }, []);

  // ── Frame-by-frame — uses video timestamp for determinism ────────────────
  const updateWithTimestamp = useCallback((detections: Detection[], timestampMs: number) => {
    if (detections.length === 0) return;
    const best = detections[0];

    const next = updateKinematics(
      stateRef.current,
      { x: best.centerX, y: best.centerY },
      timestampMs,  // ← video time in ms, same every run
    );

    stateRef.current = next;
    setState(next);
  }, []);

  // ── Calibration — locks on first plate detection ─────────────────────────
  const updateCalibration = useCallback((plateDetections: Detection[]) => {
    if (stateRef.current.calibrationLocked) return;

    const next = applyCalibration(
      stateRef.current,
      plateDetections.map(d => ({ height: d.height, score: d.score }))
    );

    stateRef.current = next;
    setState(next);
  }, []);

  // ── Reset set stats — keeps calibration ──────────────────────────────────
  const reset = useCallback(() => {
    const next = resetSet(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  // ── Full reset — clears calibration too ──────────────────────────────────
  const resetAll = useCallback(() => {
    const next = fullReset();
    stateRef.current = next;
    setState(next);
  }, []);

  // ── Manual calibration override ───────────────────────────────────────────
  const setCalibration = useCallback((pixelsPerMetre: number) => {
    const next = {
      ...stateRef.current,
      pixelsPerMetre,
      calibrationLocked: true,
    };
    stateRef.current = next;
    setState(next);
  }, []);

  return {
    kinematics: state,
    update,
    updateWithTimestamp,
    updateCalibration,
    reset,
    resetAll,
    setCalibration,
  };
}
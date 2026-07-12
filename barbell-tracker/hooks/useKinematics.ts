'use client';

import { useRef, useState, useCallback } from 'react';
import {
  INITIAL_STATE,
  updateKinematics,
  resetSet,
  type KinematicsState,
} from '@/lib/kinematics';
import type { Detection } from '@/lib/detector';

export function useKinematics() {
  const [state, setState] = useState<KinematicsState>(INITIAL_STATE);
  const stateRef = useRef(INITIAL_STATE);

  // Update bar position from barbell detections
  const update = useCallback((detections: Detection[]) => {
    if (detections.length === 0) return;
    const best = detections[0];

    const next = updateKinematics(
      stateRef.current,
      { x: best.centerX, y: best.centerY },
      performance.now(),
      undefined, // ← no longer using barbell bbox for calibration
    );

    stateRef.current = next;
    setState(next);
  }, []);

  // Update calibration from plate detections
  const updateCalibration = useCallback((plateDetections: Detection[]) => {
    if (plateDetections.length === 0) return;
    if (stateRef.current.pixelsPerMetre) return; // already calibrated

    // Use the largest detected plate for calibration
    const largest = plateDetections.reduce((a, b) =>
      a.height > b.height ? a : b
    );

    // Sanity check — plate bbox must be reasonable size
    if (largest.height < 20 || largest.height > 800) return;

    const pixelsPerMetre = largest.height / 0.45;
    console.log(`✅ Calibrated from plate: ${largest.height.toFixed(0)}px = 0.45m → ${pixelsPerMetre.toFixed(0)}px/m`);

    const next = { ...stateRef.current, pixelsPerMetre };
    stateRef.current = next;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    const next = resetSet(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const setCalibration = useCallback((pixelsPerMetre: number) => {
    const next = { ...stateRef.current, pixelsPerMetre };
    stateRef.current = next;
    setState(next);
  }, []);

  return { kinematics: state, update, updateCalibration, reset, setCalibration };
}
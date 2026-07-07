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

  // Receives RAW video pixel detections — not display scaled
  const update = useCallback((detections: Detection[]) => {
    if (detections.length === 0) return;

    // detections are already sorted by score after NMS — use first (best)
    const best = detections[0];

    const next = updateKinematics(
      stateRef.current,
      { x: best.centerX, y: best.centerY },
      performance.now(),
      best.height
    );

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

  return { kinematics: state, update, reset, setCalibration };
}
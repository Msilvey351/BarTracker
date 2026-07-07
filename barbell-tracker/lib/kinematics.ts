export interface BarPosition {
  x: number;
  y: number;
  timestamp: number;
}

export interface KinematicsState {
  positions: BarPosition[];
  barPath: BarPosition[];
  velocity: number;
  peakVelocity: number;
  repCount: number;
  phase: 'idle' | 'concentric' | 'eccentric';
  pixelsPerMetre: number | null;
}

export const INITIAL_STATE: KinematicsState = {
  positions: [],
  barPath: [],
  velocity: 0,
  peakVelocity: 0,
  repCount: 0,
  phase: 'idle',
  pixelsPerMetre: null,
};

export const PLATE_DIAMETER_METRES = 0.45;

export function calibrateFromPlate(plateBboxHeightPx: number): number {
  return plateBboxHeightPx / PLATE_DIAMETER_METRES;
}

const VELOCITY_WINDOW = 5;

export function computeVelocity(
  positions: BarPosition[],
  pixelsPerMetre: number
): number {
  if (positions.length < 2) return 0;

  const window = positions.slice(-VELOCITY_WINDOW);
  const first = window[0];
  const last = window[window.length - 1];

  const dtSec = (last.timestamp - first.timestamp) / 1000;
  if (dtSec === 0) return 0;

  const dxPx = last.x - first.x;
  const dyPx = last.y - first.y;
  const distancePx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  const distanceM = distancePx / pixelsPerMetre;

  return distanceM / dtSec;
}

const MIN_TRAVEL_METRES = 0.05;
const DIRECTION_THRESHOLD = 0.02;

export function detectRep(
  positions: BarPosition[],
  pixelsPerMetre: number,
  currentPhase: KinematicsState['phase'],
  currentRepCount: number
): { phase: KinematicsState['phase']; repCount: number } {
  if (positions.length < 3) {
    return { phase: currentPhase, repCount: currentRepCount };
  }

  const recent = positions.slice(-6);
  const first = recent[0];
  const last = recent[recent.length - 1];

  const dyMetres = (last.y - first.y) / pixelsPerMetre;

  let phase = currentPhase;
  let repCount = currentRepCount;

  if (dyMetres < -MIN_TRAVEL_METRES) {
    phase = 'concentric';
  } else if (dyMetres > DIRECTION_THRESHOLD && currentPhase === 'concentric') {
    phase = 'eccentric';
    repCount += 1;
  } else if (Math.abs(dyMetres) < MIN_TRAVEL_METRES / 2 && currentPhase === 'eccentric') {
    phase = 'idle';
  }

  return { phase, repCount };
}

export function updateKinematics(
  state: KinematicsState,
  newPos: { x: number; y: number },
  timestamp: number,
  plateBboxHeightPx?: number
): KinematicsState {
  let pixelsPerMetre = state.pixelsPerMetre;
  if (!pixelsPerMetre && plateBboxHeightPx && plateBboxHeightPx > 10) {
    pixelsPerMetre = calibrateFromPlate(plateBboxHeightPx);
  }

  const newBarPos: BarPosition = { ...newPos, timestamp };
  const positions = [...state.positions, newBarPos].slice(-60);
  const barPath = [...state.barPath, newBarPos].slice(-300);

  const velocity = pixelsPerMetre
    ? computeVelocity(positions, pixelsPerMetre)
    : 0;

  const peakVelocity = Math.max(state.peakVelocity, velocity);

  const { phase, repCount } = pixelsPerMetre
    ? detectRep(positions, pixelsPerMetre, state.phase, state.repCount)
    : { phase: state.phase, repCount: state.repCount };

  return {
    positions,
    barPath,
    velocity,
    peakVelocity,
    repCount,
    phase,
    pixelsPerMetre,
  };
}

export function resetSet(state: KinematicsState): KinematicsState {
  return {
    ...state,
    positions: [],
    barPath: [],
    velocity: 0,
    peakVelocity: 0,
    repCount: 0,
    phase: 'idle',
  };
}
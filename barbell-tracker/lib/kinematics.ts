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
  concentricStartTime: number | null;
}

export const INITIAL_STATE: KinematicsState = {
  positions: [],
  barPath: [],
  velocity: 0,
  peakVelocity: 0,
  repCount: 0,
  phase: 'idle',
  pixelsPerMetre: null,
  concentricStartTime: null,
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

// ── Rep detection constants ───────────────────────────────────────────────────
const MIN_TRAVEL_METRES   = 0.10;  // Fix 1 — min 10cm vertical travel
const MIN_REP_DURATION_MS = 100;   // Fix 2 — min 0.1s concentric phase
const DIRECTION_FRAMES    = 10;    // Fix 4 — frames to check consistency
const MIN_CONSISTENCY     = 0.7;   // Fix 4 — 70% of frames same direction

export function detectRep(
  positions: BarPosition[],
  pixelsPerMetre: number,
  currentPhase: KinematicsState['phase'],
  currentRepCount: number,
  concentricStartTime: number | null,
): {
  phase: KinematicsState['phase'];
  repCount: number;
  concentricStartTime: number | null;
} {
  if (positions.length < DIRECTION_FRAMES) {
    return {
      phase: currentPhase,
      repCount: currentRepCount,
      concentricStartTime,
    };
  }

  const now = performance.now();
  const recent = positions.slice(-DIRECTION_FRAMES);
  const first = recent[0];
  const last = recent[recent.length - 1];

  // ── Displacement over window ──────────────────────────────────────────────
  const dyMetres = (last.y - first.y) / pixelsPerMetre; // negative = up
  const dyAbsMetres = Math.abs(dyMetres);

  // ── Fix 4 — Direction consistency ────────────────────────────────────────
  let upFrames = 0;
  let downFrames = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].y < recent[i - 1].y) upFrames++;
    else if (recent[i].y > recent[i - 1].y) downFrames++;
  }
  const totalFrames = upFrames + downFrames;
  const upConsistency   = totalFrames > 0 ? upFrames   / totalFrames : 0;
  const downConsistency = totalFrames > 0 ? downFrames / totalFrames : 0;

  let phase = currentPhase;
  let repCount = currentRepCount;
  let newConcentricStartTime = concentricStartTime;

  // ── Concentric — bar going UP ─────────────────────────────────────────────
  const isGoingUp = (
    dyMetres < -MIN_TRAVEL_METRES &&      // Fix 1 — enough vertical travel
    upConsistency >= MIN_CONSISTENCY      // Fix 4 — consistently moving up
  );

  if (isGoingUp && currentPhase !== 'concentric') {
    phase = 'concentric';
    newConcentricStartTime = now;
  }

  // ── Eccentric — bar going DOWN after concentric ───────────────────────────
  const isGoingDown = (
    dyMetres > 0.05 &&                    // moving down
    downConsistency >= MIN_CONSISTENCY && // Fix 4 — consistently moving down
    currentPhase === 'concentric'
  );

  if (isGoingDown) {
    const concentricDuration = concentricStartTime ? now - concentricStartTime : 0;

    if (concentricDuration >= MIN_REP_DURATION_MS) {
      // Fix 2 — only count if concentric lasted at least 0.1s
      phase = 'eccentric';
      repCount += 1;
      newConcentricStartTime = null;
    } else {
      // Too short — noise, reset
      phase = 'idle';
      newConcentricStartTime = null;
    }
  }

  // ── Return to idle ────────────────────────────────────────────────────────
  if (
    dyAbsMetres < 0.02 &&
    currentPhase === 'eccentric'
  ) {
    phase = 'idle';
  }

  return {
    phase,
    repCount,
    concentricStartTime: newConcentricStartTime,
  };
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

  const {
    phase,
    repCount,
    concentricStartTime,
  } = pixelsPerMetre
    ? detectRep(
        positions,
        pixelsPerMetre,
        state.phase,
        state.repCount,
        state.concentricStartTime,
      )
    : {
        phase: state.phase,
        repCount: state.repCount,
        concentricStartTime: state.concentricStartTime,
      };

  return {
    positions,
    barPath,
    velocity,
    peakVelocity,
    repCount,
    phase,
    pixelsPerMetre,
    concentricStartTime,
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
    concentricStartTime: null,
  };
}
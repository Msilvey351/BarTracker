export interface BarPosition {
  x: number;
  y: number;
  timestamp: number;
}

export interface RepStats {
  repNumber: number;
  concentricVelocity: number;   // average m/s during concentric
  eccentricVelocity: number;    // average m/s during eccentric (0 until eccentric ends)
  peakVelocity: number;         // peak instantaneous velocity during concentric
  concentricDistance: number;   // metres travelled during concentric
  concentricDuration: number;   // seconds
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
  concentricPositions: BarPosition[];   // positions during current concentric
  eccentricPositions: BarPosition[];    // positions during current eccentric
  repHistory: RepStats[];               // all completed reps this set
  currentRepPeakVelocity: number;       // peak during current concentric
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
  concentricPositions: [],
  eccentricPositions: [],
  repHistory: [],
  currentRepPeakVelocity: 0,
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
  return (distancePx / pixelsPerMetre) / dtSec;
}

// ── Calculate average velocity over a set of positions ────────────────────────
// Uses only vertical displacement — more meaningful for barbell lifts
function calcPhaseVelocity(
  positions: BarPosition[],
  pixelsPerMetre: number
): { avgVelocity: number; distance: number; duration: number } {
  if (positions.length < 2) return { avgVelocity: 0, distance: 0, duration: 0 };

  const first = positions[0];
  const last = positions[positions.length - 1];

  const duration = (last.timestamp - first.timestamp) / 1000; // seconds
  if (duration === 0) return { avgVelocity: 0, distance: 0, duration: 0 };

  // Use absolute vertical displacement only — bar travel distance
  const dyPx = Math.abs(last.y - first.y);
  const distance = dyPx / pixelsPerMetre; // metres

  const avgVelocity = distance / duration; // m/s

  return { avgVelocity, distance, duration };
}

// ── Peak velocity over a set of positions ─────────────────────────────────────
function calcPeakVelocity(
  positions: BarPosition[],
  pixelsPerMetre: number
): number {
  if (positions.length < 2) return 0;
  let peak = 0;
  for (let i = 1; i < positions.length; i++) {
    const dt = (positions[i].timestamp - positions[i - 1].timestamp) / 1000;
    if (dt === 0) continue;
    const dy = Math.abs(positions[i].y - positions[i - 1].y);
    const v = (dy / pixelsPerMetre) / dt;
    if (v > peak) peak = v;
  }
  return peak;
}

// ── Rep detection constants ───────────────────────────────────────────────────
const MIN_TRAVEL_METRES   = 0.10;
const MIN_REP_DURATION_MS = 100;
const DIRECTION_FRAMES    = 10;
const MIN_CONSISTENCY     = 0.7;

export function detectRep(
  positions: BarPosition[],
  pixelsPerMetre: number,
  currentPhase: KinematicsState['phase'],
  currentRepCount: number,
  concentricStartTime: number | null,
  concentricPositions: BarPosition[],
  eccentricPositions: BarPosition[],
  repHistory: RepStats[],
  currentRepPeakVelocity: number,
  currentVelocity: number,
): {
  phase: KinematicsState['phase'];
  repCount: number;
  concentricStartTime: number | null;
  concentricPositions: BarPosition[];
  eccentricPositions: BarPosition[];
  repHistory: RepStats[];
  currentRepPeakVelocity: number;
} {
  if (positions.length < DIRECTION_FRAMES) {
    return {
      phase: currentPhase,
      repCount: currentRepCount,
      concentricStartTime,
      concentricPositions,
      eccentricPositions,
      repHistory,
      currentRepPeakVelocity,
    };
  }

  const now = performance.now();
  const recent = positions.slice(-DIRECTION_FRAMES);
  const first = recent[0];
  const last = recent[recent.length - 1];

  const dyMetres = (last.y - first.y) / pixelsPerMetre;
  const dyAbsMetres = Math.abs(dyMetres);

  // Direction consistency
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
  let newConcentricPositions = concentricPositions;
  let newEccentricPositions  = eccentricPositions;
  let newRepHistory = repHistory;
  let newPeakVelocity = currentRepPeakVelocity;

  const latestPos = positions[positions.length - 1];

  // ── Concentric — bar going UP ─────────────────────────────────────────────
  const isGoingUp = (
    dyMetres < -MIN_TRAVEL_METRES &&
    upConsistency >= MIN_CONSISTENCY
  );

  if (isGoingUp && currentPhase !== 'concentric') {
    phase = 'concentric';
    newConcentricStartTime = now;
    newConcentricPositions = [latestPos];
    newEccentricPositions  = [];
    newPeakVelocity = 0;
  } else if (currentPhase === 'concentric') {
    // Accumulate positions and track peak
    newConcentricPositions = [...concentricPositions, latestPos];
    newPeakVelocity = Math.max(currentRepPeakVelocity, currentVelocity);
  }

  // ── Eccentric — bar going DOWN after concentric ───────────────────────────
  const isGoingDown = (
    dyMetres > 0.05 &&
    downConsistency >= MIN_CONSISTENCY &&
    currentPhase === 'concentric'
  );

  if (isGoingDown) {
    const concentricDuration = concentricStartTime ? now - concentricStartTime : 0;

    if (concentricDuration >= MIN_REP_DURATION_MS) {
      // ── Calculate concentric stats ──────────────────────────────────────
      const {
        avgVelocity: concAvg,
        distance: concDist,
        duration: concDur,
      } = calcPhaseVelocity(newConcentricPositions, pixelsPerMetre);

      const peakV = calcPeakVelocity(newConcentricPositions, pixelsPerMetre);

      repCount += 1;
      phase = 'eccentric';
      newConcentricStartTime = null;
      newEccentricPositions = [latestPos];

      // Add rep to history with concentric stats
      // Eccentric will be filled in when eccentric ends
      const newRep: RepStats = {
        repNumber: repCount,
        concentricVelocity: concAvg,
        eccentricVelocity: 0,       // filled in when eccentric ends
        peakVelocity: peakV,
        concentricDistance: concDist,
        concentricDuration: concDur,
      };
      newRepHistory = [...repHistory, newRep];
      newPeakVelocity = 0;

    } else {
      phase = 'idle';
      newConcentricStartTime = null;
      newConcentricPositions = [];
    }
  }

  // ── Accumulate eccentric positions ────────────────────────────────────────
  if (currentPhase === 'eccentric') {
    newEccentricPositions = [...eccentricPositions, latestPos];
  }

  // ── Return to idle — eccentric complete ───────────────────────────────────
  if (dyAbsMetres < 0.02 && currentPhase === 'eccentric') {
    phase = 'idle';

    // ── Calculate eccentric stats and update last rep ─────────────────────
    if (newEccentricPositions.length >= 2 && newRepHistory.length > 0) {
      const { avgVelocity: eccAvg } = calcPhaseVelocity(
        newEccentricPositions,
        pixelsPerMetre
      );

      // Update the last rep with eccentric velocity
      const updatedHistory = [...newRepHistory];
      updatedHistory[updatedHistory.length - 1] = {
        ...updatedHistory[updatedHistory.length - 1],
        eccentricVelocity: eccAvg,
      };
      newRepHistory = updatedHistory;
    }

    newEccentricPositions = [];
  }

  return {
    phase,
    repCount,
    concentricStartTime: newConcentricStartTime,
    concentricPositions: newConcentricPositions,
    eccentricPositions:  newEccentricPositions,
    repHistory: newRepHistory,
    currentRepPeakVelocity: newPeakVelocity,
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
  const barPath   = [...state.barPath,   newBarPos].slice(-300);

  const velocity     = pixelsPerMetre ? computeVelocity(positions, pixelsPerMetre) : 0;
  const peakVelocity = Math.max(state.peakVelocity, velocity);

  const result = pixelsPerMetre
    ? detectRep(
        positions,
        pixelsPerMetre,
        state.phase,
        state.repCount,
        state.concentricStartTime,
        state.concentricPositions,
        state.eccentricPositions,
        state.repHistory,
        state.currentRepPeakVelocity,
        velocity,
      )
    : {
        phase:                  state.phase,
        repCount:               state.repCount,
        concentricStartTime:    state.concentricStartTime,
        concentricPositions:    state.concentricPositions,
        eccentricPositions:     state.eccentricPositions,
        repHistory:             state.repHistory,
        currentRepPeakVelocity: state.currentRepPeakVelocity,
      };

  return {
    positions,
    barPath,
    velocity,
    peakVelocity,
    repCount:               result.repCount,
    phase:                  result.phase,
    pixelsPerMetre,
    concentricStartTime:    result.concentricStartTime,
    concentricPositions:    result.concentricPositions,
    eccentricPositions:     result.eccentricPositions,
    repHistory:             result.repHistory,
    currentRepPeakVelocity: result.currentRepPeakVelocity,
  };
}

export function resetSet(state: KinematicsState): KinematicsState {
  return {
    ...state,
    positions:              [],
    barPath:                [],
    velocity:               0,
    peakVelocity:           0,
    repCount:               0,
    phase:                  'idle',
    concentricStartTime:    null,
    concentricPositions:    [],
    eccentricPositions:     [],
    repHistory:             [],
    currentRepPeakVelocity: 0,
  };
}
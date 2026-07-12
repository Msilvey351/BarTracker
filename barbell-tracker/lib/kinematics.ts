export interface BarPosition {
  x: number;
  y: number;
  timestamp: number;
}

export interface RepStats {
  repNumber: number;
  concentricVelocity: number;
  eccentricVelocity: number;
  peakVelocity: number;
  concentricDistance: number;
  concentricDuration: number;
}

export interface KinematicsState {
  positions: BarPosition[];
  barPath: BarPosition[];
  velocity: number;
  peakVelocity: number;
  repCount: number;
  phase: 'idle' | 'concentric' | 'eccentric';
  pixelsPerMetre: number | null;
  calibrationLocked: boolean;
  concentricStartTime: number | null;
  concentricPositions: BarPosition[];
  eccentricPositions: BarPosition[];
  repHistory: RepStats[];
  currentRepPeakVelocity: number;
}

export const INITIAL_STATE: KinematicsState = {
  positions: [],
  barPath: [],
  velocity: 0,
  peakVelocity: 0,
  repCount: 0,
  phase: 'idle',
  pixelsPerMetre: null,
  calibrationLocked: false,
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

const VELOCITY_WINDOW = 8;

// ── Option A — Maximum position jump filter ───────────────────────────────────
// If bar teleports more than this between frames it's a detection glitch
const MAX_JUMP_PX = 150;

// ── Option B — Minimum detection score ───────────────────────────────────────
// Only positions from high-confidence detections are used
// (Note: primary score filter is in detector config at 0.45
//  this is a secondary check inside kinematics)
const MIN_POSITION_SCORE = 0.40;

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

  return Math.min((distancePx / pixelsPerMetre) / dtSec, 3.0);
}

const DIRECTION_FRAMES    = 10;
const MIN_CONSISTENCY     = 0.7;
const MIN_TRAVEL_METRES   = 0.10;
const MIN_REP_DURATION_MS = 100;

function calcPhaseVelocity(
  positions: BarPosition[],
  pixelsPerMetre: number
): { avgVelocity: number; distance: number; duration: number } {
  if (positions.length < 2) return { avgVelocity: 0, distance: 0, duration: 0 };

  const first = positions[0];
  const last = positions[positions.length - 1];
  const duration = (last.timestamp - first.timestamp) / 1000;
  if (duration === 0) return { avgVelocity: 0, distance: 0, duration: 0 };

  const dyPx = Math.abs(last.y - first.y);
  const distance = dyPx / pixelsPerMetre;
  const avgVelocity = distance / duration;

  return { avgVelocity, distance, duration };
}

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
  return Math.min(peak, 3.0);
}

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

  let upFrames = 0;
  let downFrames = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].y < recent[i - 1].y) upFrames++;
    else if (recent[i].y > recent[i - 1].y) downFrames++;
  }
  const totalFrames = upFrames + downFrames;
  const upConsistency   = totalFrames > 0 ? upFrames   / totalFrames : 0;
  const downConsistency = totalFrames > 0 ? downFrames / totalFrames : 0;

  const isSustainedUp   = dyMetres < -MIN_TRAVEL_METRES && upConsistency   >= MIN_CONSISTENCY;
  const isSustainedDown = dyMetres >  MIN_TRAVEL_METRES && downConsistency >= MIN_CONSISTENCY;
  const isStationary    = dyAbsMetres < 0.02;

  let phase = currentPhase;
  let repCount = currentRepCount;
  let newConcentricStartTime = concentricStartTime;
  let newConcentricPositions = concentricPositions;
  let newEccentricPositions  = eccentricPositions;
  let newRepHistory = repHistory;
  let newPeakVelocity = currentRepPeakVelocity;

  const latestPos = positions[positions.length - 1];

  switch (currentPhase) {
    case 'idle': {
      if (isSustainedUp) {
        phase = 'concentric';
        newConcentricStartTime = now;
        newConcentricPositions = [...recent];
        newPeakVelocity = 0;
      } else if (isSustainedDown) {
        phase = 'eccentric';
        newEccentricPositions = [...recent];
      }
      break;
    }

    case 'concentric': {
      newConcentricPositions = [...concentricPositions, latestPos];
      newPeakVelocity = Math.max(currentRepPeakVelocity, currentVelocity);

      if (isStationary || isSustainedDown) {
        const concentricDuration = concentricStartTime ? now - concentricStartTime : 0;

        if (concentricDuration >= MIN_REP_DURATION_MS && newConcentricPositions.length >= 2) {
          const {
            avgVelocity: concAvg,
            distance: concDist,
            duration: concDur,
          } = calcPhaseVelocity(newConcentricPositions, pixelsPerMetre);

          const peakV = calcPeakVelocity(newConcentricPositions, pixelsPerMetre);

          repCount += 1;
          newRepHistory = [...repHistory, {
            repNumber: repCount,
            concentricVelocity: concAvg,
            eccentricVelocity: 0,
            peakVelocity: peakV,
            concentricDistance: concDist,
            concentricDuration: concDur,
          }];
        }

        if (isSustainedDown) {
          phase = 'eccentric';
          newEccentricPositions = [...recent];
        } else {
          phase = 'idle';
        }

        newConcentricStartTime = null;
        newConcentricPositions = [];
        newPeakVelocity = 0;
      }
      break;
    }

    case 'eccentric': {
      newEccentricPositions = [...eccentricPositions, latestPos];

      if (isStationary || isSustainedUp) {
        if (newEccentricPositions.length >= 2 && newRepHistory.length > 0) {
          const { avgVelocity: eccAvg } = calcPhaseVelocity(
            newEccentricPositions,
            pixelsPerMetre
          );
          const updatedHistory = [...newRepHistory];
          updatedHistory[updatedHistory.length - 1] = {
            ...updatedHistory[updatedHistory.length - 1],
            eccentricVelocity: eccAvg,
          };
          newRepHistory = updatedHistory;
        }

        newEccentricPositions = [];

        if (isSustainedUp) {
          phase = 'concentric';
          newConcentricStartTime = now;
          newConcentricPositions = [...recent];
          newPeakVelocity = 0;
        } else {
          phase = 'idle';
        }
      }
      break;
    }
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
  score: number = 1.0,  // ← detection confidence score
): KinematicsState {
  const { pixelsPerMetre, calibrationLocked } = state;

  // ── Option B — ignore low confidence detections ───────────────────────────
  if (score < MIN_POSITION_SCORE) {
    if (Math.random() < 0.05) {
      console.log(`⚠️ Skipping low confidence detection: score=${score.toFixed(3)}`);
    }
    return state;
  }

  // ── Option A — ignore position jumps (detection glitches) ────────────────
  if (state.positions.length > 0) {
    const last = state.positions[state.positions.length - 1];
    const jumpPx = Math.sqrt(
      Math.pow(newPos.x - last.x, 2) +
      Math.pow(newPos.y - last.y, 2)
    );
    if (jumpPx > MAX_JUMP_PX) {
      if (Math.random() < 0.1) {
        console.log(`⚠️ Skipping position jump: ${jumpPx.toFixed(0)}px (max ${MAX_JUMP_PX}px)`);
      }
      return state; // ignore this detection entirely
    }
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
    calibrationLocked,
    concentricStartTime:    result.concentricStartTime,
    concentricPositions:    result.concentricPositions,
    eccentricPositions:     result.eccentricPositions,
    repHistory:             result.repHistory,
    currentRepPeakVelocity: result.currentRepPeakVelocity,
  };
}

export function applyCalibration(
  state: KinematicsState,
  plateDetections: Array<{ height: number; score: number }>
): KinematicsState {
  if (state.calibrationLocked) return state;

  const best = plateDetections
    .filter(d => d.height > 20 && d.height < 800)
    .sort((a, b) => b.height - a.height)[0];

  if (!best) return state;

  const pixelsPerMetre = calibrateFromPlate(best.height);
  console.log(`✅ Calibration locked: ${best.height.toFixed(0)}px = 0.45m → ${pixelsPerMetre.toFixed(0)} px/m`);

  return {
    ...state,
    pixelsPerMetre,
    calibrationLocked: true,
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

export function fullReset(): KinematicsState {
  return { ...INITIAL_STATE };
}
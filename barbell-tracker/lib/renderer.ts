import type { Detection } from './detector';
import type { KinematicsState } from './kinematics';

const PHASE_COLOURS = {
  idle: '#94a3b8',
  concentric: '#22c55e',
  eccentric: '#f97316',
};

export interface RenderOptions {
  showDetectionBox: boolean;
  showBarPath: boolean;
  showHUD: boolean;
  showCalibrationStatus: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  showDetectionBox: true,
  showBarPath: true,
  showHUD: true,
  showCalibrationStatus: true,
};

export function renderFrame(
  canvas: HTMLCanvasElement,
  displayW: number,
  displayH: number,
  detections: Detection[],
  kinematics: KinematicsState,
  options: RenderOptions = DEFAULT_RENDER_OPTIONS,
  scale: number = 1,
  offsetX: number = 0,
  offsetY: number = 0,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (canvas.width !== displayW) canvas.width = displayW;
  if (canvas.height !== displayH) canvas.height = displayH;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Scale detections to display coordinates
  const scaledDetections = detections.map(d => ({
    ...d,
    x:       d.x       * scale + offsetX,
    y:       d.y       * scale + offsetY,
    width:   d.width   * scale,
    height:  d.height  * scale,
    centerX: d.centerX * scale + offsetX,
    centerY: d.centerY * scale + offsetY,
  }));

  // Scale bar path to display coordinates
  const scaledKinematics = {
    ...kinematics,
    barPath: kinematics.barPath.map(p => ({
      ...p,
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY,
    })),
  };

  if (options.showBarPath) drawBarPath(ctx, scaledKinematics);
  if (options.showDetectionBox) drawDetections(ctx, scaledDetections, kinematics.phase);
  if (options.showHUD) drawHUD(ctx, kinematics, canvas.width, canvas.height);
  if (options.showCalibrationStatus) drawCalibrationBadge(ctx, kinematics);
}

function drawBarPath(ctx: CanvasRenderingContext2D, k: KinematicsState) {
  const path = k.barPath;
  if (path.length < 2) return;

  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (let i = 1; i < path.length; i++) {
    const alpha = i / path.length;
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = '#3b82f6';
    ctx.beginPath();
    ctx.moveTo(path[i - 1].x, path[i - 1].y);
    ctx.lineTo(path[i].x, path[i].y);
    ctx.stroke();
  }

  if (path.length > 0) {
    const last = path[path.length - 1];
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(last.x, last.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawDetections(
  ctx: CanvasRenderingContext2D,
  detections: Detection[],
  phase: KinematicsState['phase']
) {
  const phaseColour = PHASE_COLOURS[phase];

  for (const det of detections) {
    const { x, y, width, height, score } = det;

    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);

    ctx.strokeStyle = phaseColour;
    ctx.lineWidth = 3;
    const cLen = Math.min(width, height) * 0.2;
    ctx.beginPath(); ctx.moveTo(x, y + cLen); ctx.lineTo(x, y); ctx.lineTo(x + cLen, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + width - cLen, y); ctx.lineTo(x + width, y); ctx.lineTo(x + width, y + cLen); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + width, y + height - cLen); ctx.lineTo(x + width, y + height); ctx.lineTo(x + width - cLen, y + height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + cLen, y + height); ctx.lineTo(x, y + height); ctx.lineTo(x, y + height - cLen); ctx.stroke();

    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(`${(score * 100).toFixed(0)}%`, x + 4, y - 5);
    ctx.restore();
  }
}

function drawHUD(
  ctx: CanvasRenderingContext2D,
  k: KinematicsState,
  canvasW: number,
  _canvasH: number
) {
  const pad = 16;
  const panelW = 200;
  const panelH = 140;
  const panelX = canvasW - panelW - pad;
  const panelY = pad;

  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, panelH, 10);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('BARBELL TRACKER', panelX + pad, panelY + 20);

  const velColour = k.velocity > 0.5 ? '#22c55e' : k.velocity > 0.3 ? '#facc15' : '#f87171';
  ctx.fillStyle = velColour;
  ctx.font = 'bold 28px monospace';
  ctx.fillText(
    k.pixelsPerMetre ? `${k.velocity.toFixed(2)} m/s` : '-- m/s',
    panelX + pad, panelY + 56
  );

  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px monospace';
  ctx.fillText(
    `PEAK: ${k.pixelsPerMetre ? k.peakVelocity.toFixed(2) : '--'} m/s`,
    panelX + pad, panelY + 76
  );

  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(`REPS: ${k.repCount}`, panelX + pad, panelY + 104);

  ctx.fillStyle = PHASE_COLOURS[k.phase];
  ctx.font = 'bold 11px monospace';
  ctx.fillText(k.phase.toUpperCase(), panelX + pad, panelY + 126);

  ctx.restore();
}

function drawCalibrationBadge(ctx: CanvasRenderingContext2D, k: KinematicsState) {
  const calibrated = !!k.pixelsPerMetre;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = calibrated ? '#15803d' : '#92400e';
  ctx.beginPath();
  ctx.roundRect(12, 12, calibrated ? 140 : 160, 26, 6);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(
    calibrated ? `✓ CAL ${k.pixelsPerMetre!.toFixed(0)}px/m` : '⚠ AWAITING CALIBRATION',
    20, 30
  );
  ctx.restore();
}
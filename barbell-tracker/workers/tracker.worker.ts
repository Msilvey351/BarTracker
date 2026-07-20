// @ts-nocheck
// workers/tracker.worker.ts

import cv from '@techstark/opencv-js';

let prevGray:   any = null;
let prevPoints: any = null;
let isReady  = false;
let cvReady  = false;

// Numeric constants for TermCriteria — avoids TypeScript errors with cv types
const TERM_CRITERIA_EPS   = 0x01;
const TERM_CRITERIA_COUNT = 0x02;
const TERM_CRITERIA_BOTH  = TERM_CRITERIA_EPS | TERM_CRITERIA_COUNT;

cv.onRuntimeInitialized = () => {
  cvReady = true;
  self.postMessage({ type: 'ready' });
};

function imageDataToGray(imageData: ImageData): any {
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

self.onmessage = (e: MessageEvent) => {
  if (!cvReady) {
    // Queue until OpenCV is ready
    setTimeout(() => {
      self.dispatchEvent(new MessageEvent('message', { data: e.data }));
    }, 100);
    return;
  }

  const { type, payload } = e.data;

  // ── Seed — user tapped a point ────────────────────────────────────────────
  if (type === 'seed') {
    try {
      if (prevGray)   { prevGray.delete();   prevGray   = null; }
      if (prevPoints) { prevPoints.delete(); prevPoints = null; }

      prevGray = imageDataToGray(payload.imageData);

      prevPoints = new cv.Mat(1, 1, cv.CV_32FC2);
      prevPoints.data32F[0] = payload.x;
      prevPoints.data32F[1] = payload.y;

      isReady = true;

      self.postMessage({
        type: 'seeded',
        payload: { x: payload.x, y: payload.y },
      });
    } catch (err) {
      self.postMessage({ type: 'error', payload: String(err) });
    }
  }

  // ── Track — process next frame ────────────────────────────────────────────
  if (type === 'track' && isReady && prevGray && prevPoints) {
    const currGray   = imageDataToGray(payload.imageData);
    const currPoints = new cv.Mat();
    const status     = new cv.Mat();
    const err        = new cv.Mat();

    try {
      cv.calcOpticalFlowPyrLK(
        prevGray,
        currGray,
        prevPoints,
        currPoints,
        status,
        err,
        new cv.Size(21, 21),
        3,
        new cv.TermCriteria(TERM_CRITERIA_BOTH, 30, 0.01),
      );

      const tracked = status.data[0] === 1;

      if (tracked) {
        const x = currPoints.data32F[0];
        const y = currPoints.data32F[1];

        // Update previous frame
        prevGray.delete();
        prevGray = currGray;
        prevPoints.delete();
        prevPoints = currPoints.clone();

        self.postMessage({
          type: 'tracked',
          payload: {
            x,
            y,
            tracked: true,
            videoTimestamp: payload.videoTimestamp,
          },
        });
      } else {
        // Lost tracking — update gray but keep old points
        prevGray.delete();
        prevGray = currGray;

        self.postMessage({
          type: 'tracked',
          payload: {
            x: 0,
            y: 0,
            tracked: false,
            videoTimestamp: payload.videoTimestamp,
          },
        });
      }
    } catch (e) {
      // If optical flow throws — clean up and report lost
      try { currGray.delete(); } catch (_) {}
      self.postMessage({
        type: 'tracked',
        payload: {
          x: 0,
          y: 0,
          tracked: false,
          videoTimestamp: payload.videoTimestamp,
        },
      });
    } finally {
      try { currPoints.delete(); } catch (_) {}
      try { status.delete(); }     catch (_) {}
      try { err.delete(); }        catch (_) {}
    }
  }

  // ── Reset — clear tracking state ──────────────────────────────────────────
  if (type === 'reset') {
    try { if (prevGray)   prevGray.delete();   } catch (_) {}
    try { if (prevPoints) prevPoints.delete(); } catch (_) {}
    prevGray   = null;
    prevPoints = null;
    isReady    = false;
    self.postMessage({ type: 'reset_ok' });
  }
};
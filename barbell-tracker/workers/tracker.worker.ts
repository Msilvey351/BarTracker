// @ts-nocheck
// workers/tracker.worker.ts

// Do NOT import cv at module level — load it dynamically
// This prevents Turbopack from trying to bundle it

let cv: any = null;
let prevGray:   any = null;
let prevPoints: any = null;
let isReady  = false;
let cvReady  = false;

const TERM_CRITERIA_EPS   = 0x01;
const TERM_CRITERIA_COUNT = 0x02;
const TERM_CRITERIA_BOTH  = TERM_CRITERIA_EPS | TERM_CRITERIA_COUNT;

// Load OpenCV dynamically using importScripts (works in Web Workers)
// This bypasses the bundler entirely
try {
  importScripts('https://docs.opencv.org/4.8.0/opencv.js');
  // cv is now available as a global
  cv = self.cv;
  if (cv?.onRuntimeInitialized !== undefined) {
    if (cv.Mat) {
      // Already initialised
      cvReady = true;
      self.postMessage({ type: 'ready' });
    } else {
      cv.onRuntimeInitialized = () => {
        cvReady = true;
        self.postMessage({ type: 'ready' });
      };
    }
  }
} catch (e) {
  self.postMessage({ type: 'error', payload: `Failed to load OpenCV: ${e}` });
}

function imageDataToGray(imageData: ImageData): any {
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

self.onmessage = (e: MessageEvent) => {
  if (!cvReady) {
    setTimeout(() => {
      self.dispatchEvent(new MessageEvent('message', { data: e.data }));
    }, 100);
    return;
  }

  const { type, payload } = e.data;

  // ── Seed ─────────────────────────────────────────────────────────────────
  if (type === 'seed') {
    try {
      if (prevGray)   { prevGray.delete();   prevGray   = null; }
      if (prevPoints) { prevPoints.delete(); prevPoints = null; }

      prevGray = imageDataToGray(payload.imageData);
      prevPoints = new cv.Mat(1, 1, cv.CV_32FC2);
      prevPoints.data32F[0] = payload.x;
      prevPoints.data32F[1] = payload.y;

      isReady = true;
      self.postMessage({ type: 'seeded', payload: { x: payload.x, y: payload.y } });
    } catch (err) {
      self.postMessage({ type: 'error', payload: String(err) });
    }
  }

  // ── Track ─────────────────────────────────────────────────────────────────
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

        prevGray.delete();
        prevGray = currGray;
        prevPoints.delete();
        prevPoints = currPoints.clone();

        self.postMessage({
          type: 'tracked',
          payload: { x, y, tracked: true, videoTimestamp: payload.videoTimestamp },
        });
      } else {
        prevGray.delete();
        prevGray = currGray;

        self.postMessage({
          type: 'tracked',
          payload: { x: 0, y: 0, tracked: false, videoTimestamp: payload.videoTimestamp },
        });
      }
    } catch (e) {
      try { currGray.delete(); } catch (_) {}
      self.postMessage({
        type: 'tracked',
        payload: { x: 0, y: 0, tracked: false, videoTimestamp: payload.videoTimestamp },
      });
    } finally {
      try { currPoints.delete(); } catch (_) {}
      try { status.delete(); }     catch (_) {}
      try { err.delete(); }        catch (_) {}
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  if (type === 'reset') {
    try { if (prevGray)   prevGray.delete();   } catch (_) {}
    try { if (prevPoints) prevPoints.delete(); } catch (_) {}
    prevGray   = null;
    prevPoints = null;
    isReady    = false;
    self.postMessage({ type: 'reset_ok' });
  }
};
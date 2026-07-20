// workers/tracker.worker.ts

// eslint-disable-next-line @typescript-eslint/no-require-imports
import cv from '@techstark/opencv-js';

// Tell TypeScript to treat cv as any since types are incomplete
declare const _cv: typeof cv;

let prevGray:   any = null;
let prevPoints: any = null;
let isReady  = false;
let cvReady  = false;

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
    // Queue message until ready
    setTimeout(() => self.dispatchEvent(new MessageEvent('message', { data: e.data })), 100);
    return;
  }

  const { type, payload } = e.data;

  // ── Seed ─────────────────────────────────────────────────────────────────
  if (type === 'seed') {
    try {
      if (prevGray)   { prevGray.delete();   prevGray   = null; }
      if (prevPoints) { prevPoints.delete(); prevPoints = null; }

      prevGray   = imageDataToGray(payload.imageData);
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
    const currGray  = imageDataToGray(payload.imageData);
    const currPoints = new cv.Mat();
    const status    = new cv.Mat();
    const err       = new cv.Mat();

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
        new cv.TermCriteria(
          cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT,
          30,
          0.01
        ),
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
      currGray.delete();
      self.postMessage({
        type: 'tracked',
        payload: { x: 0, y: 0, tracked: false, videoTimestamp: payload.videoTimestamp },
      });
    } finally {
      currPoints.delete();
      status.delete();
      err.delete();
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  if (type === 'reset') {
    if (prevGray)   { prevGray.delete();   prevGray   = null; }
    if (prevPoints) { prevPoints.delete(); prevPoints = null; }
    isReady = false;
    self.postMessage({ type: 'reset_ok' });
  }
};
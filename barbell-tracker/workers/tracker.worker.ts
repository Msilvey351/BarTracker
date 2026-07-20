// workers/tracker.worker.ts

// eslint-disable-next-line @typescript-eslint/no-require-imports
import cv from '@techstark/opencv-js';

let prevGray:   any = null;
let prevPoints: any = null;
let isReady  = false;
let cvReady  = false;

// TERM_CRITERIA constants — use numeric values directly to avoid TS errors
const TERM_CRITERIA_EPS   = 0x01;
const TERM_CRITERIA_COUNT = 0x02;
const TERM_CRITERIA_BOTH  = TERM_CRITERIA_EPS | TERM_CRITERIA_COUNT;

cv.onRuntimeInitialized = () => {
  cvReady = true;
  self.postMessage({ type: 'ready' });
};

function imageDataToGray(imageData: ImageData): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rgba = (cv as any).matFromImageData(imageData);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gray = new (cv as any).Mat();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cv as any).cvtColor(rgba, gray, (cv as any).COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

self.onmessage = (e: MessageEvent) => {
  if (!cvReady) {
    setTimeout(() => self.dispatchEvent(new MessageEvent('message', { data: e.data })), 100);
    return;
  }

  const { type, payload } = e.data;
  // Use cv as any throughout to bypass TypeScript type checking
  const CV = cv as any;

  // ── Seed ─────────────────────────────────────────────────────────────────
  if (type === 'seed') {
    try {
      if (prevGray)   { prevGray.delete();   prevGray   = null; }
      if (prevPoints) { prevPoints.delete(); prevPoints = null; }

      prevGray        = imageDataToGray(payload.imageData);
      prevPoints      = new CV.Mat(1, 1, CV.CV_32FC2);
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
    const currPoints = new CV.Mat();
    const status     = new CV.Mat();
    const err        = new CV.Mat();

    try {
      CV.calcOpticalFlowPyrLK(
        prevGray,
        currGray,
        prevPoints,
        currPoints,
        status,
        err,
        new CV.Size(21, 21),           // window size
        3,                             // max pyramid level
        new CV.TermCriteria(
          TERM_CRITERIA_BOTH,          // ← numeric constant, no TS error
          30,                          // max iterations
          0.01                         // epsilon
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
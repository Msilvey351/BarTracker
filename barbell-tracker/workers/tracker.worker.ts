// @ts-nocheck
// workers/tracker.worker.ts

let cv: any = null;
let prevGray:   any = null;
let prevPoints: any = null;
let isReady  = false;
let cvReady  = false;

const TERM_CRITERIA_EPS   = 0x01;
const TERM_CRITERIA_COUNT = 0x02;
const TERM_CRITERIA_BOTH  = TERM_CRITERIA_EPS | TERM_CRITERIA_COUNT;

// ── Load OpenCV ───────────────────────────────────────────────────────────────
try {
  console.log('[tracker.worker] Loading opencv.js...');
  importScripts('/opencv.js');
  console.log('[tracker.worker] importScripts completed');
  console.log('[tracker.worker] self.cv exists:', typeof self.cv);

  cv = self.cv;

  if (!cv) {
    throw new Error('cv is undefined after importScripts');
  }

  // cv may already be initialised or may need to wait
  if (cv.Mat) {
    // Already ready
    console.log('[tracker.worker] OpenCV already initialised');
    cvReady = true;
    self.postMessage({ type: 'ready' });
  } else if (typeof cv.onRuntimeInitialized !== 'undefined') {
    console.log('[tracker.worker] Waiting for onRuntimeInitialized...');
    cv.onRuntimeInitialized = () => {
      console.log('[tracker.worker] OpenCV initialised!');
      cvReady = true;
      self.postMessage({ type: 'ready' });
    };
  } else {
    // Poll for readiness as fallback
    console.log('[tracker.worker] Polling for cv.Mat...');
    const poll = setInterval(() => {
      if (cv && cv.Mat) {
        console.log('[tracker.worker] OpenCV ready via polling');
        clearInterval(poll);
        cvReady = true;
        self.postMessage({ type: 'ready' });
      }
    }, 100);

    // Timeout after 30s
    setTimeout(() => {
      if (!cvReady) {
        clearInterval(poll);
        console.error('[tracker.worker] OpenCV timed out after 30s');
        self.postMessage({ type: 'error', payload: 'OpenCV load timeout' });
      }
    }, 30000);
  }

} catch (err) {
  console.error('[tracker.worker] Failed to load opencv:', err);
  self.postMessage({ type: 'error', payload: `Failed to load OpenCV: ${String(err)}` });
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

  if (type === 'reset') {
    try { if (prevGray)   prevGray.delete();   } catch (_) {}
    try { if (prevPoints) prevPoints.delete(); } catch (_) {}
    prevGray   = null;
    prevPoints = null;
    isReady    = false;
    self.postMessage({ type: 'reset_ok' });
  }
};
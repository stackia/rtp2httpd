import Log from "../mpegts/utils/logger";

const TAG = "InterlaceDetector";

/**
 * Heuristic interlace detection — no reliance on stream metadata.
 *
 * Interlaced content decoded as weaved frames shows "combing": on rows where the
 * two fields captured different moments, a pixel deviates from both its vertical
 * neighbors in the same direction. We periodically sample the video into a small
 * offscreen canvas (horizontal downscale only — vertical scaling would destroy
 * the comb signal), compute a per-frame comb score on luma, and feed a rolling
 * window. Enough combed frames in the window → verdict "interlaced".
 *
 * Static scenes produce no combing even in interlaced streams, so absence of
 * combing is NOT evidence of progressive content: once interlaced is decided the
 * verdict is sticky until reset() (channel/source/resolution change).
 */

/** Only 1080-class content is eligible; above 1080 deinterlacing is never enabled. */
const GATE_MAX_WIDTH = 1920;
const GATE_HEIGHTS = new Set([1080, 1088]);

/** Sampling width — horizontal resolution barely matters for comb detection. */
const SAMPLE_WIDTH = 256;
/** How often to sample a frame for analysis. */
const SAMPLE_INTERVAL_MS = 500;
/**
 * Per-pixel comb test: (above - cur) * (below - cur) > threshold, on 0-255 luma.
 * Both neighbors deviating in the same direction by ~11+ levels marks a comb pixel.
 */
const COMB_PIXEL_THRESHOLD = 121;
/** Fraction of comb pixels for a frame to count as combed. */
const COMBED_FRAME_RATIO = 0.02;
/** Rolling window: this many combed frames out of WINDOW_SIZE → interlaced. */
const WINDOW_SIZE = 12;
const COMBED_FRAMES_REQUIRED = 3;

export interface DetectorVerdict {
  interlaced: boolean;
  /** Algorithm the detector recommends; extension point for future heuristics. */
  algorithm: "bob";
}

/**
 * Comb metric on a grayscale (luma) plane. Exposed for testing.
 * Returns the fraction of pixels flagged as combed.
 */
export function combScore(luma: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  if (height < 3) return 0;
  let combed = 0;
  const total = width * (height - 2);
  for (let y = 1; y < height - 1; y++) {
    const rowAbove = (y - 1) * width;
    const row = y * width;
    const rowBelow = (y + 1) * width;
    for (let x = 0; x < width; x++) {
      const cur = luma[row + x];
      const dAbove = luma[rowAbove + x] - cur;
      const dBelow = luma[rowBelow + x] - cur;
      if (dAbove * dBelow > COMB_PIXEL_THRESHOLD) {
        combed++;
      }
    }
  }
  return combed / total;
}

export class InterlaceDetector {
  private readonly video: HTMLVideoElement;
  private readonly onVerdict: (verdict: DetectorVerdict) => void;
  private sampleCanvas: HTMLCanvasElement | null = null;
  private sampleCtx: CanvasRenderingContext2D | null = null;
  private timer = 0;
  private window: boolean[] = [];
  private interlaced = false;
  private gated = false;

  constructor(video: HTMLVideoElement, onVerdict: (verdict: DetectorVerdict) => void) {
    this.video = video;
    this.onVerdict = onVerdict;
  }

  start(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
  }

  /** Forget everything — call on channel/source switch or resolution change. */
  reset(): void {
    this.window = [];
    if (this.interlaced) {
      this.interlaced = false;
      this.onVerdict({ interlaced: false, algorithm: "bob" });
    }
    this.gated = false;
  }

  destroy(): void {
    this.stop();
    this.sampleCanvas = null;
    this.sampleCtx = null;
  }

  private resolutionEligible(width: number, height: number): boolean {
    return width > 0 && width <= GATE_MAX_WIDTH && GATE_HEIGHTS.has(height);
  }

  private sample(): void {
    const video = this.video;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.seeking) return;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!this.resolutionEligible(width, height)) {
      if (!this.gated && width > 0) {
        this.gated = true;
        Log.d(TAG, `Resolution ${width}x${height} not eligible for deinterlacing`);
      }
      // Resolution may have changed mid-stream (e.g. codec change) — drop any verdict
      if (this.interlaced || this.window.length) this.reset();
      return;
    }
    this.gated = false;

    // Sticky verdict: once interlaced, stay until reset()
    if (this.interlaced) return;

    if (!this.sampleCtx) {
      this.sampleCanvas = document.createElement("canvas");
      this.sampleCtx = this.sampleCanvas.getContext("2d", { willReadFrequently: true, alpha: false });
      if (!this.sampleCtx) {
        Log.e(TAG, "2D sampling context unavailable; detector disabled");
        this.stop();
        return;
      }
    }
    const canvas = this.sampleCanvas as HTMLCanvasElement;
    // Downscale horizontally only; vertical must stay 1:1 to preserve combing
    if (canvas.width !== SAMPLE_WIDTH || canvas.height !== height) {
      canvas.width = SAMPLE_WIDTH;
      canvas.height = height;
    }

    let imageData: ImageData;
    try {
      this.sampleCtx.drawImage(video, 0, 0, SAMPLE_WIDTH, height);
      imageData = this.sampleCtx.getImageData(0, 0, SAMPLE_WIDTH, height);
    } catch (err) {
      // drawImage can throw while the pipeline is in a transient bad state
      Log.d(TAG, "Frame sampling failed:", err);
      return;
    }

    const rgba = imageData.data;
    const luma = new Uint8Array(SAMPLE_WIDTH * height);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      // BT.601 integer luma approximation
      luma[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
    }

    const score = combScore(luma, SAMPLE_WIDTH, height);
    this.window.push(score >= COMBED_FRAME_RATIO);
    if (this.window.length > WINDOW_SIZE) this.window.shift();

    const combedFrames = this.window.filter(Boolean).length;
    if (combedFrames >= COMBED_FRAMES_REQUIRED) {
      this.interlaced = true;
      Log.i(TAG, `Interlaced content detected (${combedFrames}/${this.window.length} combed frames)`);
      this.onVerdict({ interlaced: true, algorithm: "bob" });
    }
  }
}

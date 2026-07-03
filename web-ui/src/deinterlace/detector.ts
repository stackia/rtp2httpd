import Log from "../mpegts/utils/logger";
import type { FieldOrder } from "./renderer";

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
/**
 * Fraction of comb pixels for a frame to count as combed. Measured in-browser:
 * weaved interlaced frames with motion score 0.018-0.022, progressive frames
 * with equivalent motion 0.004-0.005 — 0.01 splits the two populations with
 * margin on both sides.
 */
const COMBED_FRAME_RATIO = 0.01;
/** Rolling window: this many combed frames out of WINDOW_SIZE → interlaced. */
const WINDOW_SIZE = 12;
const COMBED_FRAMES_REQUIRED = 3;
/**
 * Field-order votes needed before emitting a verdict, and the minimum margin
 * (winner votes minus loser votes) for the answer to be trusted; on a tie or
 * thin margin we keep voting and fall back to TFF (the broadcast norm).
 */
const FIELD_ORDER_MIN_VOTES = 4;
const FIELD_ORDER_MIN_MARGIN = 2;
const FIELD_ORDER_MAX_VOTES = 10;

export interface DetectorVerdict {
  interlaced: boolean;
  /**
   * Algorithm the detector recommends; extension point for future heuristics
   * (e.g. telecine patterns → different algorithms).
   */
  algorithm: "bwdif";
  /** Detected field order (falls back to TFF, the broadcast norm, on a tie). */
  fieldOrder: FieldOrder;
}

/**
 * Field-order vote from two consecutive weaved frames. Exposed for testing.
 *
 * For each field F of frame N there are two candidate temporal positions,
 * depending on field order. Under the correct hypothesis, each field is the
 * temporal midpoint of its neighboring opposite-parity fields, so interpolating
 * it from those neighbors yields a smaller error than under the wrong
 * hypothesis (where the "neighbors" are 3 field-times away in one direction).
 *
 * Concretely, comparing the bottom field of frame N against the top fields of
 * frames N-1 and N:
 *   TFF: bottom(N) sits between top(N) and top(N+1) → closer to top(N)
 *   BFF: bottom(N) sits between top(N-1) and top(N) → also closest to top(N)
 * so the discriminating comparisons span two frames (prev, cur):
 *   TFF time order: T(p), B(p), T(c), B(c) → B(p) is the midpoint of T(p), T(c)
 *   BFF time order: B(p), T(p), B(c), T(c) → T(p) is the midpoint of B(p), B(c)
 * Each hypothesis predicts its midpoint field by spatio-temporally averaging
 * the four surrounding samples; the wrong hypothesis averages fields that are
 * two field-times away, so with motion its error is systematically larger.
 * Returns "tff", "bff", or undefined when there is not enough motion to tell.
 */
export function fieldOrderVote(
  prevLuma: Uint8Array,
  curLuma: Uint8Array,
  width: number,
  height: number,
): FieldOrder | undefined {
  let errTff = 0;
  let errBff = 0;
  // Walk output rows in pairs; y is even (top-field row), y±1 odd (bottom-field rows)
  for (let y = 2; y + 2 < height; y += 2) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tPrev = prevLuma[i];
      const tPrevBelow = prevLuma[i + 2 * width];
      const tCur = curLuma[i];
      const tCurBelow = curLuma[i + 2 * width];
      const bPrevAbove = prevLuma[i - width];
      const bPrev = prevLuma[i + width];
      const bCurAbove = curLuma[i - width];
      const bCur = curLuma[i + width];

      // TFF: B(p) row y+1 is the temporal midpoint of T(p) and T(c); predict it
      // from their rows y and y+2
      errTff += Math.abs(bPrev - (tPrev + tPrevBelow + tCur + tCurBelow) / 4);
      // BFF: T(p) row y is the temporal midpoint of B(p) and B(c); predict it
      // from their rows y-1 and y+1
      errBff += Math.abs(tPrev - (bPrevAbove + bPrev + bCurAbove + bCur) / 4);
    }
  }
  const samples = width * Math.floor((height - 4) / 2);
  if (samples <= 0) return undefined;
  // Not enough temporal activity to discriminate (thresholds on 0-255 luma)
  if ((errTff + errBff) / samples < 1.0) return undefined;
  // Require a clear separation, otherwise abstain
  if (errTff < errBff * 0.9) return "tff";
  if (errBff < errTff * 0.9) return "bff";
  return undefined;
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
  private fieldOrder: FieldOrder = "tff";
  private fieldOrderDecided = false;
  private votesTff = 0;
  private votesBff = 0;
  private votingRounds = 0;
  /** Invalidates in-flight rVFC vote captures across reset/stop. */
  private voteGen = 0;

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
    this.voteGen++;
  }

  /** Forget everything — call on channel/source switch or resolution change. */
  reset(): void {
    this.window = [];
    if (this.interlaced) {
      this.interlaced = false;
      this.onVerdict({ interlaced: false, algorithm: "bwdif", fieldOrder: "tff" });
    }
    this.gated = false;
    this.fieldOrder = "tff";
    this.fieldOrderDecided = false;
    this.votesTff = 0;
    this.votesBff = 0;
    this.votingRounds = 0;
    this.voteGen++;
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
      // Activate immediately with the TFF default; field-order voting continues
      // in the background and re-emits if the source turns out to be BFF.
      this.onVerdict({ interlaced: true, algorithm: "bwdif", fieldOrder: this.fieldOrder });
      this.scheduleFieldOrderVote();
    }
  }

  private grabLuma(width: number, height: number): Uint8Array | null {
    const ctx = this.sampleCtx;
    const canvas = this.sampleCanvas;
    if (!ctx || !canvas) return null;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    try {
      ctx.drawImage(this.video, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const luma = new Uint8Array(width * height);
      for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
        luma[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
      }
      return luma;
    } catch {
      return null;
    }
  }

  /**
   * One voting round: capture the current frame and the next presented frame
   * (consecutive frames via rVFC — the interval sampler cannot guarantee
   * adjacency), then compare field-order hypotheses on the pair.
   */
  private scheduleFieldOrderVote(): void {
    if (this.fieldOrderDecided || this.votingRounds >= FIELD_ORDER_MAX_VOTES) return;
    const gen = this.voteGen;
    const video = this.video;
    const height = video.videoHeight;
    if (!height || !this.resolutionEligible(video.videoWidth, height)) return;

    const prevLuma = this.grabLuma(SAMPLE_WIDTH, height);
    if (!prevLuma) return;

    video.requestVideoFrameCallback(() => {
      if (gen !== this.voteGen) return;
      const curLuma = this.grabLuma(SAMPLE_WIDTH, video.videoHeight);
      if (curLuma && curLuma.length === prevLuma.length) {
        this.votingRounds++;
        const vote = fieldOrderVote(prevLuma, curLuma, SAMPLE_WIDTH, video.videoHeight);
        if (vote === "tff") this.votesTff++;
        else if (vote === "bff") this.votesBff++;
        this.maybeDecideFieldOrder();
      }
      if (!this.fieldOrderDecided && this.votingRounds < FIELD_ORDER_MAX_VOTES) {
        // Space rounds out; consecutive-pair capture is relatively expensive
        window.setTimeout(() => {
          if (gen === this.voteGen) this.scheduleFieldOrderVote();
        }, SAMPLE_INTERVAL_MS);
      }
    });
  }

  private maybeDecideFieldOrder(): void {
    const votesTff = this.votesTff;
    const votesBff = this.votesBff;
    const total = votesTff + votesBff;
    const margin = Math.abs(votesTff - votesBff);
    const exhausted = this.votingRounds >= FIELD_ORDER_MAX_VOTES;
    if (total < FIELD_ORDER_MIN_VOTES && !exhausted) return;
    if (margin < FIELD_ORDER_MIN_MARGIN && !exhausted) return;

    this.fieldOrderDecided = true;
    const winner: FieldOrder = margin >= FIELD_ORDER_MIN_MARGIN && votesBff > votesTff ? "bff" : "tff";
    Log.i(TAG, `Field order: ${winner} (tff=${votesTff}, bff=${votesBff}, rounds=${this.votingRounds})`);
    if (winner !== this.fieldOrder) {
      this.fieldOrder = winner;
      if (this.interlaced) {
        this.onVerdict({ interlaced: true, algorithm: "bwdif", fieldOrder: winner });
      }
    }
  }
}

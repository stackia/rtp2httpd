import "./algorithms/bwdif";
import Log from "../utils/logger";
import { type DetectorVerdict, InterlaceDetector } from "./detector";
import { DeinterlaceRenderer, type FieldOrder } from "./renderer";

const TAG = "DeinterlacePipeline";

export interface DeinterlacePipeline {
  setEnabled(enabled: boolean): void;
  /** Forget the detection verdict — call on channel/source switch. */
  reset(): void;
  /** True while the deinterlaced canvas is being drawn (drive UI visibility from this). */
  readonly active: boolean;
  destroy(): void;
}

export function isDeinterlaceSupported(): boolean {
  return DeinterlaceRenderer.isSupported();
}

/**
 * Wires the heuristic detector to the WebGL renderer for one video/canvas pair.
 * When enabled the detector decides when combing appears and which algorithm to use;
 * disabled stops both.
 *
 * Detection runs in GPU mode whenever the renderer's GL context is available:
 * the detector borrows the texture ring uploaded by the renderer, runs marker +
 * reduction shader passes, and retrieves the result via a PBO the following
 * sample cycle (500 ms later).  Before the renderer starts (initial progressive
 * channel scan), detection falls back to the Canvas 2D CPU path automatically.
 */
export function createDeinterlacePipeline(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onActiveChange?: (active: boolean) => void,
): DeinterlacePipeline {
  let enabled = true;
  let active = false;
  /**
   * True while the renderer has been started but the first canvas frame has not
   * yet been drawn. During this window we keep the raw video visible (no opacity-0)
   * so there is no black flash between the deinterlace verdict arriving and the
   * first WebGL frame being painted.
   */
  let pendingFirstFrame = false;
  let destroyed = false;
  let lastVerdict: DetectorVerdict | null = null;

  // ---- GPU detection cadence state ----
  // Tracks when the last GPU sample was issued so we can enforce the 500 ms
  // steady-state interval without a separate setInterval.
  let lastGpuSampleMs = -Infinity;
  /** Counts frames sampled in the fast phase (first 3 after start/reset). */
  let gpuFastPhaseSamples = 0;
  const GPU_FAST_SAMPLE_COUNT = 3;
  const GPU_SAMPLE_INTERVAL_MS = 500;

  const resetGpuCadence = () => {
    lastGpuSampleMs = -Infinity;
    gpuFastPhaseSamples = 0;
  };

  const notifyFirstFrameRendered = () => {
    if (!pendingFirstFrame || !enabled || destroyed) return;
    pendingFirstFrame = false;
    if (!active) {
      active = true;
      onActiveChange?.(true);
    }
  };

  const renderer = new DeinterlaceRenderer(
    video,
    canvas,
    notifyFirstFrameRendered,
    // Context lost: reveal raw video; notify detector to fall back to CPU path
    () => {
      if (destroyed) return;
      detector.onGlContextLost();
      if (!active) return;
      pendingFirstFrame = false;
      active = false;
      onActiveChange?.(false);
    },
    // Context restored: rebuild renderer state then re-activate GPU detection
    () => {
      if (destroyed) return;
      Log.i(TAG, "WebGL context restored; re-establishing deinterlace pipeline");
      apply();
    },
  );

  // Wire the per-frame GPU detection hook.  This is set once and stays for the
  // lifetime of the renderer; sampleGpu/readPendingGpu are no-ops unless the
  // detector is in GPU mode (i.e. initGl has been called).
  renderer.onDetectionFrame = (gl, curTexture, prevTexture, videoWidth, videoHeight) => {
    if (destroyed) return;

    // Retrieve the result from the previous non-blocking PBO readback first so
    // metrics are processed before issuing the next sample.
    const pendingMetrics = detector.readPendingGpu(gl);
    if (pendingMetrics !== null) {
      detector.processSampleMetrics(pendingMetrics);
    }

    const now = performance.now();
    const isFastPhase = gpuFastPhaseSamples < GPU_FAST_SAMPLE_COUNT;
    const isIntervalDue = now - lastGpuSampleMs >= GPU_SAMPLE_INTERVAL_MS;
    if (!isFastPhase && !isIntervalDue) return;

    detector.sampleGpu(gl, curTexture, prevTexture, videoWidth, videoHeight, isFastPhase);
    lastGpuSampleMs = now;
    if (isFastPhase) gpuFastPhaseSamples++;
  };

  const setActive = (next: boolean, algorithm: string, fieldOrder: FieldOrder = "tff") => {
    if (destroyed) return;
    if (next) {
      pendingFirstFrame = true;
      if (!renderer.start(algorithm, fieldOrder)) {
        // WebGL unavailable or algorithm init failed — leave raw video visible
        pendingFirstFrame = false;
        return;
      }
      // The renderer just created (or reused) a GL context.  Hand it to the
      // detector so GPU detection can replace the CPU path going forward.
      const gl = renderer.currentGl;
      if (gl) {
        detector.initGl(gl);
        resetGpuCadence();
      }
    } else {
      pendingFirstFrame = false;
      renderer.stop();
      if (active) {
        active = false;
        onActiveChange?.(false);
      }
    }
  };

  const detector = new InterlaceDetector(video, (verdict) => {
    lastVerdict = verdict;
    if (enabled) {
      setActive(verdict.interlaced, verdict.algorithm, verdict.fieldOrder);
    }
  });

  const apply = () => {
    if (enabled) {
      setActive(lastVerdict?.interlaced === true, lastVerdict?.algorithm ?? "bwdif", lastVerdict?.fieldOrder ?? "tff");
      detector.start();
      // If the renderer already has a context (e.g. after context restore),
      // activate GPU detection immediately without waiting for a new verdict.
      const gl = renderer.currentGl;
      if (gl) {
        detector.onGlContextRestored(gl);
        resetGpuCadence();
      }
    } else {
      detector.stop();
      setActive(false, "bwdif");
    }
  };

  if (!DeinterlaceRenderer.isSupported()) {
    Log.i(TAG, "requestVideoFrameCallback unavailable; deinterlacing disabled");
    return {
      setEnabled() {},
      reset() {},
      get active() {
        return false;
      },
      destroy() {},
    };
  }

  apply();

  return {
    setEnabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      apply();
    },
    reset() {
      lastVerdict = null;
      resetGpuCadence();
      detector.reset();
      if (enabled) setActive(false, "bwdif");
    },
    get active() {
      return active;
    },
    destroy() {
      destroyed = true;
      const gl = renderer.currentGl;
      if (gl) detector.destroyGl(gl);
      detector.destroy();
      renderer.destroy();
    },
  };
}

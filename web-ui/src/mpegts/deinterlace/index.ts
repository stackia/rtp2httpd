import "./algorithms/bwdif";
import Log from "../utils/logger";
import { type DetectorVerdict, InterlaceDetector, isResolutionEligible } from "./detector";
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

/** Frames sampled back-to-back right after start/reset, before the steady interval kicks in. */
const FAST_SAMPLE_COUNT = 3;
/** Steady-state gap between detection samples. Also guarantees the PBO readback never stalls. */
const SAMPLE_INTERVAL_MS = 500;

/**
 * Wires the GPU interlace detector to the WebGL renderer for one video/canvas pair.
 *
 * Resource discipline: the whole GPU chain (frame uploads, bwdif pass, detection
 * shaders) only runs for frame sizes within the SD/HD deinterlacing gate. A
 * stream's resolution is assumed constant, so the gate is evaluated once the size
 * is known (the video element's `resize` event) and never polled per frame; the
 * renderer additionally skips any transiently oversized frame that presents
 * before the resize event lands. Larger frames run no algorithm at all — the
 * raw video simply plays.
 *
 * Within the gate the verdict drives two modes. While the content is deemed
 * progressive the renderer stays in detection-only mode: frames are uploaded
 * and analysed only on the sampling cadence (first frames back-to-back, then
 * every 500 ms) and nothing is drawn — the raw video stays visible and the GPU
 * is idle between samples. When the detector declares the source interlaced the
 * renderer switches to full mode (per-frame uploads, field-rate bwdif onto the
 * canvas) and the canvas is revealed (active = true); a later progressive
 * verdict reverts both.
 */
export function createDeinterlacePipeline(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onActiveChange?: (active: boolean) => void,
): DeinterlacePipeline {
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

  let enabled = true;
  let active = false;
  let destroyed = false;
  /** True while the full GPU chain (renderer + detector) is running. */
  let gpuRunning = false;
  /** Latest verdict; drives canvas visibility and the renderer's field order. */
  let interlaced = false;
  let fieldOrder: FieldOrder = "tff";

  // ---- Detection cadence ----
  // The renderer's per-frame hook enforces the sampling schedule without a
  // separate timer: the first few frames sample back-to-back, then every 500 ms.
  let lastSampleMs = -Infinity;
  let fastPhaseSamples = 0;

  const resetCadence = () => {
    lastSampleMs = -Infinity;
    fastPhaseSamples = 0;
  };

  const setActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    onActiveChange?.(next);
  };

  // The source size is only known once the video element reports it. `resize`
  // fires on first metadata and on any later change, so it is the single trigger
  // for (re)evaluating the resolution gate — no per-frame polling.
  const handleVideoResize = () => {
    if (destroyed) return;
    apply();
  };
  video.addEventListener("resize", handleVideoResize);

  const renderer = new DeinterlaceRenderer(
    video,
    canvas,
    // Context lost: hide the canvas and tell the detector its resources are gone.
    () => {
      if (destroyed) return;
      detector.onGlContextLost();
      gpuRunning = false;
      setActive(false);
    },
    // Context restored: rebuild the pipeline from the last known verdict.
    () => {
      if (destroyed) return;
      Log.i(TAG, "WebGL context restored; re-establishing deinterlace pipeline");
      apply();
    },
  );

  // Per-frame hooks, set once for the renderer's lifetime. onFrame drains
  // pending async readbacks and decides whether this frame should be sampled;
  // onSample issues the detection passes against the uploaded texture.
  renderer.onFrame = (gl) => {
    if (destroyed) return false;
    detector.poll(gl);

    const now = performance.now();
    const isFastPhase = fastPhaseSamples < FAST_SAMPLE_COUNT;
    // While field-order voting is open, sample every frame: votes need real
    // inter-frame motion, and at one vote per steady interval a decision would
    // take seconds. In this state the renderer uploads per frame anyway.
    if (!isFastPhase && !detector.fieldOrderVotingActive && now - lastSampleMs < SAMPLE_INTERVAL_MS) return false;
    return true;
  };

  renderer.onSample = (gl, curTexture, prevTexture, videoWidth, videoHeight) => {
    if (destroyed) return;
    detector.sample(gl, curTexture, prevTexture, videoWidth, videoHeight);
    lastSampleMs = performance.now();
    if (fastPhaseSamples < FAST_SAMPLE_COUNT) fastPhaseSamples++;
  };

  const detector = new InterlaceDetector((verdict: DetectorVerdict) => {
    interlaced = verdict.interlaced;
    fieldOrder = verdict.fieldOrder;
    if (destroyed || !enabled) return;
    // Keep the renderer's field order in sync, switch render mode, then
    // reveal or hide the canvas.
    renderer.setFieldOrder(fieldOrder);
    renderer.setRenderingEnabled(interlaced);
    setActive(interlaced);
  });

  const startGpuChain = () => {
    if (gpuRunning || destroyed || !enabled) return;

    if (!renderer.start("bwdif", fieldOrder)) {
      // WebGL unavailable or algorithm init failed — leave raw video visible.
      setActive(false);
      return;
    }
    const gl = renderer.currentGl;
    if (!gl || !detector.initGl(gl)) {
      // Detection cannot run on this context; don't burn GPU on an output that
      // can never be revealed.
      renderer.stop();
      setActive(false);
      return;
    }
    gpuRunning = true;
    resetCadence();
    detector.start();
    // Restore the mode implied by the last verdict (e.g. context restore or
    // re-enable while a stream was already deemed interlaced).
    renderer.setRenderingEnabled(interlaced);
    setActive(interlaced);
  };

  const stopGpuChain = () => {
    if (!gpuRunning) return;
    gpuRunning = false;
    detector.stop();
    renderer.stop();
    setActive(false);
  };

  /**
   * Bring the pipeline into the state implied by `enabled` and the source size.
   * The GPU chain starts only once the size is known and within the gate, so
   * oversized streams never run any algorithm. Called on enable toggle, reset,
   * context restore, and every `resize` event.
   */
  const apply = () => {
    const eligible =
      video.videoWidth > 0 && video.videoHeight > 0 && isResolutionEligible(video.videoWidth, video.videoHeight);
    if (enabled && eligible) {
      startGpuChain();
    } else {
      stopGpuChain();
    }
  };

  apply();

  return {
    setEnabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      apply();
    },
    reset() {
      interlaced = false;
      fieldOrder = "tff";
      resetCadence();
      detector.reset();
      // Back to detection-only until the new source earns an interlaced verdict.
      renderer.setFieldOrder(fieldOrder);
      renderer.setRenderingEnabled(false);
      setActive(false);
      // Re-evaluate against the (possibly new) source resolution.
      apply();
    },
    get active() {
      return active;
    },
    destroy() {
      destroyed = true;
      video.removeEventListener("resize", handleVideoResize);
      const gl = renderer.currentGl;
      if (gl) detector.destroyGl(gl);
      renderer.destroy();
    },
  };
}

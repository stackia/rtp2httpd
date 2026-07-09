import "./filters/bwdif";
import Log from "../utils/logger";
import { type DetectorVerdict, InterlaceDetector, isRenderResolutionEligible } from "./interlace-detector";
import { type FieldOrder, type RenderStageName, VideoRenderer } from "./renderer";

const TAG = "VideoRenderPipeline";

export interface VideoRenderPipeline {
  setAutoDeinterlaceEnabled(enabled: boolean): void;
  setPictureEnhancementEnabled(enabled: boolean): void;
  /**
   * Optional codec-level interlace hint from demuxer SPS/VUI metadata.
   * Used only to accelerate detection cadence; the GPU heuristic remains authoritative.
   */
  setMayBeInterlacedHint(mayBeInterlaced: boolean | null): void;
  /** Forget the detection verdict; call on channel/source switch. */
  reset(): void;
  /** True while the WebGL canvas is the visible video output. */
  readonly active: boolean;
  destroy(): void;
}

export function isVideoRenderSupported(): boolean {
  return VideoRenderer.isSupported();
}

/** Frames sampled back-to-back right after start/reset, before the steady interval kicks in. */
const FAST_SAMPLE_COUNT = 3;
/** Steady-state gap between detection samples when content may be interlaced. */
const SAMPLE_INTERVAL_MS = 500;
/**
 * After the source has been confidently progressive for a while, sample less often.
 * Detection still runs (so a mid-stream interlaced switch can be caught), but the
 * GPU marker/reduction chain is no longer a steady ~2 Hz tax on mobile SoCs.
 */
const PROGRESSIVE_SAMPLE_INTERVAL_MS = 2000;
/** Consecutive progressive verdicts before switching to the slow sample cadence. */
const PROGRESSIVE_CONFIDENCE_SAMPLES = 6;

/**
 * Wires the GPU interlace detector to the WebGL renderer for one video/canvas pair.
 *
 * The renderer runs only while the decoded frame size is inside the SD/HD render
 * gate AND at least one of auto deinterlacing / picture enhancement is enabled —
 * with both off the pipeline would only reproduce the raw video, so it is skipped
 * like an ineligible resolution.
 *
 * When auto deinterlace is on but the source is progressive (and picture
 * enhancement is off), the pipeline stays in a **detect-only** mode: frames are
 * still uploaded for the GPU heuristic, but the canvas is not the visible output
 * (`active = false`). That avoids a continuous texImage2D + present path on the
 * common progressive-IPTV case while still allowing the detector to flip to bwdif
 * when combing appears. Eligible interlaced frames switch to bwdif; picture
 * enhancement keeps the canvas path active even for progressive sources.
 * Larger frames, both features disabled, WebGL failures, or missing rVFC support
 * all fall back to the raw video element by reporting active = false.
 */
export function createVideoRenderPipeline(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onActiveChange?: (active: boolean) => void,
): VideoRenderPipeline {
  if (!VideoRenderer.isSupported()) {
    Log.i(TAG, "requestVideoFrameCallback unavailable; WebGL video rendering disabled");
    return {
      setAutoDeinterlaceEnabled() {},
      setPictureEnhancementEnabled() {},
      setMayBeInterlacedHint() {},
      reset() {},
      get active() {
        return false;
      },
      destroy() {},
    };
  }

  let autoDeinterlaceEnabled = true;
  let pictureEnhancementEnabled = true;
  let active = false;
  let destroyed = false;
  let renderRunning = false;
  let detectorReady = false;
  let detectorRunning = false;
  let interlaced = false;
  let fieldOrder: FieldOrder = "tff";
  let lastEligibility: boolean | null = null;
  /** Codec metadata hint; null means unknown / not yet received. */
  let mayBeInterlacedHint: boolean | null = null;
  let progressiveConfidence = 0;

  let lastSampleMs = -Infinity;
  let fastPhaseSamples = 0;

  const resetCadence = () => {
    lastSampleMs = -Infinity;
    fastPhaseSamples = 0;
    progressiveConfidence = 0;
  };

  const setActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    onActiveChange?.(next);
  };

  /**
   * Canvas must be the visible output when we are actually transforming pixels
   * (bwdif and/or picture enhancement). Pure detection on progressive content
   * keeps the raw <video> visible to avoid a continuous GPU present path.
   */
  const canvasShouldBeVisible = (): boolean =>
    renderRunning && ((autoDeinterlaceEnabled && interlaced) || pictureEnhancementEnabled);

  /** Detect-only: upload + sample, skip canvas present / FSR / second-field work. */
  const detectOnlyMode = (): boolean =>
    autoDeinterlaceEnabled && !interlaced && !pictureEnhancementEnabled && renderRunning;

  const desiredStage = (): RenderStageName => (autoDeinterlaceEnabled && interlaced ? "bwdif" : "passthrough");

  const formatVideoSize = () =>
    video.videoWidth > 0 && video.videoHeight > 0 ? `${video.videoWidth}x${video.videoHeight}` : "unknown";

  const sampleIntervalMs = (): number => {
    // Codec says interlaced, or we have not yet built progressive confidence: keep the
    // responsive cadence so field-order voting and first-comb detection stay snappy.
    if (mayBeInterlacedHint === true || interlaced) {
      return SAMPLE_INTERVAL_MS;
    }
    // Codec metadata says progressive: trust it sooner and drop to the slow cadence
    // after fewer clean samples (heuristic still runs for falsely-flagged progressive).
    const needed =
      mayBeInterlacedHint === false ? Math.min(3, PROGRESSIVE_CONFIDENCE_SAMPLES) : PROGRESSIVE_CONFIDENCE_SAMPLES;
    if (progressiveConfidence < needed) {
      return SAMPLE_INTERVAL_MS;
    }
    return PROGRESSIVE_SAMPLE_INTERVAL_MS;
  };

  const startDetector = () => {
    detector.start();
    if (detectorRunning) return;
    detectorRunning = true;
    Log.i(TAG, `Interlace detector started (${formatVideoSize()})`);
  };

  const stopDetector = (reason: string) => {
    detector.stop();
    const gl = renderer.currentGl;
    if (gl && detectorReady) detector.discardPendingReadbacks(gl);
    if (!detectorRunning) return;
    detectorRunning = false;
    Log.i(TAG, `Interlace detector stopped: ${reason}`);
  };

  const renderer = new VideoRenderer(
    video,
    canvas,
    () => {
      if (destroyed) return;
      detector.onGlContextLost();
      detectorReady = false;
      detectorRunning = false;
      renderRunning = false;
      Log.i(TAG, "Interlace detector stopped: WebGL context lost");
      setActive(false);
    },
    () => {
      if (destroyed) return;
      Log.i(TAG, "WebGL context restored; re-establishing video render pipeline");
      apply();
    },
  );
  renderer.setPictureEnhancementEnabled(pictureEnhancementEnabled);
  renderer.setPresentEnabled(true);

  renderer.onFrame = (gl) => {
    if (destroyed || !autoDeinterlaceEnabled || !detectorReady) return false;
    detector.poll(gl);

    const now = performance.now();
    const isFastPhase = fastPhaseSamples < FAST_SAMPLE_COUNT;
    if (!isFastPhase && !detector.fieldOrderVotingActive && now - lastSampleMs < sampleIntervalMs()) {
      return false;
    }
    return true;
  };

  renderer.onSample = (gl, curTexture, prevTexture, videoWidth, videoHeight) => {
    if (destroyed || !autoDeinterlaceEnabled || !detectorReady) return;
    detector.sample(gl, curTexture, prevTexture, videoWidth, videoHeight);
    lastSampleMs = performance.now();
    if (fastPhaseSamples < FAST_SAMPLE_COUNT) fastPhaseSamples++;
  };

  renderer.onFrameOutsideRenderGate = () => {
    if (destroyed) return;
    lastEligibility = null;
    apply();
  };

  const detector = new InterlaceDetector((verdict: DetectorVerdict) => {
    const wasInterlaced = interlaced;
    interlaced = verdict.interlaced;
    fieldOrder = verdict.fieldOrder;
    if (interlaced) {
      progressiveConfidence = 0;
    } else if (!wasInterlaced) {
      progressiveConfidence++;
    }

    if (destroyed || !renderRunning) return;
    renderer.setFieldOrder(fieldOrder);
    applyRenderStage();
    syncPresentAndActive();
  });

  const syncDetector = () => {
    if (!renderRunning) {
      stopDetector("render pipeline inactive");
      return;
    }

    if (!autoDeinterlaceEnabled) {
      stopDetector("auto deinterlace disabled");
      return;
    }

    const gl = renderer.currentGl;
    if (!gl) {
      stopDetector("WebGL context unavailable");
      detectorReady = false;
      return;
    }

    if (!detectorReady) {
      detectorReady = detector.initGl(gl);
      if (!detectorReady) {
        stopDetector("GPU detector unavailable");
        interlaced = false;
        fieldOrder = "tff";
        renderer.setFieldOrder(fieldOrder);
        renderer.setStage("passthrough");
        return;
      }
    }

    startDetector();
  };

  const syncPresentAndActive = () => {
    if (!renderRunning) {
      setActive(false);
      return;
    }
    // Detect-only: keep uploading for the heuristic, but do not present to canvas.
    const present = !detectOnlyMode();
    const wasPresent = renderer.isPresentEnabled;
    renderer.setPresentEnabled(present);
    if (present !== wasPresent) {
      Log.i(TAG, present ? "Canvas presentation enabled" : "Detect-only mode (raw video visible)");
    }
    setActive(canvasShouldBeVisible());
  };

  const applyRenderStage = () => {
    const stage = desiredStage();
    renderer.setFieldOrder(fieldOrder);
    if (renderer.setStage(stage)) return;

    if (stage === "bwdif") {
      Log.w(TAG, "Falling back to passthrough after bwdif stage setup failed");
      interlaced = false;
      fieldOrder = "tff";
      renderer.setFieldOrder(fieldOrder);
      renderer.setStage("passthrough");
    }
  };

  const startRenderChain = () => {
    if (renderRunning || destroyed) return;

    // Apply detect-only before start() so the first primeCanvas / rVFC frames
    // do not pay a full present path on progressive sources.
    const willDetectOnly = autoDeinterlaceEnabled && !interlaced && !pictureEnhancementEnabled;
    renderer.setPresentEnabled(!willDetectOnly);
    if (willDetectOnly) {
      Log.i(TAG, "Starting in detect-only mode (raw video visible until interlaced)");
    }

    const stage = desiredStage();
    if (!renderer.start(stage, fieldOrder)) {
      if (stage !== "passthrough" && renderer.start("passthrough", fieldOrder)) {
        interlaced = false;
      } else {
        renderer.setPresentEnabled(true);
        setActive(false);
        return;
      }
    }

    renderRunning = true;
    resetCadence();
    syncDetector();
    syncPresentAndActive();
  };

  const stopRenderChain = () => {
    if (!renderRunning) {
      setActive(false);
      return;
    }
    renderRunning = false;
    stopDetector("render pipeline stopped");
    renderer.setPresentEnabled(true);
    renderer.stop();
    setActive(false);
  };

  const apply = () => {
    const eligible =
      video.videoWidth > 0 && video.videoHeight > 0 && isRenderResolutionEligible(video.videoWidth, video.videoHeight);
    if (eligible !== lastEligibility) {
      if (eligible) Log.i(TAG, `Render gate enabled for ${formatVideoSize()}`);
      else if (video.videoWidth > 0 && video.videoHeight > 0) {
        Log.i(TAG, `Render gate disabled for ${formatVideoSize()}; falling back to raw video`);
      }
      lastEligibility = eligible;
    }

    // With both features off the pipeline would only reproduce the raw video, so treat
    // that case like an ineligible resolution and fall back to the raw <video> element.
    const pipelineUseful = autoDeinterlaceEnabled || pictureEnhancementEnabled;
    if (!eligible || !pipelineUseful) {
      stopRenderChain();
      return;
    }

    if (!renderRunning) {
      startRenderChain();
      return;
    }

    applyRenderStage();
    syncDetector();
    syncPresentAndActive();
  };

  const handleVideoResize = () => {
    if (destroyed) return;
    apply();
  };
  video.addEventListener("resize", handleVideoResize);

  apply();

  return {
    setAutoDeinterlaceEnabled(next: boolean) {
      if (autoDeinterlaceEnabled === next) return;
      autoDeinterlaceEnabled = next;
      apply();
    },
    setPictureEnhancementEnabled(next: boolean) {
      if (pictureEnhancementEnabled === next) return;
      pictureEnhancementEnabled = next;
      renderer.setPictureEnhancementEnabled(next);
      apply();
    },
    setMayBeInterlacedHint(next: boolean | null) {
      if (mayBeInterlacedHint === next) return;
      mayBeInterlacedHint = next;
      // A positive hint should re-arm the fast sample cadence immediately.
      if (next === true) {
        progressiveConfidence = 0;
        lastSampleMs = -Infinity;
      }
    },
    reset() {
      interlaced = false;
      fieldOrder = "tff";
      mayBeInterlacedHint = null;
      resetCadence();
      detector.reset();
      renderer.setFieldOrder(fieldOrder);
      renderer.setStage("passthrough");
      renderer.clearCanvas();
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

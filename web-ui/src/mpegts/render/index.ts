import "./filters/bwdif";
import Log from "../utils/logger";
import { type DetectorVerdict, InterlaceDetector, isRenderResolutionEligible } from "./interlace-detector";
import { type FieldOrder, type RenderStageName, VideoRenderer } from "./renderer";

const TAG = "VideoRenderPipeline";

export interface VideoRenderPipeline {
  setAutoDeinterlaceEnabled(enabled: boolean): void;
  setPictureEnhancementEnabled(enabled: boolean): void;
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
/** Steady-state gap between detection samples. Also guarantees the PBO readback never stalls. */
const SAMPLE_INTERVAL_MS = 500;

/**
 * Wires the GPU interlace detector to the WebGL renderer for one video/canvas pair.
 *
 * The renderer runs only while the decoded frame size is inside the SD/HD render
 * gate AND at least one of auto deinterlacing / picture enhancement is enabled —
 * with both off the pipeline would only reproduce the raw video, so it is skipped
 * like an ineligible resolution. Eligible interlaced frames switch to bwdif when
 * auto deinterlacing is on; otherwise the source frame is presented directly.
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

  const desiredStage = (): RenderStageName => (autoDeinterlaceEnabled && interlaced ? "bwdif" : "passthrough");

  const formatVideoSize = () =>
    video.videoWidth > 0 && video.videoHeight > 0 ? `${video.videoWidth}x${video.videoHeight}` : "unknown";

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

  renderer.onFrame = (gl) => {
    if (destroyed || !autoDeinterlaceEnabled || !detectorReady) return false;
    detector.poll(gl);

    const now = performance.now();
    const isFastPhase = fastPhaseSamples < FAST_SAMPLE_COUNT;
    if (!isFastPhase && !detector.fieldOrderVotingActive && now - lastSampleMs < SAMPLE_INTERVAL_MS) return false;
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
    interlaced = verdict.interlaced;
    fieldOrder = verdict.fieldOrder;
    if (destroyed || !renderRunning) return;
    renderer.setFieldOrder(fieldOrder);
    applyRenderStage();
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

    const stage = desiredStage();
    if (!renderer.start(stage, fieldOrder)) {
      if (stage !== "passthrough" && renderer.start("passthrough", fieldOrder)) {
        interlaced = false;
      } else {
        setActive(false);
        return;
      }
    }

    renderRunning = true;
    resetCadence();
    syncDetector();
    setActive(true);
  };

  const stopRenderChain = () => {
    if (!renderRunning) {
      setActive(false);
      return;
    }
    renderRunning = false;
    stopDetector("render pipeline stopped");
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
    setActive(true);
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
    reset() {
      interlaced = false;
      fieldOrder = "tff";
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

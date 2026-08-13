import "./filters/bwdif";
import "./filters/mosquito-nr";
import type { PlayerRenderState, PlayerVideoScanType } from "../types";
import Log from "../utils/logger";
import { isRenderResolutionEligible, type RenderStageName, VideoRenderer } from "./renderer";

const TAG = "VideoRenderPipeline";

export interface VideoRenderPipeline {
  setAutoDeinterlaceEnabled(enabled: boolean): void;
  setPictureEnhancementEnabled(enabled: boolean): void;
  /** Apply codec/container scan-type metadata; call when media-info updates. */
  setScanType(scanType?: PlayerVideoScanType): void;
  /** Forget source-specific state; call on channel/source switch. */
  reset(): void;
  /** True while the WebGL canvas is the visible video output. */
  readonly active: boolean;
  destroy(): void;
}

export function isVideoRenderSupported(): boolean {
  return VideoRenderer.isSupported();
}

/**
 * Wires the WebGL renderer to one video/canvas pair.
 *
 * The renderer runs only while the decoded frame size is inside the SD/HD render
 * gate AND the pipeline would do more than reproduce the raw video: either
 * picture enhancement is on, or auto deinterlacing is on and metadata declared
 * interlaced scan. Eligible interlaced frames then use bwdif (always TFF);
 * otherwise the source frame is presented directly.
 * Larger frames, both features disabled, WebGL failures, or missing rVFC support
 * all fall back to the raw video element by reporting active = false.
 */
export function createVideoRenderPipeline(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onStateChange?: (state: PlayerRenderState) => void,
): VideoRenderPipeline {
  if (!VideoRenderer.isSupported()) {
    Log.i(TAG, "requestVideoFrameCallback unavailable; WebGL video rendering disabled");
    return {
      setAutoDeinterlaceEnabled() {},
      setPictureEnhancementEnabled() {},
      setScanType() {},
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
  let scanType: PlayerVideoScanType | undefined;
  let currentStage: RenderStageName = "passthrough";
  let lastEligibility: boolean | null = null;
  let serializedState = "";

  const publishState = () => {
    const state: PlayerRenderState = {
      active,
      deinterlacing: active && currentStage === "bwdif",
    };
    const nextSerializedState = JSON.stringify(state);
    if (nextSerializedState === serializedState) return;
    serializedState = nextSerializedState;
    onStateChange?.(state);
  };

  const setActive = (nextActive: boolean) => {
    if (active === nextActive) return;
    active = nextActive;
    publishState();
  };

  const setCurrentStage = (nextStage: RenderStageName) => {
    if (currentStage === nextStage) return;
    currentStage = nextStage;
    publishState();
  };

  const desiredStage = (): RenderStageName =>
    autoDeinterlaceEnabled && scanType === "interlaced" ? "bwdif" : "passthrough";

  const formatVideoSize = () =>
    video.videoWidth > 0 && video.videoHeight > 0 ? `${video.videoWidth}x${video.videoHeight}` : "unknown";

  const renderer = new VideoRenderer(
    video,
    canvas,
    () => {
      if (destroyed) return;
      renderRunning = false;
      setCurrentStage("passthrough");
      setActive(false);
    },
    () => {
      if (destroyed) return;
      Log.i(TAG, "WebGL context restored; re-establishing video render pipeline");
      apply();
    },
  );
  renderer.setPictureEnhancementEnabled(pictureEnhancementEnabled);

  renderer.onFrameOutsideRenderGate = () => {
    if (destroyed) return;
    lastEligibility = null;
    apply();
  };

  const applyRenderStage = () => {
    const stage = desiredStage();
    if (renderer.setStage(stage)) {
      setCurrentStage(stage);
      return;
    }

    if (stage === "bwdif") {
      Log.w(TAG, "Falling back to passthrough after bwdif stage setup failed");
      renderer.setStage("passthrough");
      setCurrentStage("passthrough");
    }
  };

  const startRenderChain = () => {
    if (renderRunning || destroyed) return;

    const stage = desiredStage();
    if (!renderer.start(stage)) {
      if (stage !== "passthrough" && renderer.start("passthrough")) {
        setCurrentStage("passthrough");
      } else {
        setCurrentStage("passthrough");
        setActive(false);
        return;
      }
    } else {
      setCurrentStage(stage);
    }

    renderRunning = true;
    setActive(true);
  };

  const stopRenderChain = () => {
    if (!renderRunning) {
      setActive(false);
      return;
    }
    renderRunning = false;
    renderer.stop();
    setCurrentStage("passthrough");
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

    // Passthrough with no enhancement only reproduces the raw video, so treat that
    // case like an ineligible resolution and fall back to the raw <video> element.
    const pipelineUseful = (autoDeinterlaceEnabled && scanType === "interlaced") || pictureEnhancementEnabled;
    if (!eligible || !pipelineUseful) {
      stopRenderChain();
      return;
    }

    if (!renderRunning) {
      startRenderChain();
      return;
    }

    applyRenderStage();
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
      publishState();
    },
    setPictureEnhancementEnabled(next: boolean) {
      if (pictureEnhancementEnabled === next) return;
      pictureEnhancementEnabled = next;
      renderer.setPictureEnhancementEnabled(next);
      apply();
    },
    setScanType(next?: PlayerVideoScanType) {
      if (scanType === next) return;
      scanType = next;
      if (next === "interlaced") Log.i(TAG, "Interlaced metadata; enabling bwdif when auto deinterlace is on");
      apply();
      publishState();
    },
    reset() {
      scanType = undefined;
      setCurrentStage("passthrough");
      renderer.resetStream();
      renderer.clearCanvas();
      apply();
      publishState();
    },
    get active() {
      return active;
    },
    destroy() {
      destroyed = true;
      video.removeEventListener("resize", handleVideoResize);
      renderer.destroy();
    },
  };
}

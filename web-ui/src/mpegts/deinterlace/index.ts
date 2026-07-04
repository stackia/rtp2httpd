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

  const notifyFirstFrameRendered = () => {
    if (!pendingFirstFrame || !enabled || destroyed) return;
    pendingFirstFrame = false;
    if (!active) {
      active = true;
      onActiveChange?.(true);
    }
  };

  const renderer = new DeinterlaceRenderer(video, canvas, notifyFirstFrameRendered);

  const setActive = (next: boolean, algorithm: string, fieldOrder: FieldOrder = "tff") => {
    if (destroyed) return;
    if (next) {
      pendingFirstFrame = true;
      if (!renderer.start(algorithm, fieldOrder)) {
        // WebGL unavailable or algorithm init failed — leave raw video visible
        pendingFirstFrame = false;
        return;
      }
      // Do not emit active=true yet; notifyFirstFrameRendered() fires after the
      // first WebGL frame is drawn (synchronously from start() when readyState is
      // already sufficient, or via the next rVFC callback otherwise).
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
      detector.reset();
      if (enabled) setActive(false, "bwdif");
    },
    get active() {
      return active;
    },
    destroy() {
      destroyed = true;
      detector.destroy();
      renderer.destroy();
    },
  };
}

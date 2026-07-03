import "./algorithms/bwdif";
import Log from "../utils/logger";
import { type DetectorVerdict, InterlaceDetector } from "./detector";
import { DeinterlaceRenderer, type FieldOrder } from "./renderer";

const TAG = "DeinterlacePipeline";

export interface DeinterlacePipeline {
  setEnabled(enabled: boolean): void;
  /**
   * Codec metadata hint: the stream may contain interlaced pictures. When
   * enabled this activates deinterlacing immediately (same ≤1080 resolution
   * gate) instead of waiting for the heuristic detector to accumulate evidence.
   */
  hintInterlaced(width: number, height: number): void;
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
  let destroyed = false;
  let lastVerdict: DetectorVerdict | null = null;

  const renderer = new DeinterlaceRenderer(video, canvas);

  const setActive = (next: boolean, algorithm: string, fieldOrder: FieldOrder = "tff") => {
    if (destroyed) return;
    if (next && !renderer.start(algorithm, fieldOrder)) return; // e.g. WebGL unavailable → keep raw video visible
    if (!next) renderer.stop();
    if (active !== next) {
      active = next;
      onActiveChange?.(next);
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
      hintInterlaced() {},
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
    hintInterlaced(width: number, height: number) {
      // The detector applies the resolution gate and emits the verdict, which
      // activates rendering when enabled via the callback above
      detector.hintInterlaced(width, height);
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

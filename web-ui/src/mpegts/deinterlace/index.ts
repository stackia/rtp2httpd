import "./algorithms/bwdif";
import Log from "../utils/logger";
import { type DetectorVerdict, InterlaceDetector } from "./detector";
import { DeinterlaceRenderer, type FieldOrder } from "./renderer";

const TAG = "DeinterlacePipeline";

export type DeinterlaceMode = "auto" | "off" | "force";

export interface DeinterlacePipeline {
  setMode(mode: DeinterlaceMode): void;
  /**
   * Codec metadata hint: the stream may contain interlaced pictures. In auto
   * mode this activates deinterlacing immediately (same ≤1080 resolution gate)
   * instead of waiting for the heuristic detector to accumulate evidence.
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
 * In "auto" mode the detector decides when combing appears and which algorithm to
 * use; "force" activates bwdif unconditionally (debug aid); "off" disables both.
 */
export function createDeinterlacePipeline(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onActiveChange?: (active: boolean) => void,
): DeinterlacePipeline {
  let mode: DeinterlaceMode = "auto";
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
    if (mode === "auto") {
      setActive(verdict.interlaced, verdict.algorithm, verdict.fieldOrder);
    }
  });

  const applyMode = () => {
    switch (mode) {
      case "off":
        detector.stop();
        setActive(false, "bwdif");
        break;
      case "force":
        detector.stop();
        setActive(true, "bwdif");
        break;
      case "auto":
        setActive(
          lastVerdict?.interlaced === true,
          lastVerdict?.algorithm ?? "bwdif",
          lastVerdict?.fieldOrder ?? "tff",
        );
        detector.start();
        break;
    }
  };

  if (!DeinterlaceRenderer.isSupported()) {
    Log.i(TAG, "requestVideoFrameCallback unavailable; deinterlacing disabled");
    return {
      setMode() {},
      hintInterlaced() {},
      reset() {},
      get active() {
        return false;
      },
      destroy() {},
    };
  }

  applyMode();

  return {
    setMode(next: DeinterlaceMode) {
      if (mode === next) return;
      mode = next;
      applyMode();
    },
    hintInterlaced(width: number, height: number) {
      // The detector applies the resolution gate and emits the verdict, which
      // activates rendering in auto mode via the callback above
      detector.hintInterlaced(width, height);
    },
    reset() {
      lastVerdict = null;
      detector.reset();
      if (mode === "auto") setActive(false, "bwdif");
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

import Log from "../utils/logger";
import { createAlgorithm, type DeinterlaceAlgorithm } from "./algorithms/types";

const TAG = "DeinterlaceRenderer";

/** Field order of the interlaced source: top field first or bottom field first. */
export type FieldOrder = "tff" | "bff";

/**
 * WebGL2 render loop: pulls decoded (weaved) frames from the <video> element via
 * requestVideoFrameCallback, uploads them as textures and runs the active
 * deinterlacing algorithm, drawing to an overlay canvas.
 *
 * The renderer is passive until start() is called and goes back to passive on
 * stop(); the video element keeps driving the playback clock and audio either way.
 */
export class DeinterlaceRenderer {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private algorithm: DeinterlaceAlgorithm | null = null;
  private algorithmName: string | null = null;
  /** Ring of frame textures: [0] = current, [1..] = history (most recent first). */
  private textures: WebGLTexture[] = [];
  private rvfcHandle = 0;
  private secondFieldTimer = 0;
  private running = false;
  private contextLost = false;
  private fieldOrder: FieldOrder = "tff";
  private readonly onFrameRendered?: () => void;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    Log.w(TAG, "WebGL context lost");
  };

  private readonly handleContextRestored = () => {
    Log.i(TAG, "WebGL context restored");
    this.contextLost = false;
    // All GL objects are gone; rebuild lazily on the next frame
    this.textures = [];
    this.algorithm = null;
    const name = this.algorithmName;
    if (name && this.running) {
      this.setupAlgorithm(name);
    }
  };

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, onFrameRendered?: () => void) {
    this.video = video;
    this.canvas = canvas;
    this.onFrameRendered = onFrameRendered;
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  /** Whether this environment can run the renderer at all. */
  static isSupported(): boolean {
    return typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start rendering with the given algorithm and field order. Safe to call repeatedly. */
  start(algorithmName: string, fieldOrder: FieldOrder = "tff"): boolean {
    this.fieldOrder = fieldOrder;
    if (this.running && this.algorithmName === algorithmName) return true;
    if (this.running) this.stop();

    if (!this.setupAlgorithm(algorithmName)) return false;
    this.running = true;
    // Prime the canvas from the current video frame right away. Without this,
    // (re)enabling while paused leaves whatever the canvas last showed —
    // possibly a stale frame from a previous run — since rVFC only fires on
    // new presented frames. Renders spatial-only until real history arrives.
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.renderFrame(this.fieldOrder === "tff" ? 0 : 1, false);
    }
    this.scheduleFrame();
    Log.i(TAG, `Started with algorithm '${algorithmName}' (${fieldOrder})`);
    return true;
  }

  /** Stop rendering and release per-run GL resources. The canvas keeps its last frame. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rvfcHandle) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = 0;
    }
    if (this.secondFieldTimer) {
      window.clearTimeout(this.secondFieldTimer);
      this.secondFieldTimer = 0;
    }
    this.teardownAlgorithm();
    Log.i(TAG, "Stopped");
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.gl = null;
  }

  private setupAlgorithm(name: string): boolean {
    const gl = this.ensureContext();
    if (!gl) return false;
    const algorithm = createAlgorithm(name);
    if (!algorithm) {
      Log.e(TAG, `Unknown deinterlace algorithm '${name}'`);
      return false;
    }
    try {
      algorithm.init(gl);
    } catch (err) {
      Log.e(TAG, `Failed to init algorithm '${name}':`, err);
      algorithm.destroy(gl);
      return false;
    }
    this.algorithm = algorithm;
    this.algorithmName = name;
    return true;
  }

  private teardownAlgorithm(): void {
    if (this.gl && this.algorithm) {
      this.algorithm.destroy(this.gl);
    }
    if (this.gl) {
      for (const texture of this.textures) {
        this.gl.deleteTexture(texture);
      }
    }
    this.textures = [];
    this.algorithm = null;
  }

  private ensureContext(): WebGL2RenderingContext | null {
    if (this.gl && !this.contextLost) return this.gl;
    if (this.contextLost) return null;
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      // Rendering is trivial; prefer not to wake the discrete GPU
      powerPreference: "low-power",
    });
    if (!gl) {
      Log.e(TAG, "WebGL2 not available");
      return null;
    }
    this.gl = gl;
    return gl;
  }

  private scheduleFrame(): void {
    this.rvfcHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.rvfcHandle = 0;
      if (!this.running) return;
      if (this.secondFieldTimer) {
        window.clearTimeout(this.secondFieldTimer);
        this.secondFieldTimer = 0;
      }
      // Field-rate output: render the temporally first field now, the second
      // half a frame duration later — 25i becomes 50p motion. Which spatial
      // field comes first depends on the source field order (TFF: top first).
      // While paused no new frames arrive and the last rendered field simply
      // stays: a single clean field, so the paused still shows no tearing.
      const firstField = this.fieldOrder === "tff" ? 0 : 1;
      this.renderFrame(firstField, false);
      const frameDurationMs = this.frameDurationMs(metadata);
      if (!this.video.paused && frameDurationMs > 10) {
        this.secondFieldTimer = window.setTimeout(() => {
          this.secondFieldTimer = 0;
          if (this.running) this.renderFrame(firstField === 0 ? 1 : 0, true);
        }, frameDurationMs / 2);
      }
      this.scheduleFrame();
    });
  }

  private lastMediaTime = -1;
  private frameDurationEstimateMs = 40;

  /** Estimate the source frame duration from consecutive rVFC mediaTime values. */
  private frameDurationMs(metadata: VideoFrameCallbackMetadata): number {
    if (this.lastMediaTime >= 0) {
      const delta = (metadata.mediaTime - this.lastMediaTime) * 1000;
      if (delta > 10 && delta < 100) this.frameDurationEstimateMs = delta;
    }
    this.lastMediaTime = metadata.mediaTime;
    return this.frameDurationEstimateMs;
  }

  private createFrameTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private renderFrame(field: 0 | 1, isSecondField: boolean): void {
    const gl = this.gl;
    const algorithm = this.algorithm;
    if (!gl || !algorithm || this.contextLost) return;

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) return;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    if (!isSecondField) {
      // The ring grows one texture per uploaded frame (so every entry holds a
      // real frame — algorithms clamp their history binds while it fills up);
      // once full, the oldest entry is rotated to the front as upload target.
      const ringSize = algorithm.historyFrames + 1;
      const isNew = this.textures.length < ringSize;
      let target: WebGLTexture | null;
      if (isNew) {
        target = this.createFrameTexture(gl);
      } else {
        target = this.textures[this.textures.length - 1];
      }
      if (!target) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
      } catch (err) {
        // Upload can fail transiently (e.g. video element in a broken state); skip the frame
        Log.w(TAG, "Frame texture upload failed:", err);
        if (isNew) gl.deleteTexture(target);
        return;
      }
      if (!isNew) this.textures.pop();
      this.textures.unshift(target);
    }
    // The second field re-renders from the already-uploaded texture ring

    gl.viewport(0, 0, width, height);
    // Until the ring holds a distinct frame for every history slot, temporal
    // filtering would compare a frame with itself — force spatial-only
    const spatialOnly = this.textures.length <= algorithm.historyFrames;
    algorithm.render(gl, this.textures, { width, height, keepField: field, isSecondField, spatialOnly });
    this.onFrameRendered?.();
  }
}

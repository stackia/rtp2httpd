import Log from "../utils/logger";
import { createAlgorithm, type DeinterlaceAlgorithm } from "./algorithms/types";
import { isResolutionEligible } from "./detector";

const TAG = "DeinterlaceRenderer";

/** Field order of the interlaced source: top field first or bottom field first. */
export type FieldOrder = "tff" | "bff";

/**
 * WebGL2 render loop: pulls decoded (weaved) frames from the <video> element via
 * requestVideoFrameCallback and runs in one of two modes:
 *
 * - Detection-only (renderingEnabled = false, the default): frames are uploaded
 *   only when the pipeline requests a detection sample; between samples the
 *   loop does nothing on the GPU beyond draining async readbacks. No bwdif
 *   draws, no canvas writes — progressive content costs almost nothing.
 * - Full render (renderingEnabled = true): every decoded frame is uploaded into
 *   the texture ring and deinterlaced at field rate onto the overlay canvas.
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
  private renderingEnabled = false;
  private contextLost = false;
  private fieldOrder: FieldOrder = "tff";
  private readonly onContextLost?: () => void;
  private readonly onContextRestored?: () => void;

  /**
   * Called once per new decoded frame while running, before any upload or draw.
   * Use it to drain async detection readbacks (strictly non-blocking GL only).
   * Return true to request a detection sample for this frame — the renderer
   * then uploads the frame and invokes onSample with the texture ring.
   */
  onFrame: ((gl: WebGL2RenderingContext) => boolean) | null = null;

  /**
   * Called when onFrame requested a sample and the frame texture upload
   * succeeded. In detection-only mode prevTexture is the previous *sample*
   * (~500 ms old), not the previous frame. Must not issue blocking readbacks.
   */
  onSample:
    | ((
        gl: WebGL2RenderingContext,
        curTexture: WebGLTexture,
        prevTexture: WebGLTexture | null,
        videoWidth: number,
        videoHeight: number,
      ) => void)
    | null = null;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    // Stop the render loop — frames cannot render without a GL context.
    // The pipeline is notified via onContextLost so it can fall back to raw video.
    if (this.rvfcHandle) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = 0;
    }
    if (this.secondFieldTimer) {
      window.clearTimeout(this.secondFieldTimer);
      this.secondFieldTimer = 0;
    }
    this.running = false;
    Log.w(TAG, "WebGL context lost");
    this.onContextLost?.();
  };

  private readonly handleContextRestored = () => {
    Log.i(TAG, "WebGL context restored");
    this.contextLost = false;
    // All GL objects were destroyed — clear references so the pipeline can
    // re‑establish everything via start().
    this.textures = [];
    this.algorithm = null;
    this.onContextRestored?.();
  };

  constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    onContextLost?: () => void,
    onContextRestored?: () => void,
  ) {
    this.video = video;
    this.canvas = canvas;
    this.onContextLost = onContextLost;
    this.onContextRestored = onContextRestored;
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

  /** Update the source field order for subsequent frames (TFF/BFF). */
  setFieldOrder(fieldOrder: FieldOrder): void {
    this.fieldOrder = fieldOrder;
  }

  /**
   * Switch between detection-only and full-render mode. Turning rendering on
   * clears the texture ring (detection-only entries can be sampled seconds
   * apart — weaving them would mix distant frames; the algorithm's spatialOnly
   * warm-up covers the refill) and primes the canvas from the current frame so
   * there is a valid picture before it is revealed.
   */
  setRenderingEnabled(enabled: boolean): void {
    if (this.renderingEnabled === enabled) return;
    this.renderingEnabled = enabled;
    if (!enabled) {
      if (this.secondFieldTimer) {
        window.clearTimeout(this.secondFieldTimer);
        this.secondFieldTimer = 0;
      }
      Log.i(TAG, "Detection-only mode (rendering off)");
      return;
    }
    this.clearTextureRing();
    this.primeCanvas();
    Log.i(TAG, "Full render mode (rendering on)");
  }

  /** Start the frame loop with the given algorithm and field order. Safe to call repeatedly. */
  start(algorithmName: string, fieldOrder: FieldOrder = "tff"): boolean {
    this.fieldOrder = fieldOrder;
    if (this.running && this.algorithmName === algorithmName) return true;
    if (this.running) this.stop();

    if (!this.setupAlgorithm(algorithmName)) return false;
    this.running = true;
    // Re-starting with rendering already enabled (e.g. deinterlace toggled off
    // and back on while paused): prime the canvas right away, since rVFC only
    // fires on new presented frames and the canvas may hold a stale picture.
    this.primeCanvas();
    this.scheduleFrame();
    Log.i(
      TAG,
      `Frame loop started (algorithm '${algorithmName}', ${fieldOrder}, ` +
        `${this.renderingEnabled ? "full render" : "detection-only"})`,
    );
    return true;
  }

  /** Stop the loop and release per-run GL resources. The canvas keeps its last frame. */
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
    this.clearTextureRing();
    this.algorithm = null;
  }

  private clearTextureRing(): void {
    if (this.gl && !this.contextLost) {
      for (const texture of this.textures) {
        this.gl.deleteTexture(texture);
      }
    }
    this.textures = [];
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

  /** Upload the current frame and draw the first field (start / mode switch while paused). */
  private primeCanvas(): void {
    if (!this.running || !this.renderingEnabled) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const gl = this.gl;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!gl || this.contextLost || !isResolutionEligible(width, height)) return;
    if (!this.uploadFrame(gl, width, height)) return;
    this.drawField(this.fieldOrder === "tff" ? 0 : 1, false);
  }

  private scheduleFrame(): void {
    this.rvfcHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.rvfcHandle = 0;
      if (!this.running) return;
      if (this.secondFieldTimer) {
        window.clearTimeout(this.secondFieldTimer);
        this.secondFieldTimer = 0;
      }
      this.processFrame(metadata);
      this.scheduleFrame();
    });
  }

  private processFrame(metadata: VideoFrameCallbackMetadata): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    // Drain async detection readbacks and get the pipeline's sampling decision.
    const sampleDue = this.onFrame?.(gl) ?? false;
    const frameDurationMs = this.frameDurationMs(metadata);

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    // Per-frame resolution-gate guard: on a stream switch the first oversized
    // frame can present before the `resize` event stops the GPU chain — skip
    // such frames entirely (no upload, no draw, no detection).
    if (!isResolutionEligible(width, height)) return;

    // Detection-only mode between samples: nothing else to do this frame.
    if (!this.renderingEnabled && !sampleDue) return;

    if (!this.uploadFrame(gl, width, height)) return;

    if (this.renderingEnabled) {
      // Field-rate output: render the temporally first field now, the second
      // half a frame duration later — 25i becomes 50p motion. Which spatial
      // field comes first depends on the source field order (TFF: top first).
      // While paused no new frames arrive and the last rendered field simply
      // stays: a single clean field, so the paused still shows no tearing.
      const firstField = this.fieldOrder === "tff" ? 0 : 1;
      this.drawField(firstField, false);
      if (!this.video.paused && frameDurationMs > 10) {
        this.secondFieldTimer = window.setTimeout(() => {
          this.secondFieldTimer = 0;
          if (this.running && this.renderingEnabled) this.drawField(firstField === 0 ? 1 : 0, true);
        }, frameDurationMs / 2);
      }
    }

    if (sampleDue && this.onSample) {
      const prevTexture = this.textures.length >= 2 ? this.textures[1] : null;
      this.onSample(gl, this.textures[0], prevTexture, width, height);
    }
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

  /** Upload the current video frame into the texture ring. Returns false on failure. */
  private uploadFrame(gl: WebGL2RenderingContext, width: number, height: number): boolean {
    const algorithm = this.algorithm;
    if (!algorithm || !width || !height) return false;

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
    if (!target) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
    } catch (err) {
      // Upload can fail transiently (e.g. video element in a broken state); skip the frame
      Log.w(TAG, "Frame texture upload failed:", err);
      if (isNew) gl.deleteTexture(target);
      return false;
    }
    if (!isNew) this.textures.pop();
    this.textures.unshift(target);
    return true;
  }

  /** Run the deinterlacing algorithm for one field onto the canvas. */
  private drawField(field: 0 | 1, isSecondField: boolean): void {
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

    gl.viewport(0, 0, width, height);
    // Until the ring holds a distinct frame for every history slot, temporal
    // filtering would compare a frame with itself — force spatial-only
    const spatialOnly = this.textures.length <= algorithm.historyFrames;
    algorithm.render(gl, this.textures, { width, height, keepField: field, isSecondField, spatialOnly });
  }

  /** The active WebGL2 context, or null if not yet created or context is lost. */
  get currentGl(): WebGL2RenderingContext | null {
    return this.contextLost ? null : this.gl;
  }
}

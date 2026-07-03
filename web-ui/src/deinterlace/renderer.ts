import Log from "../mpegts/utils/logger";
import { createAlgorithm, type DeinterlaceAlgorithm } from "./algorithms/types";

const TAG = "DeinterlaceRenderer";

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

  /** Start rendering with the given algorithm. Safe to call repeatedly. */
  start(algorithmName: string): boolean {
    if (this.running && this.algorithmName === algorithmName) return true;
    if (this.running) this.stop();

    if (!this.setupAlgorithm(algorithmName)) return false;
    this.running = true;
    this.scheduleFrame();
    Log.i(TAG, `Started with algorithm '${algorithmName}'`);
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
      // Field-rate bob: render the first (top, TFF) field now, the second field
      // half a frame duration later — 25i becomes 50p motion. While paused no
      // new frames arrive and the last rendered field simply stays: a single
      // clean field, so the paused still shows no tearing.
      this.renderFrame(0);
      const frameDurationMs = this.frameDurationMs(metadata);
      if (!this.video.paused && frameDurationMs > 10) {
        this.secondFieldTimer = window.setTimeout(() => {
          this.secondFieldTimer = 0;
          if (this.running) this.renderFrame(1);
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

  private renderFrame(field: 0 | 1): void {
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

    if (field === 0) {
      // Rotate the texture ring: oldest becomes the upload target for the current frame
      const ringSize = algorithm.historyFrames + 1;
      while (this.textures.length < ringSize) {
        const texture = this.createFrameTexture(gl);
        if (!texture) return;
        this.textures.push(texture);
      }
      if (ringSize > 1) {
        const oldest = this.textures.pop();
        if (oldest) this.textures.unshift(oldest);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
      } catch (err) {
        // Upload can fail transiently (e.g. video element in a broken state); skip the frame
        Log.w(TAG, "Frame texture upload failed:", err);
        return;
      }
    }
    // field === 1 re-renders from the already-uploaded texture with opposite parity

    gl.viewport(0, 0, width, height);
    // TFF is the overwhelming norm for 1080i broadcast (and what the devlab scan
    // channel encodes); field order detection is a future detector heuristic.
    algorithm.render(gl, this.textures, { width, height, keepField: field });
    this.onFrameRendered?.();
  }
}

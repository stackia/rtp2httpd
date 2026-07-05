import Log from "../utils/logger";
import { createFilter, type RenderParams, type VideoFilter } from "./filters/types";
import { isRenderResolutionEligible } from "./interlace-detector";
import { BicubicPresenter, PassthroughPresenter } from "./presenters";

const TAG = "VideoRenderer";

/** Field order of the interlaced source: top field first or bottom field first. */
export type FieldOrder = "tff" | "bff";
export type RenderStageName = "passthrough" | "bwdif";

/**
 * Post-stage enhancement filters, applied in order between the source stage
 * and presentation. All are registered in the filter registry and must be
 * stateless (historyFrames = 0): the renderer re-runs the whole list per
 * frame and assumes channel/stage switches need no per-filter reset.
 */
const ENHANCEMENT_FILTER_NAMES = ["sharpen"] as const;

interface RenderTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/**
 * WebGL2 render loop. It pulls decoded frames from the <video> element via
 * requestVideoFrameCallback, uploads them into a history ring, runs the active
 * source stage (`passthrough` or `bwdif`) into an offscreen target, optionally
 * runs the enhancement filter list over ping-pong targets, then presents the
 * result to the canvas (bicubic upscale when enhancement sized the canvas to
 * the display, plain blit otherwise).
 */
export class VideoRenderer {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private stageFilter: VideoFilter | null = null;
  private stageTarget: RenderTarget | null = null;
  /** Ring of frame textures: [0] = newest, [1..] = history (most recent first). */
  private textures: WebGLTexture[] = [];
  private rvfcHandle = 0;
  private secondFieldTimer = 0;
  private running = false;
  private contextLost = false;
  private stageName: RenderStageName = "passthrough";
  private fieldOrder: FieldOrder = "tff";
  private readonly onContextLost?: () => void;
  private readonly onContextRestored?: () => void;

  private passthroughPresenter: PassthroughPresenter | null = null;
  private enhancementFilters: VideoFilter[] = [];
  private bicubicPresenter: BicubicPresenter | null = null;
  /** Ping-pong targets for the enhancement filter list (allocated lazily). */
  private enhancementTargets: [RenderTarget | null, RenderTarget | null] = [null, null];
  private pictureEnhancementEnabled = true;
  private enhancementInitFailed = false;

  /**
   * Called once per new decoded frame while running, before any upload or draw.
   * Use it to drain async detection readbacks. Return true to request a detection
   * sample for this frame.
   */
  onFrame: ((gl: WebGL2RenderingContext) => boolean) | null = null;

  /**
   * Called when onFrame requested a sample and frame upload succeeded. Must not
   * issue blocking readbacks.
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

  /** Called when a presented frame is outside the render gate before resize handling catches up. */
  onFrameOutsideRenderGate: ((videoWidth: number, videoHeight: number) => void) | null = null;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.cancelFrameCallbacks();
    this.running = false;
    this.forgetGlResources();
    Log.w(TAG, "WebGL context lost");
    this.onContextLost?.();
  };

  private readonly handleContextRestored = () => {
    Log.i(TAG, "WebGL context restored");
    this.contextLost = false;
    this.forgetGlResources();
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

  /** The active WebGL2 context, or null if not yet created or context is lost. */
  get currentGl(): WebGL2RenderingContext | null {
    return this.contextLost ? null : this.gl;
  }

  /** Update the source field order for subsequent bwdif frames. */
  setFieldOrder(fieldOrder: FieldOrder): void {
    this.fieldOrder = fieldOrder;
  }

  /** Toggle post-stage picture enhancement without rebuilding the media pipeline. */
  setPictureEnhancementEnabled(enabled: boolean): void {
    if (this.pictureEnhancementEnabled === enabled) return;
    this.pictureEnhancementEnabled = enabled;
    this.enhancementInitFailed = false;
    if (!enabled) this.teardownEnhancementResources();
    this.primeCanvas();
  }

  /** Switch the source stage while keeping the frame loop running. */
  setStage(stageName: RenderStageName): boolean {
    if (this.stageName === stageName && (!this.running || this.stageFilter?.name === stageName)) return true;

    const previousStageName = this.stageName;
    this.stageName = stageName;
    if (!this.running) return true;

    if (!this.ensureStageFilter(stageName)) {
      this.stageName = previousStageName;
      return false;
    }
    this.clearSecondFieldTimer();
    this.clearTextureRing();
    this.primeCanvas();
    Log.i(TAG, `Render stage switched to '${stageName}'`);
    return true;
  }

  /** Start the frame loop with the given source stage. Safe to call repeatedly. */
  start(stageName: RenderStageName = this.stageName, fieldOrder: FieldOrder = "tff"): boolean {
    this.fieldOrder = fieldOrder;

    if (this.running) {
      if (!this.setStage(stageName)) return false;
      this.primeCanvas();
      return true;
    }

    this.stageName = stageName;

    const gl = this.ensureContext();
    if (!gl) return false;

    if (!this.ensurePassthroughPresenter() || !this.ensureStageFilter(stageName)) {
      this.teardownFilters();
      return false;
    }

    this.running = true;
    this.primeCanvas();
    this.scheduleFrame();
    Log.i(TAG, `Frame loop started (stage '${stageName}', ${fieldOrder})`);
    return true;
  }

  /** Stop the loop and release per-run GL resources. The canvas keeps its last frame. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelFrameCallbacks();
    this.teardownFilters();
    Log.i(TAG, "Stopped");
  }

  clearCanvas(): void {
    const gl = this.gl;
    if (!gl || this.contextLost || this.canvas.width === 0 || this.canvas.height === 0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.gl = null;
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
      powerPreference: "low-power",
    });
    if (!gl) {
      Log.e(TAG, "WebGL2 not available");
      return null;
    }
    this.gl = gl;
    return gl;
  }

  private ensurePassthroughPresenter(): boolean {
    if (this.passthroughPresenter) return true;
    const gl = this.ensureContext();
    if (!gl) return false;
    const presenter = new PassthroughPresenter();
    try {
      presenter.init(gl);
    } catch (err) {
      Log.e(TAG, "Failed to init canvas presenter:", err);
      presenter.destroy(gl);
      return false;
    }
    this.passthroughPresenter = presenter;
    return true;
  }

  private ensureStageFilter(name: RenderStageName): boolean {
    if (this.stageFilter?.name === name) return true;
    const gl = this.ensureContext();
    if (!gl) return false;

    const filter = createFilter(name);
    if (!filter) {
      Log.e(TAG, `Unknown render filter '${name}'`);
      return false;
    }

    try {
      filter.init(gl);
    } catch (err) {
      Log.e(TAG, `Failed to init render filter '${name}':`, err);
      filter.destroy(gl);
      return false;
    }

    if (this.stageFilter) this.stageFilter.destroy(gl);
    this.stageFilter = filter;
    return true;
  }

  /**
   * Lazily build the enhancement filter list and the bicubic presenter. All
   * succeed or none are kept: a partial chain would silently change the look.
   */
  private ensureEnhancementResources(): boolean {
    if (this.bicubicPresenter) return true;
    if (this.enhancementInitFailed) return false;
    const gl = this.ensureContext();
    if (!gl) return false;

    const filters: VideoFilter[] = [];
    const presenter = new BicubicPresenter();
    try {
      for (const name of ENHANCEMENT_FILTER_NAMES) {
        const filter = createFilter(name);
        if (!filter) throw new Error(`Unknown enhancement filter '${name}'`);
        filter.init(gl);
        filters.push(filter);
      }
      presenter.init(gl);
    } catch (err) {
      Log.w(TAG, "Failed to init picture enhancement; using passthrough presenter:", err);
      for (const filter of filters) filter.destroy(gl);
      presenter.destroy(gl);
      this.enhancementInitFailed = true;
      return false;
    }

    this.enhancementFilters = filters;
    this.bicubicPresenter = presenter;
    return true;
  }

  private teardownEnhancementResources(): void {
    const gl = this.gl;
    if (gl && !this.contextLost) {
      for (const filter of this.enhancementFilters) filter.destroy(gl);
      this.bicubicPresenter?.destroy(gl);
      for (const target of this.enhancementTargets) this.deleteRenderTarget(target);
    }
    this.enhancementFilters = [];
    this.bicubicPresenter = null;
    this.enhancementTargets = [null, null];
  }

  private teardownFilters(): void {
    const gl = this.gl;
    if (gl && !this.contextLost) {
      if (this.stageFilter) this.stageFilter.destroy(gl);
      this.passthroughPresenter?.destroy(gl);
      this.deleteRenderTarget(this.stageTarget);
    }
    this.teardownEnhancementResources();
    this.clearTextureRing();
    this.stageFilter = null;
    this.passthroughPresenter = null;
    this.stageTarget = null;
    this.enhancementInitFailed = false;
  }

  /** Drop all references to GL objects without deleting them (context is gone). */
  private forgetGlResources(): void {
    this.textures = [];
    this.stageTarget = null;
    this.stageFilter = null;
    this.passthroughPresenter = null;
    this.enhancementFilters = [];
    this.bicubicPresenter = null;
    this.enhancementTargets = [null, null];
    this.enhancementInitFailed = false;
  }

  private clearTextureRing(): void {
    if (this.gl && !this.contextLost) {
      for (const texture of this.textures) {
        this.gl.deleteTexture(texture);
      }
    }
    this.textures = [];
  }

  private cancelFrameCallbacks(): void {
    if (this.rvfcHandle) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = 0;
    }
    this.clearSecondFieldTimer();
  }

  private clearSecondFieldTimer(): void {
    if (!this.secondFieldTimer) return;
    window.clearTimeout(this.secondFieldTimer);
    this.secondFieldTimer = 0;
  }

  private primeCanvas(): void {
    if (!this.running) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const gl = this.gl;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!gl || this.contextLost || !isRenderResolutionEligible(width, height)) return;
    if (!this.uploadFrame(gl, width, height)) return;
    this.drawCurrentOutput(this.fieldOrder === "tff" ? 0 : 1, false);
  }

  private scheduleFrame(): void {
    this.rvfcHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.rvfcHandle = 0;
      if (!this.running) return;
      this.clearSecondFieldTimer();
      this.processFrame(metadata);
      if (this.running) this.scheduleFrame();
    });
  }

  private processFrame(metadata: VideoFrameCallbackMetadata): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!isRenderResolutionEligible(width, height)) {
      this.onFrameOutsideRenderGate?.(width, height);
      return;
    }

    const sampleDue = this.onFrame?.(gl) ?? false;
    const frameDurationMs = this.frameDurationMs(metadata);

    if (!this.uploadFrame(gl, width, height)) return;

    if (this.stageName === "bwdif") {
      const firstField = this.fieldOrder === "tff" ? 0 : 1;
      this.drawCurrentOutput(firstField, false);
      if (!this.video.paused && frameDurationMs > 10) {
        this.secondFieldTimer = window.setTimeout(() => {
          this.secondFieldTimer = 0;
          if (this.running && this.stageName === "bwdif") this.drawCurrentOutput(firstField === 0 ? 1 : 0, true);
        }, frameDurationMs / 2);
      }
    } else {
      this.drawCurrentOutput(0, false);
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
    const filter = this.stageFilter;
    if (!filter || !width || !height) return false;

    const ringSize = filter.historyFrames + 1;
    const isNew = this.textures.length < ringSize;
    const target = isNew ? this.createFrameTexture(gl) : this.textures[this.textures.length - 1];
    if (!target) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
    } catch (err) {
      Log.w(TAG, "Frame texture upload failed:", err);
      if (isNew) gl.deleteTexture(target);
      return false;
    }
    if (!isNew) this.textures.pop();
    this.textures.unshift(target);
    return true;
  }

  private drawCurrentOutput(field: 0 | 1, isSecondField: boolean): void {
    const gl = this.gl;
    const stageFilter = this.stageFilter;
    const passthroughPresenter = this.passthroughPresenter;
    if (!gl || !stageFilter || !passthroughPresenter || this.contextLost || this.textures.length === 0) return;

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) return;

    const enhancementReady = this.pictureEnhancementEnabled && this.ensureEnhancementResources();
    const desiredSize = enhancementReady ? this.desiredEnhancedCanvasSize(width, height) : { width, height };
    this.resizeCanvas(desiredSize.width, desiredSize.height);

    const target = this.ensureStageTarget(gl, width, height);
    if (!target) return;

    const spatialOnly = this.textures.length <= stageFilter.historyFrames;
    const params: RenderParams = { width, height, keepField: field, isSecondField, spatialOnly };

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, width, height);
    stageFilter.render(gl, this.textures, params);

    if (enhancementReady && this.bicubicPresenter) {
      try {
        const enhanced = this.runEnhancementFilters(gl, target.texture, params);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, desiredSize.width, desiredSize.height);
        this.bicubicPresenter.present(gl, enhanced, width, height, desiredSize.width, desiredSize.height);
        return;
      } catch (err) {
        Log.w(TAG, "Picture enhancement render failed; falling back to canvas presenter:", err);
      }
    }

    this.resizeCanvas(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    passthroughPresenter.present(gl, target.texture, width, height, width, height);
  }

  /**
   * Run the enhancement filter list over ping-pong targets at source
   * resolution. Returns the texture holding the final result (the stage
   * output itself when the list is empty).
   */
  private runEnhancementFilters(gl: WebGL2RenderingContext, input: WebGLTexture, params: RenderParams): WebGLTexture {
    let current = input;
    for (let i = 0; i < this.enhancementFilters.length; i++) {
      const target = this.ensureEnhancementTarget(gl, i % 2 === 0 ? 0 : 1, params.width, params.height);
      if (!target) throw new Error("Failed to create enhancement render target");
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, params.width, params.height);
      this.enhancementFilters[i].render(gl, [current], params);
      current = target.texture;
    }
    return current;
  }

  private resizeCanvas(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  private desiredEnhancedCanvasSize(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
    const rect = this.findVisibleCanvasRect();
    if (!rect) return { width: sourceWidth, height: sourceHeight };

    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const maxWidth = Math.min(sourceWidth * 2, 1920);
    const maxHeight = Math.min(sourceHeight * 2, 1088);
    const width = Math.max(sourceWidth, Math.min(Math.round(rect.width * dpr), maxWidth));
    const height = Math.max(sourceHeight, Math.min(Math.round(rect.height * dpr), maxHeight));
    return { width, height };
  }

  private findVisibleCanvasRect(): DOMRect | null {
    let element: HTMLElement | null = this.canvas;
    while (element) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
      element = element.parentElement;
    }
    return null;
  }

  private ensureStageTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
    if (this.stageTarget?.width === width && this.stageTarget.height === height) return this.stageTarget;
    this.deleteRenderTarget(this.stageTarget);
    this.stageTarget = this.createRenderTarget(gl, width, height);
    return this.stageTarget;
  }

  private ensureEnhancementTarget(
    gl: WebGL2RenderingContext,
    slot: 0 | 1,
    width: number,
    height: number,
  ): RenderTarget | null {
    const existing = this.enhancementTargets[slot];
    if (existing?.width === width && existing.height === height) return existing;
    this.deleteRenderTarget(existing);
    const next = this.createRenderTarget(gl, width, height);
    this.enhancementTargets[slot] = next;
    return next;
  }

  private createRenderTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) {
      gl.deleteTexture(texture);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(texture);
      return null;
    }

    return { fbo, texture, width, height };
  }

  private deleteRenderTarget(target: RenderTarget | null): void {
    if (!target || !this.gl || this.contextLost) return;
    this.gl.deleteFramebuffer(target.fbo);
    this.gl.deleteTexture(target.texture);
  }
}

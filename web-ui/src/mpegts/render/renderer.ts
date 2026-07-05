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
 * source stage (`passthrough` or `bwdif`) plus the enhancement filter list
 * into per-field presentation targets, then presents to the canvas (bicubic
 * upscale when enhancement sized the canvas to the display, plain blit
 * otherwise).
 *
 * Rendering and presentation are decoupled for bwdif: both fields of a frame
 * are rendered up front when the frame arrives, the first field is presented
 * immediately, and the second field is presented by a requestAnimationFrame
 * clock on the vsync nearest `expectedDisplayTime + frameDuration / 2`. A
 * setTimeout here would drift against the vsync grid and make each field's
 * on-screen duration irregular, which reads as motion judder.
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
   * Fully filtered second-field output of the current frame, rendered at
   * frame arrival and kept alive until the presentation clock shows it.
   */
  private secondFieldTarget: RenderTarget | null = null;
  /** Second field awaiting presentation, with its target display time. */
  private pendingSecondField: { presentAt: number; enhanced: boolean } | null = null;
  private presentClockHandle = 0;
  private lastPresentClockTs = -1;
  /** Recent deltas between presentation clock ticks, for refresh estimation. */
  private refreshDeltasMs: number[] = [];
  private refreshIntervalMs = 1000 / 60;

  private resizeObserver: ResizeObserver | null = null;
  private observedSizeEl: HTMLElement | null = null;
  /**
   * Document the current observer was constructed in. Used to detect cross-document
   * re-parenting (Document Picture-in-Picture moves the whole player surface into a
   * floating window) — the observed element and the canvas move together, so they can't
   * detect the change between themselves; the observer's own document can.
   */
  private observerDoc: Document | null = null;
  /**
   * Latest **device-pixel** content size of the sized container; null until first
   * measured. Stored in device pixels so the per-frame path needs no DPR read.
   */
  private cachedDisplaySize: { width: number; height: number } | null = null;

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
    this.clearPendingSecondField();
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedSizeEl = null;
    this.observerDoc = null;
    this.cachedDisplaySize = null;
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
        // The list is re-run per frame with a single input texture; a temporal
        // filter would silently never see its history. Enforce the documented
        // stateless invariant here rather than degrade quietly.
        if (filter.historyFrames !== 0) {
          throw new Error(`Enhancement filter '${name}' must be stateless (historyFrames = 0)`);
        }
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
      this.deleteRenderTarget(this.secondFieldTarget);
    }
    this.teardownEnhancementResources();
    this.clearTextureRing();
    this.stageFilter = null;
    this.passthroughPresenter = null;
    this.stageTarget = null;
    this.secondFieldTarget = null;
    this.pendingSecondField = null;
    this.enhancementInitFailed = false;
  }

  /** Drop all references to GL objects without deleting them (context is gone). */
  private forgetGlResources(): void {
    this.textures = [];
    this.stageTarget = null;
    this.secondFieldTarget = null;
    this.pendingSecondField = null;
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
    this.stopPresentClock();
    this.pendingSecondField = null;
  }

  private clearPendingSecondField(): void {
    this.pendingSecondField = null;
  }

  /**
   * Presentation clock: one requestAnimationFrame per display refresh while a
   * second field is queued. Each tick presents the queued field once its
   * target display time falls within the upcoming vsync interval, so field
   * flips always land on the vsync grid instead of a timer's completion point.
   */
  private startPresentClock(): void {
    if (this.presentClockHandle) return;
    this.presentClockHandle = window.requestAnimationFrame(this.presentClockTick);
  }

  private stopPresentClock(): void {
    if (!this.presentClockHandle) return;
    window.cancelAnimationFrame(this.presentClockHandle);
    this.presentClockHandle = 0;
    this.lastPresentClockTs = -1;
  }

  private readonly presentClockTick = (now: DOMHighResTimeStamp) => {
    this.presentClockHandle = 0;
    if (!this.running || this.stageName !== "bwdif") {
      this.lastPresentClockTs = -1;
      return;
    }

    this.updateRefreshEstimate(now);

    const pending = this.pendingSecondField;
    if (pending) {
      // Draws issued in this callback reach the screen roughly one refresh
      // from `now`. Present on the vsync closest to the field's target time:
      // if the target is more than half a refresh past this vsync, wait one
      // more tick.
      const displayTime = now + this.refreshIntervalMs;
      if (pending.presentAt <= displayTime + this.refreshIntervalMs / 2) {
        this.pendingSecondField = null;
        this.presentSecondField(pending.enhanced);
      }
    }

    // Keep ticking through playback even with no field queued: updateRefreshEstimate
    // needs a continuous stream of consecutive vsync deltas to hold a stable median
    // refresh interval, and that estimate is what aligns field flips to vsync. Only
    // present short bursts per frame would never accumulate enough clean samples.
    // Stop when idle so a paused/stalled video does not keep a rAF loop alive.
    if (this.pendingSecondField || !this.video.paused) this.startPresentClock();
    else this.lastPresentClockTs = -1;
  };

  private updateRefreshEstimate(now: DOMHighResTimeStamp): void {
    if (this.lastPresentClockTs >= 0) {
      const delta = now - this.lastPresentClockTs;
      // Ignore gaps from throttling or a stalled queue; keep clean vsync deltas.
      if (delta > 2 && delta < 60) {
        this.refreshDeltasMs.push(delta);
        if (this.refreshDeltasMs.length > 30) this.refreshDeltasMs.shift();
        if (this.refreshDeltasMs.length >= 10) {
          const sorted = [...this.refreshDeltasMs].sort((a, b) => a - b);
          this.refreshIntervalMs = sorted[sorted.length >> 1];
        }
      }
    }
    this.lastPresentClockTs = now;
  }

  private primeCanvas(): void {
    if (!this.running) return;
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const gl = this.gl;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!gl || this.contextLost || !isRenderResolutionEligible(width, height)) return;
    if (!this.uploadFrame(gl, width, height)) return;
    this.drawCurrentOutput(this.fieldOrder === "tff" ? 0 : 1);
  }

  private scheduleFrame(): void {
    this.rvfcHandle = this.video.requestVideoFrameCallback((_now, metadata) => {
      this.rvfcHandle = 0;
      if (!this.running) return;
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
      // A new frame supersedes any not-yet-presented second field.
      this.clearPendingSecondField();
      const firstField = this.fieldOrder === "tff" ? 0 : 1;
      this.drawCurrentOutput(firstField);
      if (!this.video.paused && frameDurationMs > 10) {
        this.queueSecondField(firstField === 0 ? 1 : 0, metadata.expectedDisplayTime + frameDurationMs / 2);
      }
    } else {
      this.drawCurrentOutput(0);
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

  /**
   * Render the second field through the full filter chain into its dedicated
   * target now, and let the presentation clock blit it at the vsync closest to
   * `presentAt`. Rendering up front keeps the per-frame GPU work in one burst
   * and makes the later present a cheap single draw.
   */
  private queueSecondField(field: 0 | 1, presentAt: number): void {
    const gl = this.gl;
    const stageFilter = this.stageFilter;
    if (!gl || !stageFilter || this.contextLost || this.textures.length === 0) return;

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) return;

    const dest = this.ensureSecondFieldTarget(gl, width, height);
    if (!dest) return;

    const enhancementReady = this.pictureEnhancementEnabled && this.ensureEnhancementResources();
    const spatialOnly = this.textures.length <= stageFilter.historyFrames;
    const params: RenderParams = { width, height, keepField: field, isSecondField: true, spatialOnly };

    const filters = enhancementReady ? this.enhancementFilters : [];
    const stageDest = filters.length > 0 ? this.ensureStageTarget(gl, width, height) : dest;
    if (!stageDest) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, stageDest.fbo);
    gl.viewport(0, 0, width, height);
    stageFilter.render(gl, this.textures, params);

    let enhanced = enhancementReady;
    if (filters.length > 0) {
      try {
        let current = stageDest.texture;
        for (let i = 0; i < filters.length; i++) {
          const target =
            i === filters.length - 1 ? dest : this.ensureEnhancementTarget(gl, i % 2 === 0 ? 0 : 1, width, height);
          if (!target) throw new Error("Failed to create enhancement render target");
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
          gl.viewport(0, 0, width, height);
          filters[i].render(gl, [current], params);
          current = target.texture;
        }
      } catch (err) {
        Log.w(TAG, "Second field enhancement failed; presenting unenhanced field:", err);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo);
        gl.viewport(0, 0, width, height);
        stageFilter.render(gl, this.textures, params);
        enhanced = false;
      }
    }

    this.pendingSecondField = { presentAt, enhanced };
    this.startPresentClock();
  }

  /** Blit the pre-rendered second field to the canvas. Called by the presentation clock. */
  private presentSecondField(enhanced: boolean): void {
    const gl = this.gl;
    const dest = this.secondFieldTarget;
    if (!gl || this.contextLost || !dest) return;

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    if (!canvasWidth || !canvasHeight) return;

    const presenter = enhanced && this.bicubicPresenter ? this.bicubicPresenter : this.passthroughPresenter;
    if (!presenter) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    presenter.present(gl, dest.texture, dest.width, dest.height, canvasWidth, canvasHeight);
  }

  /** Render `field` of the newest frame through the full chain and present it immediately. */
  private drawCurrentOutput(field: 0 | 1): void {
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
    const params: RenderParams = { width, height, keepField: field, isSecondField: false, spatialOnly };

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
    // Re-resolve when we have no cached size yet, the observed element detached, or the
    // player surface moved to a different document (Document Picture-in-Picture re-parents
    // it into a floating window) — detected by the observer's document diverging from the
    // canvas's current one. All checks are layout-free, so the steady-state per-frame path
    // never forces a layout.
    if (
      !this.cachedDisplaySize ||
      !this.observedSizeEl?.isConnected ||
      this.observerDoc !== this.canvas.ownerDocument
    ) {
      this.ensureSizeObserved();
    }
    const size = this.cachedDisplaySize; // already in device pixels
    if (!size) return { width: sourceWidth, height: sourceHeight };

    const maxWidth = Math.min(sourceWidth * 2, 1920);
    const maxHeight = Math.min(sourceHeight * 2, 1088);
    const width = Math.max(sourceWidth, Math.min(Math.round(size.width), maxWidth));
    const height = Math.max(sourceHeight, Math.min(Math.round(size.height), maxHeight));
    return { width, height };
  }

  private readonly handleResize = (entries: ResizeObserverEntry[]) => {
    // `device-pixel-content-box` reports exact device pixels and tracks DPR automatically,
    // so no CSS-pixel × devicePixelRatio conversion is needed.
    const box = entries[entries.length - 1]?.devicePixelContentBoxSize?.[0];
    if (!box) return;
    // Keep the last nonzero size; ignore transient 0×0 (e.g. ancestor briefly hidden).
    if (box.inlineSize > 0 && box.blockSize > 0) {
      this.cachedDisplaySize = { width: box.inlineSize, height: box.blockSize };
    }
  };

  /**
   * Nearest ancestor that generates a sized box. Starts at the canvas's parent so
   * we skip the canvas (can be display:none on the hidden slot) and its display:contents
   * wrapper, landing on the stable aspect-video container the canvas fills.
   */
  private resolveSizedAncestor(): HTMLElement | null {
    let el: HTMLElement | null = this.canvas.parentElement;
    while (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Attach the observer to the sized container and seed the cache synchronously.
   * Does DOM work only until successfully attached (RO delivers updates thereafter),
   * so the per-frame path pays no layout cost in steady state.
   */
  private ensureSizeObserved(): void {
    const target = this.resolveSizedAncestor();
    if (!target) return;

    const targetDoc = target.ownerDocument;
    const targetWindow = targetDoc.defaultView;
    if (!targetWindow) return;

    // (Re)create the observer in the target's own window whenever it doesn't exist yet or
    // the target moved to a different document. ResizeObserver delivery is driven by the
    // rendering steps of the document its global belongs to, so an observer left behind in
    // the original document goes stale once the surface is re-parented into a Document
    // Picture-in-Picture window (or restored back out of one).
    if (!this.resizeObserver || this.observerDoc !== targetDoc) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new targetWindow.ResizeObserver(this.handleResize);
      this.observerDoc = targetDoc;
      this.observedSizeEl = null;
    }

    if (target !== this.observedSizeEl) {
      if (this.observedSizeEl) this.resizeObserver.unobserve(this.observedSizeEl);
      this.observedSizeEl = target;
      this.resizeObserver.observe(target, { box: "device-pixel-content-box" });
    }

    // Seed synchronously so the current frame is correct before RO fires. getBoundingClientRect
    // is CSS px, so scale by DPR to match the device pixels the observer will report.
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const dpr = targetWindow.devicePixelRatio || 1;
      this.cachedDisplaySize = { width: rect.width * dpr, height: rect.height * dpr };
    }
  }

  private ensureStageTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
    if (this.stageTarget?.width === width && this.stageTarget.height === height) return this.stageTarget;
    this.deleteRenderTarget(this.stageTarget);
    this.stageTarget = this.createRenderTarget(gl, width, height);
    return this.stageTarget;
  }

  private ensureSecondFieldTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
    if (this.secondFieldTarget?.width === width && this.secondFieldTarget.height === height) {
      return this.secondFieldTarget;
    }
    this.deleteRenderTarget(this.secondFieldTarget);
    this.secondFieldTarget = this.createRenderTarget(gl, width, height);
    return this.secondFieldTarget;
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

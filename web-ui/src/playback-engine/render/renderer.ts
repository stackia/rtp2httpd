import Log from "../utils/logger";
import { TemporalDenoiser } from "./denoise";
import { createFilter, type RenderParams, type VideoFilter } from "./filters/types";
import { FsrPresenter } from "./fsr";
import { PassthroughPresenter, type Presenter } from "./presenters";

const TAG = "VideoRenderer";

/** WebGL video rendering targets SD/HD broadcast frames; larger frames are gated out. */
const GATE_MAX_WIDTH = 1920;
const GATE_MAX_HEIGHT = 1088;

/** `"passthrough"` means no GL source stage: the uploaded frame texture is presented directly. */
export type RenderStageName = "passthrough" | "bwdif";

/** Whether a frame size falls within the SD/HD WebGL render gate. */
export function isRenderResolutionEligible(width: number, height: number): boolean {
  return width > 0 && width <= GATE_MAX_WIDTH && height > 0 && height <= GATE_MAX_HEIGHT;
}

/**
 * Safety ceiling for the enhanced canvas backing store, so a very large
 * display rect (or a stray devicePixelRatio) cannot push the per-frame
 * EASU+RCAS cost past what a 4K display already asks for.
 */
const MAX_UPSCALE_WIDTH = 3840;
const MAX_UPSCALE_HEIGHT = 2160;

interface RenderTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface PendingField {
  presentAt: number;
  enhanced: boolean;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/**
 * WebGL2 render loop. It pulls decoded frames from the <video> element via
 * requestVideoFrameCallback, uploads them into a history ring, runs the active
 * source stage (`bwdif`, or nothing when `passthrough` — the uploaded frame
 * texture is used as-is) and temporal denoising into per-field
 * presentation targets, then presents to the canvas (FSR 1 EASU+RCAS upscale
 * when enhancement sized the canvas to the display, plain blit otherwise).
 *
 * Rendering and presentation are decoupled for bwdif: both fields of a frame
 * are rendered up front when the frame arrives, the top field is presented
 * immediately (TFF), and the bottom field is presented by a requestAnimationFrame
 * clock on the vsync nearest half a frame duration after the first field's
 * estimated display time (see `secondFieldPresentAt`). A setTimeout here
 * would drift against the vsync grid and make each field's on-screen
 * duration irregular, which reads as motion judder.
 */
export class VideoRenderer {
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private maxTextureSize = MAX_UPSCALE_WIDTH;
  /** Active source-stage filter; compiled filters remain cached while inactive. */
  private stageFilter: VideoFilter | null = null;
  /** Context-bound source-stage programs, compiled at most once per context. */
  private readonly stageFilterCache = new Map<RenderStageName, VideoFilter>();
  /** Stage programs that failed to initialise are not retried until context restoration. */
  private readonly stageFilterInitFailures = new Set<RenderStageName>();
  private stageTarget: RenderTarget | null = null;
  /** Ring of frame textures: [0] = newest, [1..] = history (most recent first). */
  private textures: WebGLTexture[] = [];
  private rvfcHandle = 0;
  private running = false;
  private destroyed = false;
  /** Decoded media pixels, before the sample aspect ratio is applied for display. */
  private frameWidth = 0;
  private frameHeight = 0;
  private contextLost = false;
  private stageName: RenderStageName = "passthrough";
  private readonly onContextLost?: () => void;
  private readonly onContextRestored?: () => void;

  private passthroughPresenter: PassthroughPresenter | null = null;
  private passthroughInitFailed = false;
  private denoiser: TemporalDenoiser | null = null;
  /** FSR (EASU+RCAS) upscale presenter for the enhancement path. */
  private upscalePresenter: Presenter | null = null;
  private pictureEnhancementEnabled = true;
  private enhancementInitFailed = false;
  /** Last uploaded frame size; enables texSubImage2D on subsequent uploads. */
  private uploadedWidth = 0;
  private uploadedHeight = 0;

  /**
   * Fully filtered second-field output of the current frame, rendered at
   * frame arrival and kept alive until the presentation clock shows it.
   */
  private secondFieldTarget: RenderTarget | null = null;
  /** Second field awaiting presentation, with its target display time. */
  private pendingSecondField: PendingField | null = null;
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
   * Whether the current `resizeObserver` is actually observing `device-pixel-content-box`.
   * Safari doesn't recognize that box option as a valid enum value and throws a TypeError
   * from `observe()` instead of ignoring it, so `ensureSizeObserved` falls back to
   * `content-box` there and `handleResize` must convert CSS px to device px itself.
   */
  private usesDevicePixelBox = true;

  /** Re-evaluate the render gate when decoded dimensions become known or change. */
  onFrameSizeChange: (() => void) | null = null;

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
    this.scheduleFrame();
  };

  private readonly handleDiscontinuity = () => {
    this.clearPendingSecondField();
    this.clearTextureRing();
    this.denoiser?.reset();
    this.lastMediaTime = -1;
  };

  private readonly handleSeeked = () => this.primeCanvas();

  private readonly handleVideoResize = () => {
    this.frameWidth = this.frameHeight = 0;
    this.handleDiscontinuity();
    this.onFrameSizeChange?.();
    this.scheduleFrame();
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
    video.addEventListener("seeking", this.handleDiscontinuity);
    video.addEventListener("emptied", this.handleVideoResize);
    video.addEventListener("resize", this.handleVideoResize);
    video.addEventListener("seeked", this.handleSeeked);
    // Learn the raster even when processing starts disabled. A later paused
    // toggle can then upload it without guessing from videoWidth/videoHeight,
    // which include sample-aspect-ratio scaling on anamorphic broadcasts.
    this.scheduleFrame();
  }

  get frameSize(): { width: number; height: number } {
    return { width: this.frameWidth, height: this.frameHeight };
  }

  /** Whether this environment can run the renderer at all. */
  static isSupported(): boolean {
    return typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
  }

  /** Toggle post-stage picture enhancement without rebuilding the media pipeline. */
  setPictureEnhancementEnabled(enabled: boolean): void {
    if (this.pictureEnhancementEnabled === enabled) return;
    this.pictureEnhancementEnabled = enabled;
    this.clearPendingSecondField();
    this.denoiser?.reset();
    if (!enabled) this.releaseEnhancementTargets();
    this.primeCanvas();
  }

  /** Switch the source stage while keeping the frame loop running. */
  setStage(stageName: RenderStageName): boolean {
    const stageFilterReady =
      stageName === "passthrough" ? this.stageFilter === null : this.stageFilter?.name === stageName;
    if (this.stageName === stageName && (!this.running || stageFilterReady)) return true;

    const previousStageName = this.stageName;
    this.stageName = stageName;
    if (!this.running) return true;

    if (!this.ensureStageFilter(stageName)) {
      this.stageName = previousStageName;
      return false;
    }
    this.clearPendingSecondField();
    this.clearTextureRing();
    this.denoiser?.reset();
    this.primeCanvas();
    Log.i(TAG, `Render stage switched to '${stageName}'`);
    return true;
  }

  /** Reset source-specific state while retaining this canvas's context and compiled programs. */
  resetStream(): void {
    this.stageName = "passthrough";
    this.stageFilter = null;
    this.frameWidth = this.frameHeight = 0;
    this.releaseStreamResources();
    this.scheduleFrame();
  }

  /** Start the frame loop with the given source stage. Safe to call repeatedly. */
  start(stageName: RenderStageName = this.stageName): boolean {
    if (this.running) {
      if (!this.setStage(stageName)) return false;
      this.primeCanvas();
      return true;
    }

    this.stageName = stageName;

    const gl = this.ensureContext();
    if (!gl) return false;

    if (!this.ensurePassthroughPresenter() || !this.ensureStageFilter(stageName)) {
      this.releaseStreamResources();
      return false;
    }

    this.running = true;
    this.primeCanvas();
    this.scheduleFrame();
    Log.i(TAG, `Frame loop started (stage '${stageName}')`);
    return true;
  }

  /** Stop the loop and release per-run GL resources. The canvas keeps its last frame. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelFrameCallbacks();
    this.releaseStreamResources();
    // Retain one metadata callback for raw playback; only an active renderer
    // keeps a continuous frame loop. Source resize/emptied events re-arm it.
    this.scheduleFrame();
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
    this.destroyed = true;
    if (this.running) {
      this.stop();
    } else {
      this.cancelFrameCallbacks();
      this.releaseStreamResources();
    }
    this.destroyContextResources();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.video.removeEventListener("seeking", this.handleDiscontinuity);
    this.video.removeEventListener("emptied", this.handleVideoResize);
    this.video.removeEventListener("resize", this.handleVideoResize);
    this.video.removeEventListener("seeked", this.handleSeeked);
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
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return gl;
  }

  private ensurePassthroughPresenter(): boolean {
    if (this.passthroughPresenter) return true;
    if (this.passthroughInitFailed) return false;
    const gl = this.ensureContext();
    if (!gl) return false;
    const presenter = new PassthroughPresenter();
    try {
      presenter.init(gl);
    } catch (err) {
      Log.e(TAG, "Failed to init canvas presenter:", err);
      presenter.destroy(gl);
      this.passthroughInitFailed = true;
      return false;
    }
    this.passthroughPresenter = presenter;
    return true;
  }

  private ensureStageFilter(name: RenderStageName): boolean {
    if (name === "passthrough") {
      // No GL source stage needed: the uploaded frame texture is presented directly.
      this.stageFilter = null;
      return true;
    }
    if (this.stageFilter?.name === name) return true;
    const cached = this.stageFilterCache.get(name);
    if (cached) {
      this.stageFilter = cached;
      return true;
    }
    if (this.stageFilterInitFailures.has(name)) return false;
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
      this.stageFilterInitFailures.add(name);
      return false;
    }

    this.stageFilterCache.set(name, filter);
    this.stageFilter = filter;
    return true;
  }

  /**
   * Lazily build the temporal denoiser and the upscale presenter. All
   * succeed or none are kept: a partial chain would silently change the look.
   *
   * The upscale presenter is FSR 1 (EASU+RCAS); if it fails to compile
   * (unsupported driver quirk, etc.) enhancement is disabled and the raw
   * passthrough presenter is used instead.
   */
  private ensureEnhancementResources(): boolean {
    if (this.enhancementInitFailed) return false;
    if (this.upscalePresenter) return true;
    const gl = this.ensureContext();
    if (!gl) return false;

    const denoiser = new TemporalDenoiser();
    const presenter: Presenter = new FsrPresenter();
    try {
      denoiser.init(gl);
      presenter.init(gl);

      this.denoiser = denoiser;
      this.upscalePresenter = presenter;
      Log.i(TAG, `Picture enhancement enabled (${presenter.name} upscale presenter active)`);
      return true;
    } catch (err) {
      Log.w(TAG, "Failed to init picture enhancement; using passthrough presenter:", err);
      denoiser.destroy(gl);
      presenter.destroy(gl);
      this.enhancementInitFailed = true;
      return false;
    }
  }

  /** Release large enhancement targets while retaining filters and presenter programs. */
  private releaseEnhancementTargets(): void {
    const gl = this.gl;
    if (gl && !this.contextLost) {
      this.denoiser?.releaseTransientResources(gl);
      this.upscalePresenter?.releaseTransientResources(gl);
    }
  }

  /** Release all source-specific textures/FBOs while keeping context-bound programs alive. */
  private releaseStreamResources(): void {
    this.stopPresentClock();
    this.pendingSecondField = null;

    const gl = this.gl;
    if (gl && !this.contextLost) {
      this.deleteRenderTarget(this.stageTarget);
      this.deleteRenderTarget(this.secondFieldTarget);
    }
    this.releaseEnhancementTargets();
    this.clearTextureRing();
    this.stageTarget = null;
    this.secondFieldTarget = null;
    this.lastMediaTime = -1;
    this.frameDurationEstimateMs = 40;
    this.lastPresentClockTs = -1;
    this.refreshDeltasMs = [];
    this.refreshIntervalMs = 1000 / 60;
  }

  /** Permanently release every GL object owned by this renderer. Called only by destroy(). */
  private destroyContextResources(): void {
    const gl = this.gl;
    if (gl && !this.contextLost) {
      for (const filter of this.stageFilterCache.values()) filter.destroy(gl);
      this.passthroughPresenter?.destroy(gl);
      this.denoiser?.destroy(gl);
      this.upscalePresenter?.destroy(gl);
    }
    this.stageFilterCache.clear();
    this.stageFilterInitFailures.clear();
    this.stageFilter = null;
    this.passthroughPresenter = null;
    this.passthroughInitFailed = false;
    this.denoiser = null;
    this.upscalePresenter = null;
    this.enhancementInitFailed = false;
  }

  /** Drop all references to GL objects without deleting them (context is gone). */
  private forgetGlResources(): void {
    this.textures = [];
    this.uploadedWidth = 0;
    this.uploadedHeight = 0;
    this.stageTarget = null;
    this.secondFieldTarget = null;
    this.pendingSecondField = null;
    this.stageFilter = null;
    this.stageFilterCache.clear();
    this.stageFilterInitFailures.clear();
    this.passthroughPresenter = null;
    this.passthroughInitFailed = false;
    this.denoiser = null;
    this.upscalePresenter = null;
    this.enhancementInitFailed = false;
    this.lastMediaTime = -1;
    this.frameDurationEstimateMs = 40;
    this.lastPresentClockTs = -1;
    this.refreshDeltasMs = [];
    this.refreshIntervalMs = 1000 / 60;
  }

  private clearTextureRing(): void {
    if (this.gl && !this.contextLost) {
      for (const texture of this.textures) {
        this.gl.deleteTexture(texture);
      }
    }
    this.textures = [];
    this.uploadedWidth = 0;
    this.uploadedHeight = 0;
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
   * Presentation clock: one requestAnimationFrame per display refresh while
   * playing. In the bwdif stage each tick presents the queued second field once
   * its target display time falls within the upcoming vsync interval, so field
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
        this.presentSecondField(pending);
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
    const width = this.frameWidth;
    const height = this.frameHeight;
    if (!gl || this.contextLost || !isRenderResolutionEligible(width, height)) return;
    this.clearPendingSecondField();
    // Toggling a setting while paused must not push the same decoded frame
    // into bwdif's ring again or recursively denoise it as fresh evidence.
    this.denoiser?.reset();
    if (
      (this.textures.length === 0 || this.uploadedWidth !== width || this.uploadedHeight !== height) &&
      !this.uploadFrame(gl, width, height)
    )
      return;
    this.drawCurrentOutput(0);
  }

  private scheduleFrame(): void {
    if (this.destroyed || this.rvfcHandle) return;
    this.rvfcHandle = this.video.requestVideoFrameCallback((now, metadata) => {
      this.rvfcHandle = 0;
      const wasRunning = this.running;
      const sizeChanged = this.frameWidth !== metadata.width || this.frameHeight !== metadata.height;
      this.frameWidth = metadata.width;
      this.frameHeight = metadata.height;
      if (sizeChanged) this.onFrameSizeChange?.();
      if (!this.running) return;
      // Starting from the size notification may have primed this frame, but
      // rVFC can arrive before HAVE_CURRENT_DATA and make primeCanvas skip it.
      // Render that decoded frame now instead of showing an empty canvas until
      // the next callback; do not upload/filter a successfully primed frame twice.
      if (wasRunning || this.textures.length === 0) this.processFrame(now, metadata);
      if (this.running) this.scheduleFrame();
    });
  }

  private processFrame(now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    const width = metadata.width;
    const height = metadata.height;
    if (!isRenderResolutionEligible(width, height)) return;

    if (this.lastMediaTime >= 0) {
      const deltaMs = (metadata.mediaTime - this.lastMediaTime) * 1000;
      if (deltaMs <= 0 || deltaMs > Math.max(100, this.frameDurationEstimateMs * 3)) {
        this.handleDiscontinuity();
      }
    }
    const frameDurationMs = this.frameDurationMs(metadata);

    if (!this.uploadFrame(gl, width, height)) return;

    if (this.stageName === "bwdif") {
      // A new frame supersedes any not-yet-presented second field. Always TFF:
      // top field first, bottom field half a frame later.
      this.clearPendingSecondField();
      this.drawCurrentOutput(0);
      if (!this.video.paused && frameDurationMs > 10) {
        this.queueSecondField(1, this.secondFieldPresentAt(now, frameDurationMs));
      }
    } else {
      this.drawCurrentOutput(0);
    }
  }

  private lastMediaTime = -1;
  private frameDurationEstimateMs = 40;

  /**
   * Target display time for the second field: half a frame after the first.
   *
   * Derived purely from the rVFC callback timestamp: the first field drawn in
   * this rendering update reaches the screen roughly one refresh from `now`,
   * so the second field is due `frameDuration / 2` after that. `now` shares
   * the rAF/performance.now() timeline the presentation clock ticks on, and
   * `refreshIntervalMs` is the median-estimated interval of that clock, so
   * this holds on any display refresh rate. `metadata.expectedDisplayTime`
   * would be the spec'd source for the same instant, but Safari reports it on
   * an unrelated clock domain (off by days), which made the presentation
   * clock's vsync test always pass and collapsed 50i to an effective 25p —
   * so it is deliberately not used.
   */
  private secondFieldPresentAt(now: DOMHighResTimeStamp, frameDurationMs: number): number {
    return now + this.refreshIntervalMs + frameDurationMs / 2;
  }

  /** Estimate the source frame duration from consecutive rVFC mediaTime values. */
  private frameDurationMs(metadata: VideoFrameCallbackMetadata): number {
    if (this.lastMediaTime >= 0) {
      const delta = (metadata.mediaTime - this.lastMediaTime) * 1000;
      if (delta > 10 && delta < 100) this.frameDurationEstimateMs = delta;
    }
    this.lastMediaTime = metadata.mediaTime;
    return this.frameDurationEstimateMs;
  }

  private createFrameTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture | null {
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Own the storage before importing video pixels. A texImage2D(video)
    // texture can alias a decoder surface that rejects texSubImage2D when
    // the next decoded frame arrives (Chromium/ANGLE Metal).
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Upload the current video frame into the texture ring. Returns false on failure. */
  private uploadFrame(gl: WebGL2RenderingContext, width: number, height: number): boolean {
    if (!width || !height) return false;

    if (this.uploadedWidth && (this.uploadedWidth !== width || this.uploadedHeight !== height)) {
      this.clearTextureRing();
      this.clearPendingSecondField();
      this.denoiser?.reset();
    }

    const ringSize = (this.stageFilter?.historyFrames ?? 0) + 1;
    const isNew = this.textures.length < ringSize;
    const target = isNew ? this.createFrameTexture(gl, width, height) : this.textures[this.textures.length - 1];
    if (!target) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target);
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, this.video);
      this.uploadedWidth = width;
      this.uploadedHeight = height;
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
   * target now, and let the presentation clock present it at the vsync closest
   * to `presentAt`. Deinterlacing and denoising run at source size; final
   * upscaling and sharpening run when the field is presented.
   */
  private queueSecondField(field: 0 | 1, presentAt: number): void {
    const gl = this.gl;
    const stageFilter = this.stageFilter;
    if (!gl || !stageFilter || this.contextLost || this.textures.length === 0) return;

    const width = this.uploadedWidth;
    const height = this.uploadedHeight;
    if (!width || !height) return;

    const dest = this.ensureSecondFieldTarget(gl, width, height);
    if (!dest) return;

    const enhancementReady = this.pictureEnhancementEnabled && this.ensureEnhancementResources();
    const spatialOnly = this.textures.length <= stageFilter.historyFrames;
    // Second-field input is always bwdif's framebuffer, already native orientation.
    const params: RenderParams = { width, height, keepField: field, isSecondField: true, spatialOnly, flipY: false };

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo);
    gl.viewport(0, 0, width, height);
    stageFilter.render(gl, this.textures, params);

    let enhanced = enhancementReady;
    let texture = dest.texture;
    if (enhancementReady && this.denoiser) {
      try {
        texture = this.denoiser.render(gl, texture, width, height, false);
      } catch (err) {
        Log.w(TAG, "Second field enhancement failed; presenting unenhanced field:", err);
        this.enhancementInitFailed = true;
        this.denoiser.reset();
        enhanced = false;
      }
    }

    // The denoiser's ping-pong output remains alive until the next frame,
    // which clears this pending field before either history target is reused.
    this.pendingSecondField = { presentAt, enhanced, texture, width, height };
    this.startPresentClock();
  }

  /** Blit the pre-rendered second field to the canvas. Called by the presentation clock. */
  private presentSecondField(dest: PendingField): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    if (!canvasWidth || !canvasHeight) return;

    const presenter = dest.enhanced && this.upscalePresenter ? this.upscalePresenter : this.passthroughPresenter;
    if (!presenter) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    try {
      // `dest` is framebuffer-backed (bwdif plus any enhancement), already in
      // native orientation, and never needs a Y-flip.
      presenter.present(gl, dest.texture, dest.width, dest.height, canvasWidth, canvasHeight, false);
    } catch (err) {
      // Never let a failed present escape into the rAF present clock. Fall back
      // to a plain passthrough blit so the field still reaches the canvas.
      Log.w(TAG, "Second field enhancement present failed; falling back to passthrough:", err);
      this.enhancementInitFailed = true;
      if (presenter !== this.passthroughPresenter) {
        this.passthroughPresenter?.present(gl, dest.texture, dest.width, dest.height, canvasWidth, canvasHeight, false);
      }
    }
  }

  /** Render `field` of the newest frame through the full chain and present it immediately. */
  private drawCurrentOutput(field: 0 | 1): void {
    const gl = this.gl;
    const stageFilter = this.stageFilter;
    const passthroughPresenter = this.passthroughPresenter;
    if (!gl || !passthroughPresenter || this.contextLost || this.textures.length === 0) return;

    const width = this.uploadedWidth;
    const height = this.uploadedHeight;
    if (!width || !height) return;

    const displayWidth = this.video.videoWidth;
    const displayHeight = this.video.videoHeight;
    const enhancementReady = this.pictureEnhancementEnabled && this.ensureEnhancementResources();
    const desiredSize = enhancementReady
      ? this.desiredEnhancedCanvasSize(Math.max(width, displayWidth), Math.max(height, displayHeight))
      : { width: displayWidth, height: displayHeight };
    this.resizeCanvas(desiredSize.width, desiredSize.height);

    const spatialOnly = this.textures.length <= (stageFilter?.historyFrames ?? 0);
    // A framebuffer-rendered stage output is already in native orientation; the raw
    // video upload sampled directly (no stage filter) needs a Y-flip.
    const sourceFlipY = !stageFilter;
    const params: RenderParams = {
      width,
      height,
      keepField: field,
      isSecondField: false,
      spatialOnly,
      flipY: sourceFlipY,
    };

    // No stage filter (plain passthrough) means the uploaded frame texture is already the
    // source: sampling it directly skips a redundant copy into an intermediate target.
    let sourceTexture: WebGLTexture;
    if (stageFilter) {
      const target = this.ensureStageTarget(gl, width, height);
      if (!target) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, width, height);
      stageFilter.render(gl, this.textures, params);
      sourceTexture = target.texture;
    } else {
      sourceTexture = this.textures[0];
    }

    if (enhancementReady && this.upscalePresenter && this.denoiser) {
      try {
        const enhanced = this.denoiser.render(gl, sourceTexture, width, height, sourceFlipY);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, desiredSize.width, desiredSize.height);
        this.upscalePresenter.present(gl, enhanced, width, height, desiredSize.width, desiredSize.height, false);
        return;
      } catch (err) {
        Log.w(TAG, "Picture enhancement render failed; falling back to canvas presenter:", err);
        this.enhancementInitFailed = true;
        this.denoiser.reset();
      }
    }

    this.resizeCanvas(displayWidth, displayHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, displayWidth, displayHeight);
    passthroughPresenter.present(gl, sourceTexture, width, height, displayWidth, displayHeight, sourceFlipY);
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

    const width = Math.max(sourceWidth, Math.min(Math.round(size.width), MAX_UPSCALE_WIDTH, this.maxTextureSize));
    const height = Math.max(sourceHeight, Math.min(Math.round(size.height), MAX_UPSCALE_HEIGHT, this.maxTextureSize));
    return { width, height };
  }

  private readonly handleResize = (entries: ResizeObserverEntry[]) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;

    let inlineSize: number;
    let blockSize: number;
    if (this.usesDevicePixelBox) {
      // `device-pixel-content-box` reports exact device pixels and tracks DPR automatically,
      // so no CSS-pixel × devicePixelRatio conversion is needed.
      const box = entry.devicePixelContentBoxSize?.[0];
      if (!box) return;
      inlineSize = box.inlineSize;
      blockSize = box.blockSize;
    } else {
      // Fallback for browsers without device-pixel-content-box support (e.g. Safari < 16.4):
      // `content-box` is reported in CSS pixels, so scale by DPR to match device pixels.
      const box = entry.contentBoxSize?.[0];
      if (!box) return;
      const dpr = this.observerDoc?.defaultView?.devicePixelRatio || 1;
      inlineSize = box.inlineSize * dpr;
      blockSize = box.blockSize * dpr;
    }

    // Keep the last nonzero size; ignore transient 0×0 (e.g. ancestor briefly hidden).
    if (inlineSize > 0 && blockSize > 0) {
      const prev = this.cachedDisplaySize;
      if (!prev || prev.width !== inlineSize || prev.height !== blockSize) {
        Log.i(TAG, `Display size changed to ${inlineSize}x${blockSize} (device px)`);
      }
      this.cachedDisplaySize = { width: inlineSize, height: blockSize };
      if (this.video.paused && (!prev || prev.width !== inlineSize || prev.height !== blockSize)) {
        this.primeCanvas();
      }
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
      try {
        this.resizeObserver.observe(target, { box: "device-pixel-content-box" });
        this.usesDevicePixelBox = true;
      } catch {
        // Safari throws a TypeError for the "device-pixel-content-box" box option instead
        // of ignoring it — fall back to content-box (CSS px, converted in handleResize).
        Log.w(TAG, "device-pixel-content-box unsupported, falling back to content-box");
        this.usesDevicePixelBox = false;
        this.resizeObserver.observe(target, { box: "content-box" });
      }
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

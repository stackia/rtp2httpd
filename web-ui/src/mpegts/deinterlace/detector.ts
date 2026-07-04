import Log from "../utils/logger";
import { createProgram, FULLSCREEN_VERTEX_SHADER } from "./algorithms/gl-utils";
import type { FieldOrder } from "./renderer";

const TAG = "InterlaceDetector";

/**
 * Heuristic interlace detection with bidirectional adaptive verdicts.
 *
 * Detection runs in one of two modes depending on whether a WebGL2 context has
 * been supplied via initGl():
 *
 * GPU mode (preferred): frames already resident in the renderer's texture ring
 * are processed by fragment shaders that compute comb score and abs-diff, then
 * reduced to an 8×8 summary via a multi-pass box filter.  A PBO carries the
 * result back to JS asynchronously — only 512 bytes cross the GPU→CPU boundary
 * per sample, and readPixels never stalls the bwdif render path.
 *
 * CPU mode (fallback): the existing Canvas 2D drawImage + getImageData path
 * used before the renderer's GL context is available or when EXT_color_buffer_float
 * is unsupported.
 *
 * The rolling-window verdict logic, reversion heuristic, and field-order vote
 * counting are identical in both modes.
 */

// ---------------------------------------------------------------------------
// Constants shared by both detection modes
// ---------------------------------------------------------------------------

const GATE_MAX_WIDTH = 1920;
const GATE_MAX_HEIGHT = 1088;
const SAMPLE_WIDTH = 256;
const FAST_SAMPLE_COUNT = 3;
const SAMPLE_INTERVAL_MS = 500;
const COMB_PIXEL_THRESHOLD = 400;
const COMBED_FRAME_RATIO = 0.01;
const WINDOW_SIZE = 12;
const COMBED_FRAMES_REQUIRED = 3;
const FIELD_ORDER_MIN_VOTES = 4;
const FIELD_ORDER_MIN_MARGIN = 2;
const FIELD_ORDER_MAX_VOTES = 10;
const MOTION_FLOOR = 1.5;
const REVERSION_FRAMES_REQUIRED = 4;

// ---------------------------------------------------------------------------
// GPU-mode constants
// ---------------------------------------------------------------------------

/**
 * Width of the intermediate detection FBO.  Matches SAMPLE_WIDTH so the GPU
 * and CPU paths share the same horizontal domain and threshold calibration.
 */
const DETECTION_WIDTH = SAMPLE_WIDTH;

/**
 * Final reduction target: the chain reduces to at most this many texels in
 * each dimension.  JS sums the resulting ≤64 values — negligible cost.
 */
const REDUCTION_TARGET = 8;

/**
 * COMB_PIXEL_THRESHOLD normalised to the [0,1]² luma space used by the GPU
 * path (original threshold is on [0,255]² integer luma).
 */
const COMB_THRESHOLD_NORMALISED = COMB_PIXEL_THRESHOLD / (255 * 255);

/**
 * MOTION_FLOOR normalised to the [0,1] range returned by the GPU abs-diff
 * shader (original value is in [0,255] integer luma).
 */
const MOTION_FLOOR_NORMALISED = MOTION_FLOOR / 255;

// ---------------------------------------------------------------------------
// GPU shader sources
// ---------------------------------------------------------------------------

/**
 * Marker pass — one fullscreen pass over the video texture.
 * Output: R = combed (0.0 or 1.0), G = abs luma diff vs prev frame [0,1].
 * Uses the same BT.709 luma weights as the bwdif algorithm.
 */
const MARKER_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform float u_height;

in vec2 v_texCoord;
out vec4 outColor;

float luma(sampler2D t, vec2 uv) {
  return dot(texture(t, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  float texelH = 1.0 / u_height;
  float cur   = luma(u_cur, v_texCoord);
  float above = luma(u_cur, vec2(v_texCoord.x, v_texCoord.y - texelH));
  float below = luma(u_cur, vec2(v_texCoord.x, v_texCoord.y + texelH));
  float dA = above - cur;
  float dB = below - cur;
  float combed  = (dA * dB > ${COMB_THRESHOLD_NORMALISED.toFixed(8)}) ? 1.0 : 0.0;
  float absDiff = abs(cur - luma(u_prev, v_texCoord));
  outColor = vec4(combed, absDiff, 0.0, 1.0);
}
`;

/**
 * Reduction pass — 2×2 box filter, reused for every step of the chain.
 * u_texelSize is 1/inputWidth, 1/inputHeight of the current step's input.
 */
const REDUCTION_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform vec2 u_texelSize;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec2 h = u_texelSize * 0.5;
  outColor = (texture(u_input, v_texCoord + vec2(-h.x, -h.y))
            + texture(u_input, v_texCoord + vec2( h.x, -h.y))
            + texture(u_input, v_texCoord + vec2(-h.x,  h.y))
            + texture(u_input, v_texCoord + vec2( h.x,  h.y))) * 0.25;
}
`;

/**
 * Field-order pass — renders to a half-height FBO (one output row per even
 * input row).  Mirrors the fieldOrderVote() formula: compares the TFF and BFF
 * temporal midpoint predictions for each row pair.
 * Output: R = errTff, G = errBff (per-row mean absolute error).
 */
const FIELD_ORDER_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_cur;
uniform float u_height;

in vec2 v_texCoord;
out vec4 outColor;

float L(sampler2D t, float x, float rowF) {
  return dot(texture(t, vec2(x, rowF / u_height)).rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  // v_texCoord.y in [0,1] maps to half-height FBO rows; each corresponds to
  // an even row of the source frame (0, 2, 4, ...).
  float row = floor(v_texCoord.y * (u_height * 0.5)) * 2.0;
  float x   = v_texCoord.x;

  float tPrev      = L(u_prev, x, row);
  float tPrevBelow = L(u_prev, x, row + 2.0);
  float tCur       = L(u_cur,  x, row);
  float tCurBelow  = L(u_cur,  x, row + 2.0);
  float bPrevAbove = L(u_prev, x, row - 1.0);
  float bPrev      = L(u_prev, x, row + 1.0);
  float bCurAbove  = L(u_cur,  x, row - 1.0);
  float bCur       = L(u_cur,  x, row + 1.0);

  float errTff = abs(bPrev - (tPrev + tPrevBelow + tCur + tCurBelow) * 0.25);
  float errBff = abs(tPrev - (bPrevAbove + bPrev + bCurAbove + bCur) * 0.25);

  outColor = vec4(errTff, errBff, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DetectorVerdict {
  interlaced: boolean;
  algorithm: "bwdif";
  fieldOrder: FieldOrder;
}

/** Metrics returned by the GPU detection path after readPendingGpu(). */
export interface DetectionGpuMetrics {
  /** Fraction of pixels flagged as combed, [0,1]. */
  combRatio: number;
  /** Mean per-pixel abs luma diff vs previous frame, [0,1]. */
  motionScore: number;
  /** Mean per-row TFF hypothesis error (from field-order pass), [0,1]. */
  errTff: number;
  /** Mean per-row BFF hypothesis error (from field-order pass), [0,1]. */
  errBff: number;
  /** True when errTff/errBff are valid (field-order pass was issued). */
  hasFieldOrder: boolean;
}

// ---------------------------------------------------------------------------
// Exported pure functions (used by tests)
// ---------------------------------------------------------------------------

/**
 * Field-order vote from two consecutive weaved frames.
 * Returns "tff", "bff", or undefined when there is insufficient motion.
 */
export function fieldOrderVote(
  prevLuma: Uint8Array,
  curLuma: Uint8Array,
  width: number,
  height: number,
): FieldOrder | undefined {
  let errTff = 0;
  let errBff = 0;
  for (let y = 2; y + 2 < height; y += 2) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tPrev = prevLuma[i];
      const tPrevBelow = prevLuma[i + 2 * width];
      const tCur = curLuma[i];
      const tCurBelow = curLuma[i + 2 * width];
      const bPrevAbove = prevLuma[i - width];
      const bPrev = prevLuma[i + width];
      const bCurAbove = curLuma[i - width];
      const bCur = curLuma[i + width];
      errTff += Math.abs(bPrev - (tPrev + tPrevBelow + tCur + tCurBelow) / 4);
      errBff += Math.abs(tPrev - (bPrevAbove + bPrev + bCurAbove + bCur) / 4);
    }
  }
  const samples = width * Math.floor((height - 4) / 2);
  if (samples <= 0) return undefined;
  if ((errTff + errBff) / samples < 1.0) return undefined;
  if (errTff < errBff * 0.9) return "tff";
  if (errBff < errTff * 0.9) return "bff";
  return undefined;
}

/**
 * Comb metric on a grayscale (luma) plane.
 * Returns the fraction of pixels flagged as combed.
 */
export function combScore(luma: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  if (height < 3) return 0;
  let combed = 0;
  const total = width * (height - 2);
  for (let y = 1; y < height - 1; y++) {
    const rowAbove = (y - 1) * width;
    const row = y * width;
    const rowBelow = (y + 1) * width;
    for (let x = 0; x < width; x++) {
      const cur = luma[row + x];
      const dAbove = luma[rowAbove + x] - cur;
      const dBelow = luma[rowBelow + x] - cur;
      if (dAbove * dBelow > COMB_PIXEL_THRESHOLD) {
        combed++;
      }
    }
  }
  return combed / total;
}

// ---------------------------------------------------------------------------
// InterlaceDetector
// ---------------------------------------------------------------------------

interface DetectionFbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export class InterlaceDetector {
  private readonly video: HTMLVideoElement;
  private readonly onVerdict: (verdict: DetectorVerdict) => void;

  // ---- CPU-mode state ----
  private sampleCanvas: HTMLCanvasElement | null = null;
  private sampleCtx: CanvasRenderingContext2D | null = null;
  private timer = 0;
  private window: boolean[] = [];
  private interlaced = false;
  private prevLuma: Uint8Array | null = null;
  private reversionConsecutiveCount = 0;
  private gated = false;
  private fieldOrder: FieldOrder = "tff";
  private fieldOrderDecided = false;
  private votesTff = 0;
  private votesBff = 0;
  private votingRounds = 0;
  /** Invalidates in-flight rVFC vote captures across reset/stop. */
  private voteGen = 0;

  // ---- GPU-mode state ----
  private useGpu = false;
  /** Compiled programs; non-null while GPU mode is active. */
  private markerProgram: WebGLProgram | null = null;
  private reductionProgram: WebGLProgram | null = null;
  private fieldOrderProgram: WebGLProgram | null = null;
  /** Marker FBO: DETECTION_WIDTH × videoHeight, RGBA16F. */
  private markerFbo: DetectionFbo | null = null;
  /** Reduction chain: progressively halved until ≤ REDUCTION_TARGET. */
  private reductionFbos: DetectionFbo[] = [];
  /** Field-order FBO: DETECTION_WIDTH × ceil(videoHeight/2), RGBA16F. */
  private fieldOrderFbo: DetectionFbo | null = null;
  /** Reduction chain for the field-order pass, same structure. */
  private fieldOrderReductionFbos: DetectionFbo[] = [];
  /**
   * Pixel Buffer Object for async readback.
   * Sized to hold REDUCTION_TARGET×REDUCTION_TARGET RGBA float values.
   */
  private pbo: WebGLBuffer | null = null;
  private fieldOrderPbo: WebGLBuffer | null = null;
  /** True while a non-blocking readPixels result is pending in pbo. */
  private pboPending = false;
  private fieldOrderPboPending = false;
  /** Tracked to detect resolution changes that require FBO reallocation. */
  private gpuVideoWidth = 0;
  private gpuVideoHeight = 0;
  /** Whether the field-order pass should be included in the next sampleGpu call. */
  private gpuFieldOrderDue = false;

  constructor(video: HTMLVideoElement, onVerdict: (verdict: DetectorVerdict) => void) {
    this.video = video;
    this.onVerdict = onVerdict;
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.scheduleInitialFastSamples();
    if (!this.useGpu) {
      // GPU cadence is driven externally via onDetectionFrame; CPU mode uses a
      // timer.
      this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    } else {
      // Use a sentinel value so start() is idempotent and stop() can clear it.
      this.timer = -1;
    }
    if (this.interlaced && !this.fieldOrderDecided) {
      this.scheduleFieldOrderVote();
    }
  }

  stop(): void {
    if (!this.timer) return;
    if (this.timer > 0) window.clearInterval(this.timer);
    this.timer = 0;
    this.voteGen++;
  }

  reset(): void {
    this.window = [];
    this.prevLuma = null;
    this.reversionConsecutiveCount = 0;
    if (this.interlaced) {
      this.interlaced = false;
      this.onVerdict({ interlaced: false, algorithm: "bwdif", fieldOrder: "tff" });
    }
    this.gated = false;
    this.fieldOrder = "tff";
    this.fieldOrderDecided = false;
    this.votesTff = 0;
    this.votesBff = 0;
    this.votingRounds = 0;
    this.voteGen++;
    this.pboPending = false;
    this.fieldOrderPboPending = false;
    this.gpuFieldOrderDue = false;
    if (this.timer) {
      this.scheduleInitialFastSamples();
    }
  }

  destroy(): void {
    this.stop();
    this.sampleCanvas = null;
    this.sampleCtx = null;
  }

  // -------------------------------------------------------------------------
  // GPU-mode lifecycle (called from index.ts)
  // -------------------------------------------------------------------------

  /** Returns true when EXT_color_buffer_float is available (RGBA16F FBO support). */
  static isGpuDetectionSupported(gl: WebGL2RenderingContext): boolean {
    return gl.getExtension("EXT_color_buffer_float") !== null;
  }

  /**
   * Compile shaders and allocate the PBO.  FBOs are allocated lazily on the
   * first sampleGpu() call (resolution is not yet known here).
   * Calling this switches the detector to GPU mode and clears any CPU timer.
   */
  initGl(gl: WebGL2RenderingContext): void {
    if (this.useGpu) return;
    if (!InterlaceDetector.isGpuDetectionSupported(gl)) {
      Log.w(TAG, "EXT_color_buffer_float unavailable; staying on CPU detection path");
      return;
    }
    try {
      this.markerProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, MARKER_FRAGMENT_SHADER);
      this.reductionProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, REDUCTION_FRAGMENT_SHADER);
      this.fieldOrderProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, FIELD_ORDER_FRAGMENT_SHADER);
    } catch (err) {
      Log.e(TAG, "Failed to compile detection shaders; staying on CPU path:", err);
      this.cleanupGlPrograms(gl);
      return;
    }

    const pboBytes = REDUCTION_TARGET * REDUCTION_TARGET * 4 * 4; // 4 floats × 4 bytes per RGBA16F texel
    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, pboBytes, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    this.fieldOrderPbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.fieldOrderPbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, pboBytes, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    this.useGpu = true;
    Log.i(TAG, "GPU detection path initialised");

    // Switch the running timer from CPU setInterval to the GPU sentinel value.
    if (this.timer > 0) {
      window.clearInterval(this.timer);
      this.timer = -1;
    }
  }

  /**
   * Release all GPU resources.  Switches the detector back to CPU mode and
   * restarts the CPU timer if the detector is currently running.
   */
  destroyGl(gl: WebGL2RenderingContext): void {
    if (!this.useGpu) return;
    this.useGpu = false;
    this.pboPending = false;
    this.fieldOrderPboPending = false;
    this.gpuFieldOrderDue = false;

    this.cleanupGlPrograms(gl);
    this.freeDetectionFbo(gl, this.markerFbo);
    this.markerFbo = null;
    for (const fbo of this.reductionFbos) this.freeDetectionFbo(gl, fbo);
    this.reductionFbos = [];
    this.freeDetectionFbo(gl, this.fieldOrderFbo);
    this.fieldOrderFbo = null;
    for (const fbo of this.fieldOrderReductionFbos) this.freeDetectionFbo(gl, fbo);
    this.fieldOrderReductionFbos = [];

    if (this.pbo) { gl.deleteBuffer(this.pbo); this.pbo = null; }
    if (this.fieldOrderPbo) { gl.deleteBuffer(this.fieldOrderPbo); this.fieldOrderPbo = null; }
    this.gpuVideoWidth = 0;
    this.gpuVideoHeight = 0;

    // Restart CPU sampling if the detector is still active.
    if (this.timer === -1) {
      this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    }
    Log.i(TAG, "GPU detection path destroyed; reverting to CPU path");
  }

  onGlContextLost(): void {
    if (!this.useGpu) return;
    // Resources are already gone at the driver level; just reset bookkeeping.
    this.useGpu = false;
    this.markerProgram = null;
    this.reductionProgram = null;
    this.fieldOrderProgram = null;
    this.markerFbo = null;
    this.reductionFbos = [];
    this.fieldOrderFbo = null;
    this.fieldOrderReductionFbos = [];
    this.pbo = null;
    this.fieldOrderPbo = null;
    this.pboPending = false;
    this.fieldOrderPboPending = false;
    this.gpuFieldOrderDue = false;
    this.gpuVideoWidth = 0;
    this.gpuVideoHeight = 0;
    if (this.timer === -1) {
      this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    }
    Log.w(TAG, "GL context lost; reverting to CPU detection path");
  }

  onGlContextRestored(gl: WebGL2RenderingContext): void {
    this.initGl(gl);
  }

  // -------------------------------------------------------------------------
  // GPU sampling (called from index.ts via renderer.onDetectionFrame)
  // -------------------------------------------------------------------------

  /**
   * Issue a GPU detection sample.  Must only be called when useGpu is true.
   *
   * syncReadback = true (fast phase at startup): issues a synchronous
   * readPixels so processSampleMetrics() can run immediately.  The brief stall
   * is acceptable because it only happens on the first few frames.
   *
   * syncReadback = false (steady state): non-blocking readPixels into a PBO;
   * result is retrieved via readPendingGpu() on the NEXT sampleGpu() call.
   */
  sampleGpu(
    gl: WebGL2RenderingContext,
    curTexture: WebGLTexture,
    prevTexture: WebGLTexture | null,
    videoWidth: number,
    videoHeight: number,
    syncReadback: boolean,
  ): void {
    if (!this.useGpu || !this.markerProgram || !this.reductionProgram) return;

    if (videoWidth !== this.gpuVideoWidth || videoHeight !== this.gpuVideoHeight) {
      this.reallocGlFbos(gl, videoWidth, videoHeight);
    }
    if (!this.markerFbo || this.reductionFbos.length === 0) return;

    const effectivePrev = prevTexture ?? curTexture;

    // ---- Marker pass ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.markerFbo.fbo);
    gl.viewport(0, 0, this.markerFbo.width, this.markerFbo.height);
    gl.useProgram(this.markerProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, curTexture);
    gl.uniform1i(gl.getUniformLocation(this.markerProgram, "u_cur"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, effectivePrev);
    gl.uniform1i(gl.getUniformLocation(this.markerProgram, "u_prev"), 1);
    gl.uniform1f(gl.getUniformLocation(this.markerProgram, "u_height"), videoHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- Reduction chain ----
    this.runReductionChain(gl, this.markerFbo, this.reductionFbos);

    // ---- Readback ----
    const finalFbo = this.reductionFbos[this.reductionFbos.length - 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, finalFbo.fbo);
    if (syncReadback) {
      const result = new Float32Array(finalFbo.width * finalFbo.height * 4);
      gl.readPixels(0, 0, finalFbo.width, finalFbo.height, gl.RGBA, gl.FLOAT, result);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const metrics = this.computeMetricsFromBuffer(result, finalFbo.width * finalFbo.height, false, null);
      this.processSampleMetrics(metrics);
    } else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, finalFbo.width, finalFbo.height, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.pboPending = true;
    }

    // ---- Optional field-order pass ----
    if (
      this.gpuFieldOrderDue &&
      this.fieldOrderFbo &&
      this.fieldOrderProgram &&
      this.fieldOrderReductionFbos.length > 0
    ) {
      this.gpuFieldOrderDue = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldOrderFbo.fbo);
      gl.viewport(0, 0, this.fieldOrderFbo.width, this.fieldOrderFbo.height);
      gl.useProgram(this.fieldOrderProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, effectivePrev);
      gl.uniform1i(gl.getUniformLocation(this.fieldOrderProgram, "u_prev"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curTexture);
      gl.uniform1i(gl.getUniformLocation(this.fieldOrderProgram, "u_cur"), 1);
      gl.uniform1f(gl.getUniformLocation(this.fieldOrderProgram, "u_height"), videoHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this.runReductionChain(gl, this.fieldOrderFbo, this.fieldOrderReductionFbos);

      const foFinal = this.fieldOrderReductionFbos[this.fieldOrderReductionFbos.length - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, foFinal.fbo);
      if (syncReadback) {
        const foResult = new Float32Array(foFinal.width * foFinal.height * 4);
        gl.readPixels(0, 0, foFinal.width, foFinal.height, gl.RGBA, gl.FLOAT, foResult);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.applyFieldOrderReadback(foResult, foFinal.width * foFinal.height);
      } else {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.fieldOrderPbo);
        gl.readPixels(0, 0, foFinal.width, foFinal.height, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.fieldOrderPboPending = true;
      }
    }

    // Restore GL state so the bwdif renderer's next draw call starts clean.
    gl.useProgram(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Retrieve the result of the previous non-blocking sampleGpu() call.
   * The 500 ms steady-state interval guarantees the GPU has finished writing
   * to the PBO, so getBufferSubData does not stall.
   * Returns null if no PBO readback is pending.
   */
  readPendingGpu(gl: WebGL2RenderingContext): DetectionGpuMetrics | null {
    if (!this.pboPending || !this.pbo) return null;
    this.pboPending = false;

    const finalFbo = this.reductionFbos[this.reductionFbos.length - 1];
    if (!finalFbo) return null;
    const texelCount = finalFbo.width * finalFbo.height;
    const mainBuffer = new Float32Array(texelCount * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, mainBuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    let foBuffer: Float32Array | null = null;
    if (this.fieldOrderPboPending && this.fieldOrderPbo) {
      this.fieldOrderPboPending = false;
      const foFinal = this.fieldOrderReductionFbos[this.fieldOrderReductionFbos.length - 1];
      if (foFinal) {
        foBuffer = new Float32Array(foFinal.width * foFinal.height * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.fieldOrderPbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, foBuffer);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      }
    }

    return this.computeMetricsFromBuffer(mainBuffer, texelCount, foBuffer !== null, foBuffer);
  }

  // -------------------------------------------------------------------------
  // GPU shared verdict logic
  // -------------------------------------------------------------------------

  /**
   * Apply detection metrics (from either GPU or CPU path) to the rolling
   * window and emit a verdict when warranted.  The logic mirrors the body of
   * the CPU sample() method exactly; only the data source differs.
   */
  processSampleMetrics(metrics: DetectionGpuMetrics): void {
    const isCombed = metrics.combRatio >= COMBED_FRAME_RATIO;
    const hasPrevFrame = metrics.motionScore > 0;
    const motionSufficient = metrics.motionScore >= MOTION_FLOOR_NORMALISED;

    if (this.interlaced) {
      if (!hasPrevFrame || !motionSufficient) {
        this.reversionConsecutiveCount = 0;
        return;
      }
      if (isCombed) {
        this.reversionConsecutiveCount = 0;
        return;
      }
      this.reversionConsecutiveCount++;
      Log.d(
        TAG,
        `Reversion candidate ${this.reversionConsecutiveCount}/${REVERSION_FRAMES_REQUIRED} ` +
          `(motion=${metrics.motionScore.toFixed(4)}, comb=${metrics.combRatio.toFixed(4)})`,
      );
      if (this.reversionConsecutiveCount >= REVERSION_FRAMES_REQUIRED) {
        Log.i(TAG, "Progressive content detected; reverting interlaced verdict");
        this.resetVerdict();
      }
      return;
    }

    this.window.push(isCombed);
    if (this.window.length > WINDOW_SIZE) this.window.shift();

    const combedFrames = this.window.filter(Boolean).length;
    if (combedFrames >= COMBED_FRAMES_REQUIRED) {
      this.interlaced = true;
      this.reversionConsecutiveCount = 0;
      Log.i(
        TAG,
        `Interlaced content detected via comb heuristic (${combedFrames}/${this.window.length} combed frames)`,
      );
      this.onVerdict({ interlaced: true, algorithm: "bwdif", fieldOrder: this.fieldOrder });
      if (this.useGpu) {
        // In GPU mode trigger the field-order pass on the next sampleGpu() call
        // rather than scheduling a separate rVFC pair as the CPU path does.
        if (!this.fieldOrderDecided && this.votingRounds < FIELD_ORDER_MAX_VOTES) {
          this.gpuFieldOrderDue = true;
        }
      } else {
        this.scheduleFieldOrderVote();
      }
    }

    if (metrics.hasFieldOrder) {
      this.applyFieldOrderMetrics(metrics.errTff, metrics.errBff);
    }
  }

  // -------------------------------------------------------------------------
  // GPU private helpers
  // -------------------------------------------------------------------------

  private computeMetricsFromBuffer(
    buffer: Float32Array,
    texelCount: number,
    hasFieldOrder: boolean,
    foBuffer: Float32Array | null,
  ): DetectionGpuMetrics {
    let combSum = 0;
    let diffSum = 0;
    for (let i = 0; i < texelCount; i++) {
      combSum += buffer[i * 4];
      diffSum += buffer[i * 4 + 1];
    }
    const combRatio = texelCount > 0 ? combSum / texelCount : 0;
    const motionScore = texelCount > 0 ? diffSum / texelCount : 0;

    let errTff = 0;
    let errBff = 0;
    if (hasFieldOrder && foBuffer) {
      const foTexels = foBuffer.length / 4;
      for (let i = 0; i < foTexels; i++) {
        errTff += foBuffer[i * 4];
        errBff += foBuffer[i * 4 + 1];
      }
      if (foTexels > 0) { errTff /= foTexels; errBff /= foTexels; }
    }

    return { combRatio, motionScore, errTff, errBff, hasFieldOrder };
  }

  private applyFieldOrderReadback(foResult: Float32Array, texelCount: number): void {
    let errTff = 0;
    let errBff = 0;
    for (let i = 0; i < texelCount; i++) {
      errTff += foResult[i * 4];
      errBff += foResult[i * 4 + 1];
    }
    if (texelCount > 0) { errTff /= texelCount; errBff /= texelCount; }
    this.applyFieldOrderMetrics(errTff, errBff);
  }

  private applyFieldOrderMetrics(errTff: number, errBff: number): void {
    if (this.fieldOrderDecided || this.votingRounds >= FIELD_ORDER_MAX_VOTES) return;
    // Motion gate: total error too small means the scene is static, abstain.
    if (errTff + errBff < 1.0 / 255) return;
    this.votingRounds++;
    if (errTff < errBff * 0.9) this.votesTff++;
    else if (errBff < errTff * 0.9) this.votesBff++;
    this.maybeDecideFieldOrder();
    // Schedule more field-order passes until the verdict is settled.
    if (!this.fieldOrderDecided && this.votingRounds < FIELD_ORDER_MAX_VOTES && this.useGpu) {
      this.gpuFieldOrderDue = true;
    }
  }

  private runReductionChain(
    gl: WebGL2RenderingContext,
    seedFbo: DetectionFbo,
    reductionFbos: DetectionFbo[],
  ): void {
    let inputFbo = seedFbo;
    for (const outputFbo of reductionFbos) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo.fbo);
      gl.viewport(0, 0, outputFbo.width, outputFbo.height);
      gl.useProgram(this.reductionProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputFbo.tex);
      gl.uniform1i(gl.getUniformLocation(this.reductionProgram!, "u_input"), 0);
      gl.uniform2f(
        gl.getUniformLocation(this.reductionProgram!, "u_texelSize"),
        1.0 / inputFbo.width,
        1.0 / inputFbo.height,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      inputFbo = outputFbo;
    }
  }

  private reallocGlFbos(gl: WebGL2RenderingContext, videoWidth: number, videoHeight: number): void {
    for (const fbo of this.reductionFbos) this.freeDetectionFbo(gl, fbo);
    this.reductionFbos = [];
    this.freeDetectionFbo(gl, this.markerFbo);
    this.markerFbo = null;
    for (const fbo of this.fieldOrderReductionFbos) this.freeDetectionFbo(gl, fbo);
    this.fieldOrderReductionFbos = [];
    this.freeDetectionFbo(gl, this.fieldOrderFbo);
    this.fieldOrderFbo = null;

    this.gpuVideoWidth = videoWidth;
    this.gpuVideoHeight = videoHeight;

    const markerHeight = videoHeight;
    this.markerFbo = this.createDetectionFbo(gl, DETECTION_WIDTH, markerHeight);
    if (!this.markerFbo) return;
    this.reductionFbos = this.buildReductionChain(gl, DETECTION_WIDTH, markerHeight);

    const foHeight = Math.max(1, Math.ceil(videoHeight / 2));
    this.fieldOrderFbo = this.createDetectionFbo(gl, DETECTION_WIDTH, foHeight);
    if (this.fieldOrderFbo) {
      this.fieldOrderReductionFbos = this.buildReductionChain(gl, DETECTION_WIDTH, foHeight);
    }
  }

  private buildReductionChain(
    gl: WebGL2RenderingContext,
    seedWidth: number,
    seedHeight: number,
  ): DetectionFbo[] {
    const chain: DetectionFbo[] = [];
    let width = seedWidth;
    let height = seedHeight;
    while (width > REDUCTION_TARGET || height > REDUCTION_TARGET) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
      const fbo = this.createDetectionFbo(gl, width, height);
      if (!fbo) break;
      chain.push(fbo);
    }
    return chain;
  }

  private createDetectionFbo(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ): DetectionFbo | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();
    if (!fbo) { gl.deleteTexture(tex); return null; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return null;
    }
    return { fbo, tex, width, height };
  }

  private freeDetectionFbo(gl: WebGL2RenderingContext, fbo: DetectionFbo | null): void {
    if (!fbo) return;
    gl.deleteFramebuffer(fbo.fbo);
    gl.deleteTexture(fbo.tex);
  }

  private cleanupGlPrograms(gl: WebGL2RenderingContext): void {
    if (this.markerProgram) { gl.deleteProgram(this.markerProgram); this.markerProgram = null; }
    if (this.reductionProgram) { gl.deleteProgram(this.reductionProgram); this.reductionProgram = null; }
    if (this.fieldOrderProgram) { gl.deleteProgram(this.fieldOrderProgram); this.fieldOrderProgram = null; }
  }

  // -------------------------------------------------------------------------
  // CPU-mode private methods (unchanged from original implementation)
  // -------------------------------------------------------------------------

  private scheduleInitialFastSamples(): void {
    const gen = this.voteGen;
    let remaining = FAST_SAMPLE_COUNT;
    const onFrame = () => {
      if (gen !== this.voteGen || this.timer === 0) return;
      const sampled = this.sample();
      if (sampled) remaining--;
      if (remaining > 0) {
        this.video.requestVideoFrameCallback(onFrame);
      }
    };
    this.video.requestVideoFrameCallback(onFrame);
  }

  private resolutionEligible(width: number, height: number): boolean {
    return width > 0 && width <= GATE_MAX_WIDTH && height > 0 && height <= GATE_MAX_HEIGHT;
  }

  private sample(): boolean {
    const video = this.video;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.paused || video.seeking) {
      return false;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!this.resolutionEligible(width, height)) {
      if (!this.gated && width > 0) {
        this.gated = true;
        Log.d(TAG, `Resolution ${width}x${height} not eligible for deinterlacing`);
      }
      if (this.interlaced || this.window.length) this.reset();
      return false;
    }
    this.gated = false;

    if (!this.ensureSampleCtx()) {
      Log.e(TAG, "2D sampling context unavailable; detector disabled");
      this.stop();
      return false;
    }
    const canvas = this.sampleCanvas as HTMLCanvasElement;
    if (canvas.width !== SAMPLE_WIDTH || canvas.height !== height) {
      canvas.width = SAMPLE_WIDTH;
      canvas.height = height;
    }

    const ctx = this.sampleCtx as CanvasRenderingContext2D;
    let imageData: ImageData;
    try {
      ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, height);
      imageData = ctx.getImageData(0, 0, SAMPLE_WIDTH, height);
    } catch (err) {
      Log.d(TAG, "Frame sampling failed:", err);
      return false;
    }

    const rgba = imageData.data;
    const luma = new Uint8Array(SAMPLE_WIDTH * height);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      luma[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
    }

    const motionScore = this.computeMotionScore(luma);
    const prevLumaSnapshot = this.prevLuma;
    this.prevLuma = luma;

    const score = combScore(luma, SAMPLE_WIDTH, height);

    if (this.interlaced) {
      if (prevLumaSnapshot === null || motionScore < MOTION_FLOOR) {
        this.reversionConsecutiveCount = 0;
        return true;
      }
      if (score >= COMBED_FRAME_RATIO) {
        this.reversionConsecutiveCount = 0;
        return true;
      }
      this.reversionConsecutiveCount++;
      Log.d(
        TAG,
        `Reversion candidate ${this.reversionConsecutiveCount}/${REVERSION_FRAMES_REQUIRED} (motion=${motionScore.toFixed(2)}, comb=${score.toFixed(4)})`,
      );
      if (this.reversionConsecutiveCount >= REVERSION_FRAMES_REQUIRED) {
        Log.i(TAG, "Progressive content detected; reverting interlaced verdict");
        this.resetVerdict();
      }
      return true;
    }

    this.window.push(score >= COMBED_FRAME_RATIO);
    if (this.window.length > WINDOW_SIZE) this.window.shift();

    const combedFrames = this.window.filter(Boolean).length;
    if (combedFrames >= COMBED_FRAMES_REQUIRED) {
      this.interlaced = true;
      this.reversionConsecutiveCount = 0;
      Log.i(
        TAG,
        `Interlaced content detected via comb heuristic (${combedFrames}/${this.window.length} combed frames)`,
      );
      this.onVerdict({ interlaced: true, algorithm: "bwdif", fieldOrder: this.fieldOrder });
      this.scheduleFieldOrderVote();
    }
    return true;
  }

  private computeMotionScore(currentLuma: Uint8Array): number {
    const previousLuma = this.prevLuma;
    if (!previousLuma || previousLuma.length !== currentLuma.length) return 0;
    let totalAbsDiff = 0;
    for (let i = 0; i < currentLuma.length; i++) {
      totalAbsDiff += Math.abs(currentLuma[i] - previousLuma[i]);
    }
    return totalAbsDiff / currentLuma.length;
  }

  private resetVerdict(): void {
    this.interlaced = false;
    this.window = [];
    this.prevLuma = null;
    this.reversionConsecutiveCount = 0;
    this.fieldOrder = "tff";
    this.fieldOrderDecided = false;
    this.votesTff = 0;
    this.votesBff = 0;
    this.votingRounds = 0;
    this.voteGen++;
    this.onVerdict({ interlaced: false, algorithm: "bwdif", fieldOrder: "tff" });
  }

  private ensureSampleCtx(): boolean {
    if (this.sampleCtx) return true;
    this.sampleCanvas = document.createElement("canvas");
    this.sampleCtx = this.sampleCanvas.getContext("2d", { willReadFrequently: true, alpha: false });
    return this.sampleCtx !== null;
  }

  private grabLuma(width: number, height: number): Uint8Array | null {
    if (!this.ensureSampleCtx()) return null;
    const ctx = this.sampleCtx as CanvasRenderingContext2D;
    const canvas = this.sampleCanvas;
    if (!ctx || !canvas) return null;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    try {
      ctx.drawImage(this.video, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const luma = new Uint8Array(width * height);
      for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
        luma[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
      }
      return luma;
    } catch {
      return null;
    }
  }

  private scheduleFieldOrderVote(): void {
    if (this.fieldOrderDecided || this.votingRounds >= FIELD_ORDER_MAX_VOTES) return;
    const gen = this.voteGen;
    const video = this.video;
    const height = video.videoHeight;

    const retry = () => {
      window.setTimeout(() => {
        if (gen === this.voteGen) this.scheduleFieldOrderVote();
      }, SAMPLE_INTERVAL_MS);
    };
    if (!height || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      retry();
      return;
    }
    if (!this.resolutionEligible(video.videoWidth, height)) return;

    const prevLuma = this.grabLuma(SAMPLE_WIDTH, height);
    if (!prevLuma) {
      retry();
      return;
    }

    video.requestVideoFrameCallback(() => {
      if (gen !== this.voteGen) return;
      const curLuma = this.grabLuma(SAMPLE_WIDTH, video.videoHeight);
      if (curLuma && curLuma.length === prevLuma.length) {
        this.votingRounds++;
        const vote = fieldOrderVote(prevLuma, curLuma, SAMPLE_WIDTH, video.videoHeight);
        if (vote === "tff") this.votesTff++;
        else if (vote === "bff") this.votesBff++;
        this.maybeDecideFieldOrder();
      }
      if (!this.fieldOrderDecided && this.votingRounds < FIELD_ORDER_MAX_VOTES) {
        window.setTimeout(() => {
          if (gen === this.voteGen) this.scheduleFieldOrderVote();
        }, SAMPLE_INTERVAL_MS);
      }
    });
  }

  private maybeDecideFieldOrder(): void {
    const votesTff = this.votesTff;
    const votesBff = this.votesBff;
    const total = votesTff + votesBff;
    const margin = Math.abs(votesTff - votesBff);
    const exhausted = this.votingRounds >= FIELD_ORDER_MAX_VOTES;
    if (total < FIELD_ORDER_MIN_VOTES && !exhausted) return;
    if (margin < FIELD_ORDER_MIN_MARGIN && !exhausted) return;

    this.fieldOrderDecided = true;
    const winner: FieldOrder = margin >= FIELD_ORDER_MIN_MARGIN && votesBff > votesTff ? "bff" : "tff";
    Log.i(TAG, `Field order: ${winner} (tff=${votesTff}, bff=${votesBff}, rounds=${this.votingRounds})`);
    if (winner !== this.fieldOrder) {
      this.fieldOrder = winner;
      if (this.interlaced) {
        this.onVerdict({ interlaced: true, algorithm: "bwdif", fieldOrder: winner });
      }
    }
  }
}

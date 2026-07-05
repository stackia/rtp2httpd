import Log from "../utils/logger";
import { createProgram, FULLSCREEN_VERTEX_SHADER } from "./filters/gl-utils";
import type { FieldOrder } from "./renderer";

const TAG = "InterlaceDetector";

/**
 * Heuristic interlace detection running entirely on the GPU.
 *
 * Frames already resident in the renderer's texture ring are processed by
 * fragment shaders that compute a comb score and an abs-diff motion measure,
 * then reduced to an 8×8 summary via a multi-pass box filter. Each sample's
 * result travels back through a PBO guarded by a GL fence: poll() drains
 * completed readbacks on later frames, so only a few hundred bytes cross the
 * GPU→CPU boundary per sample and nothing ever blocks on the GPU.
 *
 * The detector borrows the WebGL2 context and texture ring owned by the
 * renderer; it never uploads frames itself. It requires EXT_color_buffer_float
 * (RGBA16F render targets); when that extension is unavailable detection is
 * simply disabled and the renderer keeps using passthrough output.
 */

// ---------------------------------------------------------------------------
// Detection tuning constants
// ---------------------------------------------------------------------------

/** WebGL video rendering targets SD/HD broadcast frames; larger frames are gated out. */
const GATE_MAX_WIDTH = 1920;
const GATE_MAX_HEIGHT = 1088;
/** Horizontal domain of the detection FBOs; also the threshold calibration domain. */
const DETECTION_WIDTH = 256;
/** Pixels with (above-cur)*(below-cur) above this (in [0,255]² luma) are combed. */
const COMB_PIXEL_THRESHOLD = 400;
/** A frame is "combed" when at least this fraction of its pixels are flagged. */
const COMBED_FRAME_RATIO = 0.01;
/** Rolling window of recent frame verdicts used to debounce the interlaced flag. */
const WINDOW_SIZE = 12;
/** Combed frames required within the window to declare the source interlaced. */
const COMBED_FRAMES_REQUIRED = 3;
/** Minimum motion (mean abs luma diff, [0,255]) for a sample to count toward reversion. */
const MOTION_FLOOR = 1.5;
/** Consecutive clean+moving frames required to revert an interlaced verdict. */
const REVERSION_FRAMES_REQUIRED = 4;

// ---- Field-order voting ----
const FIELD_ORDER_MIN_VOTES = 4;
const FIELD_ORDER_MIN_MARGIN = 2;
const FIELD_ORDER_MAX_VOTES = 10;

// ---- GPU reduction ----
/** The reduction chain halves each dimension until it reaches at most this size. */
const REDUCTION_TARGET = 8;
/** COMB_PIXEL_THRESHOLD normalised to the [0,1]² luma space the shaders use. */
const COMB_THRESHOLD_NORMALISED = COMB_PIXEL_THRESHOLD / (255 * 255);
/** MOTION_FLOOR normalised to the [0,1] range the abs-diff shader returns. */
const MOTION_FLOOR_NORMALISED = MOTION_FLOOR / 255;

// ---- Async readback ----
/**
 * Readback slots; sized for the fast phase / field-order voting where samples
 * are issued on consecutive frames while earlier ones are still in flight
 * (fence wait ≈ 1-2 frames, plus one deferred-read frame).
 */
const READBACK_POOL_SIZE = 4;

// ---------------------------------------------------------------------------
// GPU shader sources
// ---------------------------------------------------------------------------

/**
 * Shared GLSL prelude: BT.709 luma extraction, matching the bwdif algorithm.
 * Prepended to every detection fragment shader so the luma weights live in one
 * place.
 */
const GLSL_LUMA_PRELUDE = `#version 300 es
precision highp float;

float lumaOfRgb(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

float lumaAt(sampler2D tex, vec2 uv) {
  return lumaOfRgb(texture(tex, uv).rgb);
}
`;

/**
 * Marker pass — one fullscreen pass over the video texture.
 * Output: R = combed (0.0 or 1.0), G = abs luma diff vs prev frame [0,1].
 */
const MARKER_FRAGMENT_SHADER = `${GLSL_LUMA_PRELUDE}
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform float u_height;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  float texelH = 1.0 / u_height;
  float cur   = lumaAt(u_cur, v_texCoord);
  float above = lumaAt(u_cur, vec2(v_texCoord.x, v_texCoord.y - texelH));
  float below = lumaAt(u_cur, vec2(v_texCoord.x, v_texCoord.y + texelH));
  float dA = above - cur;
  float dB = below - cur;
  float combed  = (dA * dB > ${COMB_THRESHOLD_NORMALISED.toFixed(8)}) ? 1.0 : 0.0;
  float absDiff = abs(cur - lumaAt(u_prev, v_texCoord));
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
 * input row). Compares the TFF and BFF temporal midpoint predictions for each
 * row pair. Output: R = errTff, G = errBff (per-row mean absolute error).
 *
 * rowLuma samples at rowF + 0.5, the texel CENTER: the video textures use
 * LINEAR filtering, so sampling at a texel boundary would average two adjacent
 * rows — blending the two fields and corrupting both hypotheses.
 *
 * main maps v_texCoord.y in [0,1] to half-height FBO rows, each corresponding to
 * an even source row (0, 2, 4, ...).
 */
const FIELD_ORDER_FRAGMENT_SHADER = `${GLSL_LUMA_PRELUDE}
uniform sampler2D u_prev;
uniform sampler2D u_cur;
uniform float u_height;

in vec2 v_texCoord;
out vec4 outColor;

float rowLuma(sampler2D tex, float x, float rowF) {
  return lumaAt(tex, vec2(x, (rowF + 0.5) / u_height));
}

void main() {
  float row = floor(v_texCoord.y * (u_height * 0.5)) * 2.0;
  float x   = v_texCoord.x;

  float tPrev      = rowLuma(u_prev, x, row);
  float tPrevBelow = rowLuma(u_prev, x, row + 2.0);
  float tCur       = rowLuma(u_cur,  x, row);
  float tCurBelow  = rowLuma(u_cur,  x, row + 2.0);
  float bPrevAbove = rowLuma(u_prev, x, row - 1.0);
  float bPrev      = rowLuma(u_prev, x, row + 1.0);
  float bCurAbove  = rowLuma(u_cur,  x, row - 1.0);
  float bCur       = rowLuma(u_cur,  x, row + 1.0);

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
  fieldOrder: FieldOrder;
}

/** Metrics extracted from one detection sample after GPU readback. */
interface DetectionMetrics {
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
// InterlaceDetector
// ---------------------------------------------------------------------------

interface DetectionFbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

/** One in-flight async readback: PBOs filled by readPixels, gated by a fence. */
interface ReadbackSlot {
  pbo: WebGLBuffer;
  fieldOrderPbo: WebGLBuffer;
  /** Set while the slot is in flight; null when the slot is free. */
  fence: WebGLSync | null;
  /** Whether fieldOrderPbo holds data for this sample. */
  hasFieldOrder: boolean;
  /** Result is from a source that was reset — drain the PBO but drop the metrics. */
  stale: boolean;
  /** Texel counts captured at issue time (FBOs may be reallocated while in flight). */
  texelCount: number;
  foTexelCount: number;
}

export class InterlaceDetector {
  private readonly onVerdict: (verdict: DetectorVerdict) => void;

  // ---- Verdict state ----
  private running = false;
  private window: boolean[] = [];
  private interlaced = false;
  private reversionConsecutiveCount = 0;
  private fieldOrder: FieldOrder = "tff";
  private fieldOrderDecided = false;
  private votesTff = 0;
  private votesBff = 0;
  private votingRounds = 0;

  // ---- GPU resources ----
  private ready = false;
  private markerProgram: WebGLProgram | null = null;
  private reductionProgram: WebGLProgram | null = null;
  private fieldOrderProgram: WebGLProgram | null = null;
  // Uniform locations, cached once per program compile (lookups are not free
  // and the reduction pass runs ~9 times per sample).
  private markerUniforms: {
    cur: WebGLUniformLocation | null;
    prev: WebGLUniformLocation | null;
    height: WebGLUniformLocation | null;
  } | null = null;
  private reductionUniforms: { input: WebGLUniformLocation | null; texelSize: WebGLUniformLocation | null } | null =
    null;
  private fieldOrderUniforms: {
    prev: WebGLUniformLocation | null;
    cur: WebGLUniformLocation | null;
    height: WebGLUniformLocation | null;
  } | null = null;
  /** Marker FBO: DETECTION_WIDTH × videoHeight, RGBA16F. */
  private markerFbo: DetectionFbo | null = null;
  /** Reduction chain: progressively halved until ≤ REDUCTION_TARGET. */
  private reductionFbos: DetectionFbo[] = [];
  /** Field-order FBO: DETECTION_WIDTH × ceil(videoHeight/2), RGBA16F. */
  private fieldOrderFbo: DetectionFbo | null = null;
  /** Reduction chain for the field-order pass, same structure. */
  private fieldOrderReductionFbos: DetectionFbo[] = [];
  /** Fence-gated PBO pool; samples are drained in issue order by poll(). */
  private readbackSlots: ReadbackSlot[] = [];
  /**
   * Free slots, least-recently-read first. FIFO reuse maximises the distance
   * between reading a slot back and rewriting it — rewriting a just-read PBO
   * defeats Chrome's readback shadow-copy optimisation (it logs a performance
   * warning when that happens).
   */
  private freeSlots: ReadbackSlot[] = [];
  /** Slots currently in flight, oldest first. */
  private inFlight: ReadbackSlot[] = [];
  /**
   * Slots whose fence has signaled, to be read on the NEXT poll. Chrome
   * populates its readback shadow copy asynchronously after it sees the fence
   * signal; reading getBufferSubData in the same frame would race that copy
   * (slow blocking path + a "shadow copy discarded" performance warning when
   * the buffer is rewritten). One frame later the shadow is ready and the read
   * is served from it without touching the GPU.
   */
  private readyToRead: ReadbackSlot[] = [];
  /** Tracked to detect resolution changes that require FBO reallocation. */
  private gpuVideoWidth = 0;
  private gpuVideoHeight = 0;

  constructor(onVerdict: (verdict: DetectorVerdict) => void) {
    this.onVerdict = onVerdict;
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  /** Returns true when EXT_color_buffer_float is available (RGBA16F FBO support). */
  static isSupported(gl: WebGL2RenderingContext): boolean {
    return gl.getExtension("EXT_color_buffer_float") !== null;
  }

  /** Begin accepting detection samples. Idempotent. */
  start(): void {
    this.running = true;
  }

  /**
   * True while an interlaced verdict awaits a field-order decision. The
   * pipeline uses this to sample back-to-back frames so voting converges in
   * frames instead of one vote per steady-state interval.
   */
  get fieldOrderVotingActive(): boolean {
    return this.running && this.interlaced && !this.fieldOrderDecided && this.votingRounds < FIELD_ORDER_MAX_VOTES;
  }

  /** Stop accepting samples. GPU resources are retained for a later start(). */
  stop(): void {
    this.running = false;
  }

  /** Drop pending async readbacks when detection is disabled or the render gate closes. */
  discardPendingReadbacks(gl: WebGL2RenderingContext): void {
    for (const slot of this.inFlight) {
      if (slot.fence) {
        gl.deleteSync(slot.fence);
        slot.fence = null;
      }
      slot.stale = false;
      this.freeSlots.push(slot);
    }
    this.inFlight = [];

    for (const slot of this.readyToRead) {
      slot.stale = false;
      this.freeSlots.push(slot);
    }
    this.readyToRead = [];
  }

  /** Forget the current verdict and voting state — call on source/channel switch. */
  reset(): void {
    this.resetVerdictState(true);
    // In-flight samples belong to the old source; drop their results when they land.
    for (const slot of this.inFlight) slot.stale = true;
    for (const slot of this.readyToRead) slot.stale = true;
  }

  /**
   * Compile shaders and allocate readback PBOs against the renderer's context.
   * FBOs are allocated lazily on the first sample (resolution is not known yet).
   * Returns false when the context cannot support GPU detection.
   */
  initGl(gl: WebGL2RenderingContext): boolean {
    if (this.ready) return true;
    if (!InterlaceDetector.isSupported(gl)) {
      Log.w(TAG, "EXT_color_buffer_float unavailable; interlace detection disabled");
      return false;
    }
    try {
      this.markerProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, MARKER_FRAGMENT_SHADER);
      this.reductionProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, REDUCTION_FRAGMENT_SHADER);
      this.fieldOrderProgram = createProgram(gl, FULLSCREEN_VERTEX_SHADER, FIELD_ORDER_FRAGMENT_SHADER);
      this.markerUniforms = {
        cur: gl.getUniformLocation(this.markerProgram, "u_cur"),
        prev: gl.getUniformLocation(this.markerProgram, "u_prev"),
        height: gl.getUniformLocation(this.markerProgram, "u_height"),
      };
      this.reductionUniforms = {
        input: gl.getUniformLocation(this.reductionProgram, "u_input"),
        texelSize: gl.getUniformLocation(this.reductionProgram, "u_texelSize"),
      };
      this.fieldOrderUniforms = {
        prev: gl.getUniformLocation(this.fieldOrderProgram, "u_prev"),
        cur: gl.getUniformLocation(this.fieldOrderProgram, "u_cur"),
        height: gl.getUniformLocation(this.fieldOrderProgram, "u_height"),
      };
    } catch (err) {
      Log.e(TAG, "Failed to compile detection shaders; detection disabled:", err);
      this.cleanupPrograms(gl);
      return false;
    }

    // 4 floats × 4 bytes per RGBA16F texel, sized for the final reduction target.
    const pboBytes = REDUCTION_TARGET * REDUCTION_TARGET * 4 * 4;
    this.readbackSlots = [];
    this.freeSlots = [];
    this.inFlight = [];
    this.readyToRead = [];
    for (let i = 0; i < READBACK_POOL_SIZE; i++) {
      const pbo = this.createReadbackPbo(gl, pboBytes);
      const fieldOrderPbo = this.createReadbackPbo(gl, pboBytes);
      if (!pbo || !fieldOrderPbo) break;
      const slot: ReadbackSlot = {
        pbo,
        fieldOrderPbo,
        fence: null,
        hasFieldOrder: false,
        stale: false,
        texelCount: 0,
        foTexelCount: 0,
      };
      this.readbackSlots.push(slot);
      this.freeSlots.push(slot);
    }

    this.ready = true;
    Log.i(TAG, "GPU detection initialised");
    return true;
  }

  /** Release all GPU resources. Safe to call with a valid or lost context. */
  destroyGl(gl: WebGL2RenderingContext): void {
    this.ready = false;

    this.cleanupPrograms(gl);
    this.clearAllFbos(gl);

    for (const slot of this.readbackSlots) {
      if (slot.fence) gl.deleteSync(slot.fence);
      gl.deleteBuffer(slot.pbo);
      gl.deleteBuffer(slot.fieldOrderPbo);
    }
    this.readbackSlots = [];
    this.freeSlots = [];
    this.inFlight = [];
    this.readyToRead = [];
    this.gpuVideoWidth = 0;
    this.gpuVideoHeight = 0;
  }

  /** The GL context was lost — all objects are already gone; just reset bookkeeping. */
  onGlContextLost(): void {
    this.ready = false;
    this.markerProgram = null;
    this.reductionProgram = null;
    this.fieldOrderProgram = null;
    this.markerUniforms = null;
    this.reductionUniforms = null;
    this.fieldOrderUniforms = null;
    this.markerFbo = null;
    this.reductionFbos = [];
    this.fieldOrderFbo = null;
    this.fieldOrderReductionFbos = [];
    this.readbackSlots = [];
    this.freeSlots = [];
    this.inFlight = [];
    this.readyToRead = [];
    this.gpuVideoWidth = 0;
    this.gpuVideoHeight = 0;
  }

  /** The GL context was restored — rebuild programs and PBOs. */
  onGlContextRestored(gl: WebGL2RenderingContext): void {
    this.initGl(gl);
  }

  // -------------------------------------------------------------------------
  // Sampling (called from index.ts via renderer.onDetectionFrame)
  // -------------------------------------------------------------------------

  /**
   * Issue a detection sample against the current/previous frame textures.
   * Fully asynchronous: results land in a fence-gated PBO slot and are folded
   * into the verdict by a later poll() call. If every slot is still in flight
   * (GPU badly backlogged), the sample is skipped.
   */
  sample(
    gl: WebGL2RenderingContext,
    curTexture: WebGLTexture,
    prevTexture: WebGLTexture | null,
    videoWidth: number,
    videoHeight: number,
  ): void {
    if (!this.ready || !this.markerProgram || !this.reductionProgram) return;

    const slot = this.freeSlots[0];
    if (!slot) return;

    // The pipeline only samples frames within the resolution gate (a stream's
    // size is constant), so no per-sample gate check is needed here.
    if (videoWidth !== this.gpuVideoWidth || videoHeight !== this.gpuVideoHeight) {
      this.reallocFbos(gl, videoWidth, videoHeight);
    }
    if (!this.markerFbo || this.reductionFbos.length === 0) return;

    const effectivePrev = prevTexture ?? curTexture;

    this.runMarkerPass(gl, curTexture, effectivePrev, videoHeight);
    this.runReductionChain(gl, this.markerFbo, this.reductionFbos);

    const finalFbo = this.reductionFbos[this.reductionFbos.length - 1];
    this.readFboIntoPbo(gl, finalFbo, slot.pbo);
    slot.texelCount = finalFbo.width * finalFbo.height;
    slot.hasFieldOrder = false;
    slot.foTexelCount = 0;

    if (this.isFieldOrderPassDue()) {
      const foFinal = this.runFieldOrderSample(gl, curTexture, effectivePrev, videoHeight, slot.fieldOrderPbo);
      if (foFinal) {
        slot.hasFieldOrder = true;
        slot.foTexelCount = foFinal.width * foFinal.height;
      }
    }

    slot.stale = false;
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    // Fences only signal once queued work is submitted to the GPU.
    gl.flush();
    this.freeSlots.shift();
    this.inFlight.push(slot);

    // Restore GL state so the video renderer's next draw call starts clean.
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Drain completed readbacks and fold them into the verdict. Called on every
   * frame; strictly non-blocking. Two phases, one frame apart: fences that
   * signaled on an earlier poll are read now (Chrome's shadow copy is ready by
   * then, so getBufferSubData is served client-side), and in-flight fences are
   * checked and promoted for the next poll. Slots complete in issue order (GL
   * commands are ordered), so both queues drain from the front.
   */
  poll(gl: WebGL2RenderingContext): void {
    // Phase 1: read slots whose fence signaled on a previous poll.
    while (this.readyToRead.length > 0) {
      const slot = this.readyToRead[0];
      this.readyToRead.shift();
      this.freeSlots.push(slot);

      const mainBuffer = this.readPboIntoArray(gl, slot.pbo, slot.texelCount);
      const foBuffer = slot.hasFieldOrder ? this.readPboIntoArray(gl, slot.fieldOrderPbo, slot.foTexelCount) : null;
      if (slot.stale) continue;

      const metrics = this.computeMetrics(mainBuffer, slot.texelCount, foBuffer !== null, foBuffer);
      this.applyMetrics(metrics);
    }

    // Phase 2: promote signaled fences; their PBOs are read on the next poll.
    while (this.inFlight.length > 0) {
      const slot = this.inFlight[0];
      if (!slot.fence) {
        this.inFlight.shift();
        this.freeSlots.push(slot);
        continue;
      }
      const status = gl.clientWaitSync(slot.fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) return;
      gl.deleteSync(slot.fence);
      slot.fence = null;
      this.inFlight.shift();
      if (status === gl.WAIT_FAILED) {
        this.freeSlots.push(slot);
        continue;
      }
      this.readyToRead.push(slot);
    }
  }

  // -------------------------------------------------------------------------
  // Verdict engine
  // -------------------------------------------------------------------------

  /**
   * Fold one detection sample into the rolling window and emit a verdict when
   * warranted. Also feeds the field-order voting once interlacing is confirmed.
   */
  private applyMetrics(metrics: DetectionMetrics): void {
    if (!this.running) return;

    const isCombed = metrics.combRatio >= COMBED_FRAME_RATIO;

    if (this.interlaced) {
      this.updateReversion(isCombed, metrics.motionScore);
    } else {
      this.updateInterlacedVerdict(isCombed);
    }

    if (metrics.hasFieldOrder) {
      this.applyFieldOrderMetrics(metrics.errTff, metrics.errBff);
    }
  }

  /** While interlaced: count clean+moving frames toward reverting to progressive. */
  private updateReversion(isCombed: boolean, motionScore: number): void {
    const hasMotion = motionScore >= MOTION_FLOOR_NORMALISED;
    if (!hasMotion || isCombed) {
      this.reversionConsecutiveCount = 0;
      return;
    }
    this.reversionConsecutiveCount++;
    Log.d(
      TAG,
      `Reversion candidate ${this.reversionConsecutiveCount}/${REVERSION_FRAMES_REQUIRED} ` +
        `(motion=${motionScore.toFixed(4)})`,
    );
    if (this.reversionConsecutiveCount >= REVERSION_FRAMES_REQUIRED) {
      Log.i(TAG, "Progressive content detected; reverting interlaced verdict");
      this.resetVerdictState(true);
    }
  }

  /** While progressive: debounce combed frames before declaring the source interlaced. */
  private updateInterlacedVerdict(isCombed: boolean): void {
    this.window.push(isCombed);
    if (this.window.length > WINDOW_SIZE) this.window.shift();

    const combedFrames = this.window.filter(Boolean).length;
    if (combedFrames < COMBED_FRAMES_REQUIRED) return;

    this.interlaced = true;
    this.reversionConsecutiveCount = 0;
    Log.i(TAG, `Interlaced content detected via comb heuristic (${combedFrames}/${this.window.length} combed frames)`);
    this.onVerdict({ interlaced: true, fieldOrder: this.fieldOrder });
  }

  private applyFieldOrderMetrics(errTff: number, errBff: number): void {
    if (this.fieldOrderDecided || this.votingRounds >= FIELD_ORDER_MAX_VOTES) return;
    // Motion gate: total error too small means the scene is static — abstain.
    // The pass stays scheduled via fieldOrderVotingActive, so voting simply
    // waits for motion instead of stopping.
    if (errTff + errBff < 1.0 / 255) return;
    this.votingRounds++;
    if (errTff < errBff * 0.9) this.votesTff++;
    else if (errBff < errTff * 0.9) this.votesBff++;
    this.maybeDecideFieldOrder();
  }

  private maybeDecideFieldOrder(): void {
    const total = this.votesTff + this.votesBff;
    const margin = Math.abs(this.votesTff - this.votesBff);
    const exhausted = this.votingRounds >= FIELD_ORDER_MAX_VOTES;
    if (total < FIELD_ORDER_MIN_VOTES && !exhausted) return;
    if (margin < FIELD_ORDER_MIN_MARGIN && !exhausted) return;

    this.fieldOrderDecided = true;
    const winner: FieldOrder = margin >= FIELD_ORDER_MIN_MARGIN && this.votesBff > this.votesTff ? "bff" : "tff";
    Log.i(TAG, `Field order: ${winner} (tff=${this.votesTff}, bff=${this.votesBff}, rounds=${this.votingRounds})`);
    if (winner !== this.fieldOrder) {
      this.fieldOrder = winner;
      if (this.interlaced) {
        this.onVerdict({ interlaced: true, fieldOrder: winner });
      }
    }
  }

  /** Whether field-order voting is open and the pass's GPU resources are ready. */
  private isFieldOrderPassDue(): boolean {
    return (
      this.fieldOrderVotingActive &&
      this.fieldOrderFbo !== null &&
      this.fieldOrderProgram !== null &&
      this.fieldOrderReductionFbos.length > 0
    );
  }

  /**
   * Reset the verdict and voting state. When emitVerdict is true and the source
   * was interlaced, notify listeners that it is now progressive.
   */
  private resetVerdictState(emitVerdict: boolean): void {
    const wasInterlaced = this.interlaced;
    this.window = [];
    this.interlaced = false;
    this.reversionConsecutiveCount = 0;
    this.fieldOrder = "tff";
    this.fieldOrderDecided = false;
    this.votesTff = 0;
    this.votesBff = 0;
    this.votingRounds = 0;
    if (emitVerdict && wasInterlaced) {
      this.onVerdict({ interlaced: false, fieldOrder: "tff" });
    }
  }

  // -------------------------------------------------------------------------
  // GPU pass helpers
  // -------------------------------------------------------------------------

  private runMarkerPass(
    gl: WebGL2RenderingContext,
    curTexture: WebGLTexture,
    prevTexture: WebGLTexture,
    videoHeight: number,
  ): void {
    const program = this.markerProgram;
    const uniforms = this.markerUniforms;
    const fbo = this.markerFbo;
    if (!program || !uniforms || !fbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.viewport(0, 0, fbo.width, fbo.height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, curTexture);
    gl.uniform1i(uniforms.cur, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    gl.uniform1i(uniforms.prev, 1);
    gl.uniform1f(uniforms.height, videoHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Runs the field-order pass into the given PBO; returns its final reduction FBO. */
  private runFieldOrderSample(
    gl: WebGL2RenderingContext,
    curTexture: WebGLTexture,
    prevTexture: WebGLTexture,
    videoHeight: number,
    pbo: WebGLBuffer,
  ): DetectionFbo | null {
    const program = this.fieldOrderProgram;
    const uniforms = this.fieldOrderUniforms;
    const fbo = this.fieldOrderFbo;
    if (!program || !uniforms || !fbo) return null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.viewport(0, 0, fbo.width, fbo.height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    gl.uniform1i(uniforms.prev, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, curTexture);
    gl.uniform1i(uniforms.cur, 1);
    gl.uniform1f(uniforms.height, videoHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.runReductionChain(gl, fbo, this.fieldOrderReductionFbos);

    const foFinal = this.fieldOrderReductionFbos[this.fieldOrderReductionFbos.length - 1];
    if (!foFinal) return null;
    this.readFboIntoPbo(gl, foFinal, pbo);
    return foFinal;
  }

  private runReductionChain(gl: WebGL2RenderingContext, seedFbo: DetectionFbo, reductionFbos: DetectionFbo[]): void {
    const program = this.reductionProgram;
    const uniforms = this.reductionUniforms;
    if (!program || !uniforms) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(uniforms.input, 0);
    let inputFbo = seedFbo;
    for (const outputFbo of reductionFbos) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo.fbo);
      gl.viewport(0, 0, outputFbo.width, outputFbo.height);
      gl.bindTexture(gl.TEXTURE_2D, inputFbo.tex);
      gl.uniform2f(uniforms.texelSize, 1.0 / inputFbo.width, 1.0 / inputFbo.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      inputFbo = outputFbo;
    }
  }

  // -------------------------------------------------------------------------
  // GPU readback helpers
  // -------------------------------------------------------------------------

  private computeMetrics(
    buffer: Float32Array,
    texelCount: number,
    hasFieldOrder: boolean,
    foBuffer: Float32Array | null,
  ): DetectionMetrics {
    const { errTff: combSum, errBff: diffSum } = meanChannels(buffer, texelCount);
    const combRatio = combSum;
    const motionScore = diffSum;

    let errTff = 0;
    let errBff = 0;
    if (hasFieldOrder && foBuffer) {
      const means = meanChannels(foBuffer, foBuffer.length / 4);
      errTff = means.errTff;
      errBff = means.errBff;
    }

    return { combRatio, motionScore, errTff, errBff, hasFieldOrder };
  }

  private readFboIntoPbo(gl: WebGL2RenderingContext, fbo: DetectionFbo, pbo: WebGLBuffer | null): void {
    if (!pbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    // Orphan the buffer with the exact payload size before writing: readPixels
    // then covers the whole (fresh) data store, so Chrome's readback shadow
    // copy is cleanly created per sample and consumed by getBufferSubData —
    // reusing the old store would trigger a "shadow copy discarded"
    // performance warning and fall off the accelerated readback path.
    gl.bufferData(gl.PIXEL_PACK_BUFFER, fbo.width * fbo.height * 4 * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, fbo.width, fbo.height, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private readPboIntoArray(gl: WebGL2RenderingContext, pbo: WebGLBuffer, texelCount: number): Float32Array {
    const buffer = new Float32Array(texelCount * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return buffer;
  }

  private createReadbackPbo(gl: WebGL2RenderingContext, byteLength: number): WebGLBuffer | null {
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return pbo;
  }

  // -------------------------------------------------------------------------
  // FBO allocation
  // -------------------------------------------------------------------------

  private reallocFbos(gl: WebGL2RenderingContext, videoWidth: number, videoHeight: number): void {
    this.clearAllFbos(gl);
    this.gpuVideoWidth = videoWidth;
    this.gpuVideoHeight = videoHeight;

    this.markerFbo = this.createDetectionFbo(gl, DETECTION_WIDTH, videoHeight);
    if (!this.markerFbo) return;
    this.reductionFbos = this.buildReductionChain(gl, DETECTION_WIDTH, videoHeight);

    const foHeight = Math.max(1, Math.ceil(videoHeight / 2));
    this.fieldOrderFbo = this.createDetectionFbo(gl, DETECTION_WIDTH, foHeight);
    if (this.fieldOrderFbo) {
      this.fieldOrderReductionFbos = this.buildReductionChain(gl, DETECTION_WIDTH, foHeight);
    }
  }

  private buildReductionChain(gl: WebGL2RenderingContext, seedWidth: number, seedHeight: number): DetectionFbo[] {
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

  private createDetectionFbo(gl: WebGL2RenderingContext, width: number, height: number): DetectionFbo | null {
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
    if (!fbo) {
      gl.deleteTexture(tex);
      return null;
    }
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

  private clearAllFbos(gl: WebGL2RenderingContext): void {
    this.freeDetectionFbo(gl, this.markerFbo);
    this.markerFbo = null;
    for (const fbo of this.reductionFbos) this.freeDetectionFbo(gl, fbo);
    this.reductionFbos = [];
    this.freeDetectionFbo(gl, this.fieldOrderFbo);
    this.fieldOrderFbo = null;
    for (const fbo of this.fieldOrderReductionFbos) this.freeDetectionFbo(gl, fbo);
    this.fieldOrderReductionFbos = [];
  }

  private freeDetectionFbo(gl: WebGL2RenderingContext, fbo: DetectionFbo | null): void {
    if (!fbo) return;
    gl.deleteFramebuffer(fbo.fbo);
    gl.deleteTexture(fbo.tex);
  }

  private cleanupPrograms(gl: WebGL2RenderingContext): void {
    if (this.markerProgram) {
      gl.deleteProgram(this.markerProgram);
      this.markerProgram = null;
    }
    if (this.reductionProgram) {
      gl.deleteProgram(this.reductionProgram);
      this.reductionProgram = null;
    }
    if (this.fieldOrderProgram) {
      gl.deleteProgram(this.fieldOrderProgram);
      this.fieldOrderProgram = null;
    }
    this.markerUniforms = null;
    this.reductionUniforms = null;
    this.fieldOrderUniforms = null;
  }
}

/**
 * Whether a frame size falls within the SD/HD WebGL render gate.
 * Larger frames fall back to the raw video element.
 */
export function isRenderResolutionEligible(width: number, height: number): boolean {
  return width > 0 && width <= GATE_MAX_WIDTH && height > 0 && height <= GATE_MAX_HEIGHT;
}

/**
 * Mean of the R and G channels of an RGBA float buffer over the given texel
 * count. R is returned as errTff, G as errBff (also used for combRatio/motion).
 */
function meanChannels(buffer: Float32Array, texelCount: number): { errTff: number; errBff: number } {
  if (texelCount <= 0) return { errTff: 0, errBff: 0 };
  let rSum = 0;
  let gSum = 0;
  for (let i = 0; i < texelCount; i++) {
    rSum += buffer[i * 4];
    gSum += buffer[i * 4 + 1];
  }
  return { errTff: rSum / texelCount, errBff: gSum / texelCount };
}

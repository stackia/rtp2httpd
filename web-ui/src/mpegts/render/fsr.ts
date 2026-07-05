import { createProgram, FRAMEBUFFER_VERTEX_SHADER } from "./filters/gl-utils";
import type { Presenter } from "./presenters";

/**
 * AMD FidelityFX Super Resolution 1 (FSR1) upscale presenter: EASU
 * (Edge-Adaptive Spatial Upsampling) followed by RCAS (Robust Contrast
 * Adaptive Sharpening), replacing the Catmull-Rom bicubic presenter as the
 * enhancement path's upscaler.
 *
 * Ported to WebGL2 GLSL ES 300 from AMD's reference (ffx_fsr1.h, MIT
 * licensed, Copyright (c) 2021 Advanced Micro Devices, Inc.), following the
 * structure of the well-known single-pass-per-plane mpv port by agyild
 * (https://gist.github.com/agyild/82219c545228d70c5604f865ce0b0ce5, also
 * MIT). That port operates on a single luma plane; this version generalizes
 * it back to direct RGB sampling (our source is already decoded RGB, not
 * separate YUV planes): EASU's direction/length analysis runs on luma
 * derived from the RGB taps, and the resulting kernel weights are shared
 * across all three channels, since the weights never depend on tap color.
 *
 * RCAS's contrast/sharpness lobe replaces the old dedicated "sharpen" filter
 * (see filters/sharpen.ts, removed), so its output also folds in the same
 * mild contrast/saturation lift that filter used to apply.
 */

const EASU_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform vec2 u_srcSize;
uniform vec2 u_dstSize;

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Fast reciprocal / rsqrt bit-hack approximations (AMD's AAxxRcpF1/RsqF1).
// Unlike a native 1.0/x, these return a large finite value at x=0 instead of
// Infinity -- flat image regions hit x=0 constantly, and a subsequent
// 0 * Infinity would poison the result with NaN.
float easuRcp(float x) {
  return uintBitsToFloat(0x7ef07ebbu - floatBitsToUint(x));
}
float easuRsqrt(float x) {
  return uintBitsToFloat(0x5f347d74u - (floatBitsToUint(x) >> 1u));
}

vec3 min3(vec3 a, vec3 b, vec3 c) { return min(a, min(b, c)); }
vec3 max3(vec3 a, vec3 b, vec3 c) { return max(a, max(b, c)); }

vec3 sampleSrc(vec2 pixelPos) {
  return texture(u_input, (pixelPos + 0.5) / u_srcSize).rgb;
}

/** Accumulate one Lanczos-2-approximation tap (AMD's FsrEasuTap, RGB accumulator). */
void easuTap(
  inout vec3 accumColor,
  inout float accumWeight,
  vec2 offset,
  vec2 dir,
  vec2 len,
  float lobe,
  float clip,
  vec3 tapColor
) {
  vec2 v = vec2(offset.x * dir.x + offset.y * dir.y, -offset.x * dir.y + offset.y * dir.x) * len;
  float d2 = min(v.x * v.x + v.y * v.y, clip);
  // Lanczos-2 approximation without sin()/rcp()/sqrt(): (base) * (window).
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lobe * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  accumColor += tapColor * w;
  accumWeight += w;
}

/**
 * Accumulate gradient direction and length from one bilinear-weighted corner
 * of the 2x2 center cell (AMD's FsrEasuSet). Called once per corner (S/T/U/V)
 * with that corner's local "+"-shaped luma neighborhood (lA..lE).
 */
void easuSet(
  inout vec2 dir,
  inout float len,
  vec2 pp,
  bool biS,
  bool biT,
  bool biU,
  bool biV,
  float lA,
  float lB,
  float lC,
  float lD,
  float lE
) {
  float w = 0.0;
  if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
  if (biT) w = pp.x * (1.0 - pp.y);
  if (biU) w = (1.0 - pp.x) * pp.y;
  if (biV) w = pp.x * pp.y;

  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = easuRcp(max(abs(dc), abs(cb)));
  float dirX = lD - lB;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;

  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = easuRcp(max(abs(ec), abs(ca)));
  float dirY = lE - lA;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;

  dir += vec2(dirX, dirY) * w;
  len += (lenX + lenY) * w;
}

void main() {
  //      b c
  //    e f g h
  //    i j k l
  //      n o
  // 'pp' is the position of 'f' in source-pixel units: equivalent to
  // (outputPixelCenterUV * srcSize - 0.5) with no viewport cropping.
  vec2 pp = gl_FragCoord.xy * (u_srcSize / u_dstSize) - vec2(0.5);
  vec2 fp = floor(pp);
  pp -= fp;

  vec3 b = sampleSrc(fp + vec2(0.0, -1.0));
  vec3 c = sampleSrc(fp + vec2(1.0, -1.0));
  vec3 e = sampleSrc(fp + vec2(-1.0, 0.0));
  vec3 f = sampleSrc(fp + vec2(0.0, 0.0));
  vec3 g = sampleSrc(fp + vec2(1.0, 0.0));
  vec3 h = sampleSrc(fp + vec2(2.0, 0.0));
  vec3 i = sampleSrc(fp + vec2(-1.0, 1.0));
  vec3 j = sampleSrc(fp + vec2(0.0, 1.0));
  vec3 k = sampleSrc(fp + vec2(1.0, 1.0));
  vec3 l = sampleSrc(fp + vec2(2.0, 1.0));
  vec3 n = sampleSrc(fp + vec2(0.0, 2.0));
  vec3 o = sampleSrc(fp + vec2(1.0, 2.0));

  float bL = dot(b, LUMA);
  float cL = dot(c, LUMA);
  float eL = dot(e, LUMA);
  float fL = dot(f, LUMA);
  float gL = dot(g, LUMA);
  float hL = dot(h, LUMA);
  float iL = dot(i, LUMA);
  float jL = dot(j, LUMA);
  float kL = dot(k, LUMA);
  float lL = dot(l, LUMA);
  float nL = dot(n, LUMA);
  float oL = dot(o, LUMA);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, pp, true, false, false, false, bL, eL, fL, gL, jL);
  easuSet(dir, len, pp, false, true, false, false, cL, fL, gL, hL, kL);
  easuSet(dir, len, pp, false, false, true, false, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp, false, false, false, true, gL, jL, kL, lL, oL);

  // Normalize direction with approximation, and clean up near-zero (flat/no-edge) cases.
  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zero = dirR < (1.0 / 32768.0);
  dirR = easuRsqrt(dirR);
  dirR = zero ? 1.0 : dirR;
  dir.x = zero ? 1.0 : dir.x;
  dir *= vec2(dirR);

  // Transform length from {0,2} to {0,1} range, shaped with a square.
  len = len * 0.5;
  len *= len;
  // Stretch kernel {1.0 vert|horz, to sqrt(2.0) on diagonal}.
  float stretch = (dir.x * dir.x + dir.y * dir.y) * easuRcp(max(abs(dir.x), abs(dir.y)));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  // Window shifts from +/-{sqrt(2.0) to slightly beyond 2.0} based on edge strength.
  float lobe = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clip = easuRcp(lobe);

  vec3 accumColor = vec3(0.0);
  float accumWeight = 0.0;
  easuTap(accumColor, accumWeight, vec2(0.0, -1.0) - pp, dir, len2, lobe, clip, b);
  easuTap(accumColor, accumWeight, vec2(1.0, -1.0) - pp, dir, len2, lobe, clip, c);
  easuTap(accumColor, accumWeight, vec2(-1.0, 1.0) - pp, dir, len2, lobe, clip, i);
  easuTap(accumColor, accumWeight, vec2(0.0, 1.0) - pp, dir, len2, lobe, clip, j);
  easuTap(accumColor, accumWeight, vec2(0.0, 0.0) - pp, dir, len2, lobe, clip, f);
  easuTap(accumColor, accumWeight, vec2(-1.0, 0.0) - pp, dir, len2, lobe, clip, e);
  easuTap(accumColor, accumWeight, vec2(1.0, 1.0) - pp, dir, len2, lobe, clip, k);
  easuTap(accumColor, accumWeight, vec2(2.0, 1.0) - pp, dir, len2, lobe, clip, l);
  easuTap(accumColor, accumWeight, vec2(2.0, 0.0) - pp, dir, len2, lobe, clip, h);
  easuTap(accumColor, accumWeight, vec2(1.0, 0.0) - pp, dir, len2, lobe, clip, g);
  easuTap(accumColor, accumWeight, vec2(1.0, 2.0) - pp, dir, len2, lobe, clip, o);
  easuTap(accumColor, accumWeight, vec2(0.0, 2.0) - pp, dir, len2, lobe, clip, n);

  vec3 rgb = accumColor / accumWeight;

  // Dering: clamp each channel to the range of the four central texels.
  vec3 lo = min(min3(f, g, j), k);
  vec3 hi = max(max3(f, g, j), k);
  rgb = clamp(rgb, lo, hi);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

const RCAS_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform vec2 u_texelSize;

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// AMD scale: 0.0 = strongest sharpening, higher N = N stops (halvings) weaker.
const float SHARPNESS = 0.2;
// Limit of providing unnatural results for sharpening (AMD FSR_RCAS_LIMIT).
const float RCAS_LIMIT = 0.25 - 1.0 / 16.0;
// Same mild tone lift the old "sharpen" enhancement filter applied.
const float CONTRAST = 1.04;
const float SATURATION = 1.03;

/**
 * Medium-precision reciprocal (fast bit-hack estimate plus one
 * Newton-Raphson refinement step). Deliberately used in place of AMD's plain
 * division here: RCAS's clipping-lobe math divides by neighborhood min/max
 * ranges that legitimately hit exactly zero on flat video content (solid
 * black letterboxing, blown-out highlights), where native division would
 * yield 0/0 = NaN. This approximation returns a large finite value at zero
 * instead of Infinity, so the following multiply-by-numerator collapses
 * cleanly to zero rather than propagating NaN.
 */
float rcasRcp(float a) {
  float b = uintBitsToFloat(0x7ef19fffu - floatBitsToUint(a));
  return b * (-b * a + 2.0);
}

float min3(float a, float b, float c) { return min(a, min(b, c)); }
float max3(float a, float b, float c) { return max(a, max(b, c)); }

void main() {
  // 3x3 cross neighborhood.
  //   b
  // d e f
  //   h
  vec2 uv = gl_FragCoord.xy * u_texelSize;
  vec3 b = texture(u_input, uv + vec2(0.0, -1.0) * u_texelSize).rgb;
  vec3 d = texture(u_input, uv + vec2(-1.0, 0.0) * u_texelSize).rgb;
  vec3 e = texture(u_input, uv).rgb;
  vec3 f = texture(u_input, uv + vec2(1.0, 0.0) * u_texelSize).rgb;
  vec3 h = texture(u_input, uv + vec2(0.0, 1.0) * u_texelSize).rgb;

  float bL = dot(b, LUMA);
  float dL = dot(d, LUMA);
  float eL = dot(e, LUMA);
  float fL = dot(f, LUMA);
  float hL = dot(h, LUMA);

  // Min/max of the ring (excludes the center).
  float mn = min(min3(bL, dL, fL), hL);
  float mx = max(max3(bL, dL, fL), hL);

  float hitMin = min(mn, eL) * rcasRcp(4.0 * mx);
  float hitMax = (1.0 - max(mx, eL)) * rcasRcp(4.0 * mn - 4.0);
  float lobeShape = max(-hitMin, hitMax);
  float lobe = max(-RCAS_LIMIT, min(lobeShape, 0.0)) * exp2(-SHARPNESS);

  // Noise detection: de-weight sharpening where the neighborhood (including
  // the center) is flat relative to its own contrast range, so compression
  // noise/grain in low-contrast areas is not amplified.
  float mn5 = min(mn, eL);
  float mx5 = max(mx, eL);
  float noise = 0.25 * (bL + dL + fL + hL) - eL;
  noise = clamp(abs(noise) * rcasRcp(mx5 - mn5), 0.0, 1.0);
  lobe *= 1.0 - 0.5 * noise;

  float rcp = rcasRcp(4.0 * lobe + 1.0);
  vec3 rgb = (lobe * (b + d + f + h) + e) * rcp;

  rgb = (rgb - 0.5) * CONTRAST + 0.5;
  float y = dot(rgb, LUMA);
  rgb = mix(vec3(y), rgb, SATURATION);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

interface IntermediateTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

/**
 * FSR1 upscale presenter: EASU (source -> intermediate, at output size) then
 * RCAS (intermediate -> bound framebuffer). RCAS also runs standalone
 * (skipping EASU) when the output is not larger than the source, so picture
 * enhancement still sharpens at native size instead of doing nothing.
 */
export class FsrPresenter implements Presenter {
  readonly name = "fsr-present";

  private easuProgram: WebGLProgram | null = null;
  private easuInputLocation: WebGLUniformLocation | null = null;
  private easuSrcSizeLocation: WebGLUniformLocation | null = null;
  private easuDstSizeLocation: WebGLUniformLocation | null = null;

  private rcasProgram: WebGLProgram | null = null;
  private rcasInputLocation: WebGLUniformLocation | null = null;
  private rcasTexelSizeLocation: WebGLUniformLocation | null = null;

  private intermediate: IntermediateTarget | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.easuProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, EASU_FRAGMENT_SHADER);
    this.easuInputLocation = gl.getUniformLocation(this.easuProgram, "u_input");
    this.easuSrcSizeLocation = gl.getUniformLocation(this.easuProgram, "u_srcSize");
    this.easuDstSizeLocation = gl.getUniformLocation(this.easuProgram, "u_dstSize");

    try {
      this.rcasProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, RCAS_FRAGMENT_SHADER);
    } catch (err) {
      gl.deleteProgram(this.easuProgram);
      this.easuProgram = null;
      throw err;
    }
    this.rcasInputLocation = gl.getUniformLocation(this.rcasProgram, "u_input");
    this.rcasTexelSizeLocation = gl.getUniformLocation(this.rcasProgram, "u_texelSize");
  }

  present(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
  ): void {
    if (!this.easuProgram || !this.rcasProgram) {
      throw new Error("FsrPresenter.present() called before init()");
    }

    // Respect the framebuffer the caller bound (Presenter contract), for both
    // the upscaling and native-size paths: RCAS renders into it last, with
    // EASU rendering into the intermediate target in between.
    const outputFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    const upscaling = dstWidth > srcWidth + 0.5 || dstHeight > srcHeight + 0.5;
    if (!upscaling) {
      this.runRcas(gl, texture, dstWidth, dstHeight, outputFbo);
      return;
    }

    // A failed intermediate allocation (e.g. a 4K target on a device with a
    // smaller max texture/FBO size, or under GPU memory pressure) must surface
    // so the caller can run its passthrough fallback instead of treating the
    // present as successful and leaving the canvas blank or stale.
    const target = this.ensureIntermediateTarget(gl, dstWidth, dstHeight);
    if (!target) {
      throw new Error(`FsrPresenter failed to allocate ${dstWidth}x${dstHeight} intermediate target`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, dstWidth, dstHeight);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.easuProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.easuInputLocation, 0);
    gl.uniform2f(this.easuSrcSizeLocation, srcWidth, srcHeight);
    gl.uniform2f(this.easuDstSizeLocation, dstWidth, dstHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.runRcas(gl, target.texture, dstWidth, dstHeight, outputFbo);
  }

  private runRcas(
    gl: WebGL2RenderingContext,
    inputTexture: WebGLTexture,
    width: number,
    height: number,
    targetFbo: WebGLFramebuffer | null,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, width, height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.rcasProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(this.rcasInputLocation, 0);
    gl.uniform2f(this.rcasTexelSizeLocation, 1 / width, 1 / height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private ensureIntermediateTarget(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ): IntermediateTarget | null {
    if (this.intermediate?.width === width && this.intermediate.height === height) return this.intermediate;
    this.deleteIntermediateTarget(gl);

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

    this.intermediate = { fbo, texture, width, height };
    return this.intermediate;
  }

  private deleteIntermediateTarget(gl: WebGL2RenderingContext): void {
    if (!this.intermediate) return;
    gl.deleteFramebuffer(this.intermediate.fbo);
    gl.deleteTexture(this.intermediate.texture);
    this.intermediate = null;
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.easuProgram) {
      gl.deleteProgram(this.easuProgram);
      this.easuProgram = null;
    }
    if (this.rcasProgram) {
      gl.deleteProgram(this.rcasProgram);
      this.rcasProgram = null;
    }
    this.deleteIntermediateTarget(gl);
    this.easuInputLocation = null;
    this.easuSrcSizeLocation = null;
    this.easuDstSizeLocation = null;
    this.rcasInputLocation = null;
    this.rcasTexelSizeLocation = null;
  }
}

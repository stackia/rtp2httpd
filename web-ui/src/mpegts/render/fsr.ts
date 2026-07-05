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

/**
 * EASU (Edge-Adaptive Spatial Upsampling), ported from AMD's FsrEasuF.
 *
 * easuRcp/easuRsqrt: AMD's AAxxRcpF1/RsqF1 fast bit-hack approximations.
 * Unlike a native 1.0/x, these return a large finite value at x=0 instead of
 * Infinity -- flat image regions hit x=0 constantly, and a subsequent
 * 0 * Infinity would poison the result with NaN.
 *
 * easuTap (AMD's FsrEasuTap): accumulates one Lanczos-2-approximation tap
 * into the RGB/weight accumulators, via a base*window product that avoids
 * sin()/rcp()/sqrt().
 *
 * easuSet (AMD's FsrEasuSet): accumulates gradient direction and length from
 * one bilinear-weighted corner of the 2x2 center cell, given that corner's
 * local "+"-shaped luma neighborhood (lA..lE). Called once per corner
 * (S/T/U/V).
 *
 * main samples the 12-tap "+"-shaped neighborhood around the output pixel
 * (named b,c,e,f,g,h,i,j,k,l,n,o per AMD's reference diagram):
 *     b c
 *   e f g h
 *   i j k l
 *     n o
 * `pp` is the position of `f` in source-pixel units (equivalent to
 * outputPixelCenterUV * srcSize - 0.5, with no viewport cropping). Gradient
 * direction/length are estimated from the four corners, normalized and
 * reshaped (direction via rsqrt, length squared into {0,1}, then stretched
 * {1.0 vert/horz to sqrt(2.0) diagonal}) to set the Lanczos lobe/clip window,
 * which widens from +/-sqrt(2.0) to just past 2.0 with edge strength. The 12
 * taps are accumulated through easuTap and normalized, then de-ringed by
 * clamping to the range of the four central texels (f,g,j,k).
 */
const EASU_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform vec2 u_srcSize;
uniform vec2 u_dstSize;
uniform bool u_flipY;

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lobe * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  accumColor += tapColor * w;
  accumWeight += w;
}

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
  vec2 fragCoord = gl_FragCoord.xy;
  if (u_flipY) fragCoord.y = u_dstSize.y - fragCoord.y;
  vec2 pp = fragCoord * (u_srcSize / u_dstSize) - vec2(0.5);
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

  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zero = dirR < (1.0 / 32768.0);
  dirR = easuRsqrt(dirR);
  dirR = zero ? 1.0 : dirR;
  dir.x = zero ? 1.0 : dir.x;
  dir *= vec2(dirR);

  len = len * 0.5;
  len *= len;
  float stretch = (dir.x * dir.x + dir.y * dir.y) * easuRcp(max(abs(dir.x), abs(dir.y)));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
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

  vec3 lo = min(min3(f, g, j), k);
  vec3 hi = max(max3(f, g, j), k);
  rgb = clamp(rgb, lo, hi);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

/**
 * RCAS (Robust Contrast Adaptive Sharpening), ported from AMD's FsrRcasF.
 *
 * SHARPNESS: AMD scale, 0.0 = strongest sharpening, higher N = N stops
 * (halvings) weaker. RCAS_LIMIT (AMD FSR_RCAS_LIMIT): clamps the sharpening
 * lobe to avoid unnatural results. CONTRAST/SATURATION: the same mild tone
 * lift the old dedicated "sharpen" enhancement filter used to apply.
 *
 * rcasRcp: medium-precision reciprocal (fast bit-hack estimate plus one
 * Newton-Raphson refinement step), used in place of AMD's plain division
 * because RCAS's clipping-lobe math divides by neighborhood min/max ranges
 * that legitimately hit exactly zero on flat video content (solid black
 * letterboxing, blown-out highlights), where native division would yield
 * 0/0 = NaN. This approximation returns a large finite value at zero
 * instead, so the following multiply-by-numerator collapses cleanly to zero
 * rather than propagating NaN.
 *
 * main reads the 3x3 cross neighborhood around the output pixel:
 *     b
 *   d e f
 *     h
 * derives a sharpening lobe from the local min/max contrast range (clamped
 * by RCAS_LIMIT/SHARPNESS), de-weights it in flat/noisy regions (comparing
 * the 4-neighbor average against the center to avoid amplifying compression
 * noise/grain), and blends the cross taps with the center by that lobe
 * before applying the CONTRAST/SATURATION lift.
 */
const RCAS_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform vec2 u_texelSize;
uniform bool u_flipY;

out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float SHARPNESS = 0.2;
const float RCAS_LIMIT = 0.25 - 1.0 / 16.0;
const float CONTRAST = 1.04;
const float SATURATION = 1.03;

float rcasRcp(float a) {
  float b = uintBitsToFloat(0x7ef19fffu - floatBitsToUint(a));
  return b * (-b * a + 2.0);
}

float min3(float a, float b, float c) { return min(a, min(b, c)); }
float max3(float a, float b, float c) { return max(a, max(b, c)); }

void main() {
  vec2 uv = gl_FragCoord.xy * u_texelSize;
  if (u_flipY) uv.y = 1.0 - uv.y;
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

  float mn = min(min3(bL, dL, fL), hL);
  float mx = max(max3(bL, dL, fL), hL);

  float hitMin = min(mn, eL) * rcasRcp(4.0 * mx);
  float hitMax = (1.0 - max(mx, eL)) * rcasRcp(4.0 * mn - 4.0);
  float lobeShape = max(-hitMin, hitMax);
  float lobe = max(-RCAS_LIMIT, min(lobeShape, 0.0)) * exp2(-SHARPNESS);

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
  private easuFlipYLocation: WebGLUniformLocation | null = null;

  private rcasProgram: WebGLProgram | null = null;
  private rcasInputLocation: WebGLUniformLocation | null = null;
  private rcasTexelSizeLocation: WebGLUniformLocation | null = null;
  private rcasFlipYLocation: WebGLUniformLocation | null = null;

  private intermediate: IntermediateTarget | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.easuProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, EASU_FRAGMENT_SHADER);
    this.easuInputLocation = gl.getUniformLocation(this.easuProgram, "u_input");
    this.easuSrcSizeLocation = gl.getUniformLocation(this.easuProgram, "u_srcSize");
    this.easuDstSizeLocation = gl.getUniformLocation(this.easuProgram, "u_dstSize");
    this.easuFlipYLocation = gl.getUniformLocation(this.easuProgram, "u_flipY");

    try {
      this.rcasProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, RCAS_FRAGMENT_SHADER);
    } catch (err) {
      gl.deleteProgram(this.easuProgram);
      this.easuProgram = null;
      throw err;
    }
    this.rcasInputLocation = gl.getUniformLocation(this.rcasProgram, "u_input");
    this.rcasTexelSizeLocation = gl.getUniformLocation(this.rcasProgram, "u_texelSize");
    this.rcasFlipYLocation = gl.getUniformLocation(this.rcasProgram, "u_flipY");
  }

  present(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
    flipY: boolean,
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
      this.runRcas(gl, texture, dstWidth, dstHeight, outputFbo, flipY);
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
    gl.uniform1i(this.easuFlipYLocation, flipY ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The intermediate is a framebuffer-rendered texture (native orientation),
    // regardless of whether the EASU input needed a flip.
    this.runRcas(gl, target.texture, dstWidth, dstHeight, outputFbo, false);
  }

  private runRcas(
    gl: WebGL2RenderingContext,
    inputTexture: WebGLTexture,
    width: number,
    height: number,
    targetFbo: WebGLFramebuffer | null,
    flipY: boolean,
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, width, height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.rcasProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(this.rcasInputLocation, 0);
    gl.uniform2f(this.rcasTexelSizeLocation, 1 / width, 1 / height);
    gl.uniform1i(this.rcasFlipYLocation, flipY ? 1 : 0);
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

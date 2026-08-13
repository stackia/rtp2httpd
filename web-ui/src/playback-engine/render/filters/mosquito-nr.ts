import { createProgram, FRAMEBUFFER_VERTEX_SHADER } from "./gl-utils";
import { type RenderParams, registerFilter, type VideoFilter } from "./types";

/**
 * Spatial compression-artifact reduction ahead of FSR EASU: mosquito/ringing
 * around high-contrast edges (burned-in subtitles, jersey numbers, silhouettes)
 * plus light chroma bleed and blocking in flat regions.
 *
 * A 3×3 box would melt soft motion-blurred edges (running players into grass).
 * Taps are luma-range weighted instead (cheap bilateral): similar neighbors
 * average, real edges keep the center. Extra ±2-px cross taps widen support
 * for ringing that sits 2 px off an edge without a full 5×5.
 *
 * - `onEdge` (center Sobel) reduces luma NR on the sharpest strokes so numbers
 *   and glyph interiors stay crisp; chroma NR is not gated (color bleed lives
 *   on the stroke itself).
 * - `nearEdge` (wider luma range) is the halo where mosquito lives.
 * - Flat regions get a modest luma mix to take the edge off 8×8 blocking.
 *
 * Thresholds are full-range 0–1 luma (Sobel abs-sum is ~0–4). RANGE_SIGMA is
 * mosquito amplitude, not edge height — a white-on-green number (~0.6 luma
 * jump) stays unmixed. Raising LUMA_NEAR eats halos harder; raising
 * RANGE_SIGMA starts to smear silhouettes.
 *
 * Shader uniforms:
 * - u_input: current frame (raw video upload or a prior framebuffer).
 * - u_texelSize: 1/width, 1/height.
 * - u_flipY: 1 when sampling a raw DOM video upload.
 */

const FRAGMENT_SHADER = /*glsl*/ `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform vec2 u_texelSize;

in vec2 v_texCoord;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Center Sobel abs-sum. A white/black step is ~3.2; protect only the
// sharpest transitions (numbers, subtitle strokes). Soft silhouettes sit
// lower and stay eligible for range-weighted NR.
const float EDGE_LO = 1.4;
const float EDGE_HI = 2.6;

// Wider (3×3 plus ±2-px cross) luma range. Nearby high-contrast edges push
// this toward 0.5–1.0; mosquito-only neighborhoods sit lower.
const float NEAR_LO = 0.08;
const float NEAR_HI = 0.38;

// 3×3 luma range for the flat-region mix. Low-bitrate grass/jersey blocking
// is ~0.02–0.10; keep this modest so faces in cleaner sources do not go plastic.
const float FLAT_LO = 0.02;
const float FLAT_HI = 0.12;

// Luma delta at which a neighbor is excluded. Mosquito speckle is below this;
// a jersey-number / grass step is far above it.
const float RANGE_SIGMA = 0.11;

const float LUMA_NEAR = 0.82;
const float LUMA_FLAT = 0.16;
const float EDGE_KEEP = 0.45;
const float CHROMA_BASE = 0.38;
const float CHROMA_NEAR = 0.72;
const float CHROMA_FLAT = 0.28;

vec3 sampleRgb(vec2 uv) {
  return texture(u_input, uv).rgb;
}

float rangeW(float luma, float centerLuma) {
  return 1.0 - smoothstep(0.0, RANGE_SIGMA, abs(luma - centerLuma));
}

void accum(inout vec3 acc, inout float wSum, vec3 color, float luma, float centerLuma) {
  float w = rangeW(luma, centerLuma);
  acc += color * w;
  wSum += w;
}

void main() {
  vec2 uv = v_texCoord;
  vec2 dx = vec2(u_texelSize.x, 0.0);
  vec2 dy = vec2(0.0, u_texelSize.y);

  vec3 nw = sampleRgb(uv - dx - dy);
  vec3 n  = sampleRgb(uv      - dy);
  vec3 ne = sampleRgb(uv + dx - dy);
  vec3 w  = sampleRgb(uv - dx);
  vec3 c  = sampleRgb(uv);
  vec3 e  = sampleRgb(uv + dx);
  vec3 sw = sampleRgb(uv - dx + dy);
  vec3 s  = sampleRgb(uv      + dy);
  vec3 se = sampleRgb(uv + dx + dy);

  vec3 nn = sampleRgb(uv - 2.0 * dy);
  vec3 ss = sampleRgb(uv + 2.0 * dy);
  vec3 ww = sampleRgb(uv - 2.0 * dx);
  vec3 ee = sampleRgb(uv + 2.0 * dx);

  float nwL = dot(nw, LUMA);
  float nL  = dot(n,  LUMA);
  float neL = dot(ne, LUMA);
  float wL  = dot(w,  LUMA);
  float cL  = dot(c,  LUMA);
  float eL  = dot(e,  LUMA);
  float swL = dot(sw, LUMA);
  float sL  = dot(s,  LUMA);
  float seL = dot(se, LUMA);
  float nnL = dot(nn, LUMA);
  float ssL = dot(ss, LUMA);
  float wwL = dot(ww, LUMA);
  float eeL = dot(ee, LUMA);

  float gx = -nwL - 2.0 * wL - swL + neL + 2.0 * eL + seL;
  float gy = -nwL - 2.0 * nL - neL + swL + 2.0 * sL + seL;
  float grad = abs(gx) + abs(gy);
  float onEdge = smoothstep(EDGE_LO, EDGE_HI, grad);

  float min3 = min(min(min(nwL, nL), min(neL, wL)), min(min(cL, eL), min(swL, min(sL, seL))));
  float max3 = max(max(max(nwL, nL), max(neL, wL)), max(max(cL, eL), max(swL, max(sL, seL))));
  float range3 = max3 - min3;

  float min5 = min(min3, min(min(nnL, ssL), min(wwL, eeL)));
  float max5 = max(max3, max(max(nnL, ssL), max(wwL, eeL)));
  float range5 = max5 - min5;

  float nearEdge = smoothstep(NEAR_LO, NEAR_HI, range5);
  float flatness = 1.0 - smoothstep(FLAT_LO, FLAT_HI, range3);

  vec3 acc = vec3(0.0);
  float wSum = 0.0;
  accum(acc, wSum, nw, nwL, cL);
  accum(acc, wSum, n,  nL,  cL);
  accum(acc, wSum, ne, neL, cL);
  accum(acc, wSum, w,  wL,  cL);
  accum(acc, wSum, c,  cL,  cL);
  accum(acc, wSum, e,  eL,  cL);
  accum(acc, wSum, sw, swL, cL);
  accum(acc, wSum, s,  sL,  cL);
  accum(acc, wSum, se, seL, cL);
  accum(acc, wSum, nn, nnL, cL);
  accum(acc, wSum, ss, ssL, cL);
  accum(acc, wSum, ww, wwL, cL);
  accum(acc, wSum, ee, eeL, cL);
  vec3 filtered = acc / max(wSum, 1e-6);

  float lumaMix = clamp((nearEdge * LUMA_NEAR + flatness * LUMA_FLAT) * mix(1.0, EDGE_KEEP, onEdge), 0.0, 1.0);
  float chromaMix = clamp(CHROMA_BASE + nearEdge * CHROMA_NEAR + flatness * CHROMA_FLAT, 0.0, 1.0);

  float yC = cL;
  float yB = dot(filtered, LUMA);
  float yOut = mix(yC, yB, lumaMix);

  vec2 chromaC = vec2(c.b - yC, c.r - yC);
  vec2 chromaB = vec2(filtered.b - yB, filtered.r - yB);
  vec2 chromaOut = mix(chromaC, chromaB, chromaMix);

  float b = yOut + chromaOut.x;
  float r = yOut + chromaOut.y;
  float g = (yOut - LUMA.x * r - LUMA.z * b) / LUMA.y;

  outColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}
`;

class MosquitoNrFilter implements VideoFilter {
  readonly name = "mosquito-nr";
  readonly historyFrames = 0;

  private program: WebGLProgram | null = null;
  private uTexelSize: WebGLUniformLocation | null = null;
  private uFlipY: WebGLUniformLocation | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, FRAGMENT_SHADER);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_input"), 0);
    this.uTexelSize = gl.getUniformLocation(this.program, "u_texelSize");
    this.uFlipY = gl.getUniformLocation(this.program, "u_flipY");
  }

  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], params: RenderParams): void {
    if (!this.program) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0]);
    gl.uniform2f(this.uTexelSize, 1 / params.width, 1 / params.height);
    gl.uniform1i(this.uFlipY, params.flipY ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}

registerFilter("mosquito-nr", () => new MosquitoNrFilter());

import { createProgram, FULLSCREEN_VERTEX_SHADER } from "./gl-utils";
import { type RenderParams, registerFilter, type VideoFilter } from "./types";

/**
 * BWDIF (bob-weaver deinterlacing filter) — GLSL port of FFmpeg's bwdif,
 * the successor to yadif. Motion-adaptive per pixel: still areas keep both
 * fields (full vertical resolution, no bob shimmer on static detail), moving
 * areas are reconstructed with an edge-preserving spatio-temporal filter,
 * clamped to the temporal neighborhood exactly like the C reference.
 *
 * Field timing: deinterlacing field F of frame N needs the fields before and
 * after it, i.e. frames N-1 and N+1 as weaved textures. The renderer therefore
 * runs one frame behind the video (u_next is the newest upload) — ~40 ms extra
 * latency, irrelevant for IPTV. Rendered at field rate (first field, then the
 * other half a frame later) for 50p motion; which spatial field comes first is
 * the detector-determined field order (TFF/BFF).
 *
 * Deviations from the FFmpeg reference, both forced by the input being
 * RGB-decoded frames rather than raw YUV planes:
 *
 * - Luma is reconstructed from RGB (the matrix cancels on the round trip, so
 *   the filter effectively runs on a luma-equivalent plane).
 * - Chroma cannot get true per-plane bwdif: the browser upsamples 4:2:0
 *   interlaced chroma progressively, baking field-interleaved color combing
 *   (row periods 2 and 4) into the weaved RGB on ALL rows, kept lines
 *   included, so field-pure chroma samples no longer exist. Instead chroma is
 *   motion-adaptive in the same spirit as bwdif's weave test: temporally
 *   static pixels pass the original chroma through (full detail, matching
 *   FFmpeg's weave behavior), moving pixels blend toward a vertical
 *   [1,2,2,2,1]/8 low-pass that nulls both combing periods.
 *
 * Frame-boundary rows (y<4 or y+5>h) use FFmpeg's FILTER_EDGE variant: plain
 * (c+e)/2 spatial average with the spatial check only where its ±2 taps fit,
 * instead of running the wide filter into clamped (duplicated) edge rows.
 */

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev; // frame N-1 (weaved)
uniform sampler2D u_cur;  // frame N   (the frame being deinterlaced)
uniform sampler2D u_next; // frame N+1 (weaved)
uniform float u_height;      // frame height in pixels
uniform float u_keepField;   // 0.0 = render top field (even rows kept), 1.0 = bottom field
uniform float u_secondField; // 1.0 = this is the temporally second field of the frame
uniform float u_spatialOnly; // 1.0 = no real frame history yet: spatial-only interpolation

in vec2 v_texCoord;
out vec4 outColor;

// BT.709 luma/chroma split (only mixed and unmixed inside the shader, so the
// exact matrix does not matter for the round trip)
float lumaOf(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

vec2 chromaOf(vec3 rgb) {
  float y = lumaOf(rgb);
  return vec2((rgb.b - y) * 0.5389, (rgb.r - y) * 0.6350);
}

vec3 rowRGB(sampler2D t, float dy) {
  float texelH = 1.0 / u_height;
  return texture(t, vec2(v_texCoord.x, clamp(v_texCoord.y + dy * texelH, 0.0, 1.0))).rgb;
}

float rowLuma(sampler2D t, float dy) {
  return lumaOf(rowRGB(t, dy));
}

// prev2/next2: frames whose rows at the MISSING parity are the temporally
// previous/next fields of the field being rendered (see FFmpeg bwdif).
// First field of the frame: the missing field is newer in prev, older in cur.
// Second field: the missing field is older in cur, newer in next.
float prev2Luma(float dy) {
  return u_secondField < 0.5 ? rowLuma(u_prev, dy) : rowLuma(u_cur, dy);
}

float next2Luma(float dy) {
  return u_secondField < 0.5 ? rowLuma(u_cur, dy) : rowLuma(u_next, dy);
}

// FFmpeg bwdif FILTER1 + SPAT_CHECK + FILTER_LINE/FILTER_EDGE + FILTER2 in
// float form (integer coefficients are /8192 fixed-point in the reference).
// isEdge selects FFmpeg's filter_edge variant for rows whose wide-filter taps
// (rows +-3, +-4) would cross the frame boundary; spatCheck mirrors its spat flag.
float bwdifLuma(bool isEdge, bool spatCheck) {
  float c = rowLuma(u_cur, -1.0);
  float e = rowLuma(u_cur, 1.0);
  float p2_0 = prev2Luma(0.0);
  float n2_0 = next2Luma(0.0);
  float d = 0.5 * (p2_0 + n2_0);

  // FILTER1: temporal difference — FFmpeg works on 8-bit integers, so its
  // "!diff" test means diff < 1 after halving; 0.5/255 is that exact threshold
  float td0 = abs(p2_0 - n2_0);
  float td1 = 0.5 * (abs(rowLuma(u_prev, -1.0) - c) + abs(rowLuma(u_prev, 1.0) - e));
  float td2 = 0.5 * (abs(rowLuma(u_next, -1.0) - c) + abs(rowLuma(u_next, 1.0) - e));
  float diff = max(max(td0 * 0.5, td1), td2);

  // No temporal change at this pixel: pure temporal average (weave) — this is
  // what preserves full vertical resolution in static areas
  if (diff < 0.5 / 255.0) {
    return d;
  }

  float interpol;
  if (isEdge) {
    // FILTER_EDGE: spatial check only when the ±2 taps are in-frame, then a
    // plain spatial average — the reference never runs the wide filters here
    if (spatCheck) {
      float b = 0.5 * (prev2Luma(-2.0) + next2Luma(-2.0)) - c;
      float f = 0.5 * (prev2Luma(2.0) + next2Luma(2.0)) - e;
      float dc = d - c;
      float de = d - e;
      float mx = max(max(de, dc), min(b, f));
      float mn = min(min(de, dc), max(b, f));
      diff = max(max(diff, mn), -mx);
    }
    interpol = 0.5 * (c + e);
  } else {
    // SPAT_CHECK
    float p2_m2 = prev2Luma(-2.0);
    float n2_m2 = next2Luma(-2.0);
    float p2_p2 = prev2Luma(2.0);
    float n2_p2 = next2Luma(2.0);

    float b = 0.5 * (p2_m2 + n2_m2) - c;
    float f = 0.5 * (p2_p2 + n2_p2) - e;
    float dc = d - c;
    float de = d - e;
    float mx = max(max(de, dc), min(b, f));
    float mn = min(min(de, dc), max(b, f));
    diff = max(max(diff, mn), -mx);

    // FILTER_LINE
    float curM3 = rowLuma(u_cur, -3.0);
    float curP3 = rowLuma(u_cur, 3.0);
    if (abs(c - e) > td0) {
      // High-frequency content across the gap: Weston 3-field HF term + LF term
      float hf = (5570.0 * (p2_0 + n2_0) - 3801.0 * (p2_m2 + n2_m2 + p2_p2 + n2_p2) +
                  1016.0 * (prev2Luma(-4.0) + next2Luma(-4.0) + prev2Luma(4.0) + next2Luma(4.0))) /
                 4.0;
      interpol = (hf + 4309.0 * (c + e) - 213.0 * (curM3 + curP3)) / 8192.0;
    } else {
      interpol = (5077.0 * (c + e) - 981.0 * (curM3 + curP3)) / 8192.0;
    }
  }

  // FILTER2: clamp to the temporal neighborhood
  return clamp(interpol, d - diff, d + diff);
}

// Motion measure for the chroma path: reuse bwdif's FILTER1 temporal diff on
// the chroma channels of the same rows the luma filter reads
float chromaMotion() {
  vec2 cCur = chromaOf(rowRGB(u_cur, 0.0));
  vec2 cPrev = chromaOf(rowRGB(u_prev, 0.0));
  vec2 cNext = chromaOf(rowRGB(u_next, 0.0));
  vec2 d1 = abs(cPrev - cCur);
  vec2 d2 = abs(cNext - cCur);
  return max(max(d1.x, d1.y), max(d2.x, d2.y));
}

void main() {
  float row = v_texCoord.y * u_height;
  float parity = mod(floor(row), 2.0);

  // FFmpeg row dispatch: rows y<4 or y+5>h use filter_edge (wide taps would
  // cross the boundary); the spatial check needs the ±2 taps in-frame
  bool isEdge = row < 4.0 || row + 5.0 > u_height;
  bool spatCheck = row >= 2.0 && row + 3.0 <= u_height;

  float luma;
  if (parity == u_keepField) {
    // Kept field line: pass through
    luma = rowLuma(u_cur, 0.0);
  } else if (u_spatialOnly > 0.5) {
    // No real history in the ring (just started / primed while paused):
    // temporal terms would see duplicated frames and weave the combing
    // through. Interpolate spatially from the kept field only.
    float c = rowLuma(u_cur, -1.0);
    float e = rowLuma(u_cur, 1.0);
    luma = isEdge ? 0.5 * (c + e) : (5077.0 * (c + e) - 981.0 * (rowLuma(u_cur, -3.0) + rowLuma(u_cur, 3.0))) / 8192.0;
  } else {
    luma = bwdifLuma(isEdge, spatCheck);
  }

  // Chroma: motion-adaptive. Static pixels keep original chroma (full detail,
  // analogous to bwdif's weave path); moving pixels blend toward a vertical
  // [1,2,2,2,1]/8 low-pass that nulls the period-2/period-4 field-interleaved
  // chroma combing the progressive 4:2:0 upsample bakes into ALL rows.
  vec2 chromaOrig = chromaOf(rowRGB(u_cur, 0.0));
  vec2 chromaLP = (chromaOf(rowRGB(u_cur, -2.0)) + 2.0 * chromaOf(rowRGB(u_cur, -1.0)) + 2.0 * chromaOrig +
                   2.0 * chromaOf(rowRGB(u_cur, 1.0)) + chromaOf(rowRGB(u_cur, 2.0))) /
                  8.0;
  // Ramp: fully original below ~1/255 motion, fully low-passed above ~4/255.
  // Without real history chromaMotion() compares duplicated frames (always 0),
  // so force the low-pass — the combing is baked in regardless of motion.
  float t = u_spatialOnly > 0.5 ? 1.0 : smoothstep(1.0 / 255.0, 4.0 / 255.0, chromaMotion());
  vec2 chroma = mix(chromaOrig, chromaLP, t);

  float r = luma + 1.5748 * chroma.y;
  float bl = luma + 1.8556 * chroma.x;
  float g = (luma - 0.2126 * r - 0.0722 * bl) / 0.7152;
  outColor = vec4(clamp(vec3(r, g, bl), 0.0, 1.0), 1.0);
}
`;

class BwdifFilter implements VideoFilter {
  readonly name = "bwdif";
  // Ring of 3 weaved frames: [0] = newest (u_next), [1] = current, [2] = previous
  readonly historyFrames = 2;

  private program: WebGLProgram | null = null;
  private uHeight: WebGLUniformLocation | null = null;
  private uKeepField: WebGLUniformLocation | null = null;
  private uSecondField: WebGLUniformLocation | null = null;
  private uSpatialOnly: WebGLUniformLocation | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FULLSCREEN_VERTEX_SHADER, FRAGMENT_SHADER);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_next"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_cur"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_prev"), 2);
    this.uHeight = gl.getUniformLocation(this.program, "u_height");
    this.uKeepField = gl.getUniformLocation(this.program, "u_keepField");
    this.uSecondField = gl.getUniformLocation(this.program, "u_secondField");
    this.uSpatialOnly = gl.getUniformLocation(this.program, "u_spatialOnly");
  }

  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], params: RenderParams): void {
    if (!this.program) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    for (let unit = 0; unit < 3; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      // Clamp for the priming phase where the ring is still filling up
      gl.bindTexture(gl.TEXTURE_2D, textures[Math.min(unit, textures.length - 1)]);
    }
    gl.uniform1f(this.uHeight, params.height);
    gl.uniform1f(this.uKeepField, params.keepField);
    gl.uniform1f(this.uSecondField, params.isSecondField ? 1 : 0);
    gl.uniform1f(this.uSpatialOnly, params.spatialOnly ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}

registerFilter("bwdif", () => new BwdifFilter());

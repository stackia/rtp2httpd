import { createProgram, FULLSCREEN_VERTEX_SHADER } from "./gl-utils";
import { type DeinterlaceAlgorithm, type FrameParams, registerAlgorithm } from "./types";

/**
 * Bob deinterlacer. Per rendered field: keeps that field's lines and
 * reconstructs the missing lines by averaging the field lines above and below.
 * The renderer drives it at field rate (two renders per frame, top field first
 * for TFF) so 25i input yields 50p motion.
 *
 * Luma and chroma are treated separately: the decoder upsamples 4:2:0
 * interlaced chroma progressively, leaving field-interleaved color combing in
 * the weaved RGB frame with row periods 2 AND 4 (chroma row pairs alternate
 * between fields). Line-parity bob cannot remove it, so chroma instead gets a
 * vertical [1,2,2,2,1]/8 low-pass, which nulls both periods exactly (measured
 * chroma comb 0.019 → ~0). Chroma is half vertical resolution to begin with,
 * so the blur cost is negligible.
 */

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform sampler2D u_frame;
uniform float u_height;    // frame height in pixels
uniform float u_keepField; // 0.0 = keep top field (even rows), 1.0 = keep bottom field (odd rows)

in vec2 v_texCoord;
out vec4 outColor;

// BT.709 RGB <-> YCbCr (values only mix/unmix within the shader, exact matrix
// choice does not matter for the round trip)
vec3 toYCbCr(vec3 rgb) {
  float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec3(y, (rgb.b - y) * 0.5389, (rgb.r - y) * 0.6350);
}

vec3 toRGB(vec3 ycc) {
  float r = ycc.x + 1.5748 * ycc.z;
  float b = ycc.x + 1.8556 * ycc.y;
  float g = (ycc.x - 0.2126 * r - 0.0722 * b) / 0.7152;
  return vec3(r, g, b);
}

vec3 sampleRow(float offsetRows) {
  float texelH = 1.0 / u_height;
  return texture(u_frame, vec2(v_texCoord.x, clamp(v_texCoord.y + offsetRows * texelH, 0.0, 1.0))).rgb;
}

void main() {
  float row = v_texCoord.y * u_height;
  float parity = mod(floor(row), 2.0);

  // Luma: field-parity bob
  float luma;
  if (parity == u_keepField) {
    luma = toYCbCr(sampleRow(0.0)).x;
  } else {
    luma = 0.5 * (toYCbCr(sampleRow(-1.0)).x + toYCbCr(sampleRow(1.0)).x);
  }

  // Chroma: 5-tap vertical low-pass, kills period-2 and period-4 field combing
  vec3 c = toYCbCr(sampleRow(-2.0)) + 2.0 * toYCbCr(sampleRow(-1.0)) + 2.0 * toYCbCr(sampleRow(0.0)) +
           2.0 * toYCbCr(sampleRow(1.0)) + toYCbCr(sampleRow(2.0));
  vec2 chroma = c.yz / 8.0;

  outColor = vec4(clamp(toRGB(vec3(luma, chroma)), 0.0, 1.0), 1.0);
}
`;

class BobAlgorithm implements DeinterlaceAlgorithm {
  readonly name = "bob";
  readonly historyFrames = 0;

  private program: WebGLProgram | null = null;
  private uHeight: WebGLUniformLocation | null = null;
  private uKeepField: WebGLUniformLocation | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FULLSCREEN_VERTEX_SHADER, FRAGMENT_SHADER);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_frame"), 0);
    this.uHeight = gl.getUniformLocation(this.program, "u_height");
    this.uKeepField = gl.getUniformLocation(this.program, "u_keepField");
  }

  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], params: FrameParams): void {
    if (!this.program) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0]);
    gl.uniform1f(this.uHeight, params.height);
    gl.uniform1f(this.uKeepField, params.keepField);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}

registerAlgorithm("bob", () => new BobAlgorithm());

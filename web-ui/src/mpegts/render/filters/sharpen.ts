import { createProgram, FRAMEBUFFER_VERTEX_SHADER } from "./gl-utils";
import { type RenderParams, registerFilter, type VideoFilter } from "./types";

/**
 * Post-stage enhancement filter: edge-masked unsharp mask plus a mild
 * contrast/saturation lift. Stateless — no history frames, no temporal state,
 * so channel switches and stage changes need no special handling.
 *
 * Unlike source stage filters (passthrough/bwdif), the input is a framebuffer
 * texture rather than a DOM video upload, hence FRAMEBUFFER_VERTEX_SHADER.
 */

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform vec2 u_texelSize;

in vec2 v_texCoord;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Tone tweak applied together with sharpening; part of the enhancement look.
const float CONTRAST = 1.04;
const float SATURATION = 1.03;
const float SHARPEN_STRENGTH = 0.22;

float lumaOf(vec3 rgb) {
  return dot(rgb, LUMA);
}

vec3 sampleInput(vec2 uv) {
  return texture(u_input, clamp(uv, u_texelSize * 0.5, vec2(1.0) - u_texelSize * 0.5)).rgb;
}

vec3 weightedBlur(vec2 uv) {
  vec3 c = sampleInput(uv) * 4.0;
  c += sampleInput(uv + vec2(-u_texelSize.x, 0.0)) * 2.0;
  c += sampleInput(uv + vec2(u_texelSize.x, 0.0)) * 2.0;
  c += sampleInput(uv + vec2(0.0, -u_texelSize.y)) * 2.0;
  c += sampleInput(uv + vec2(0.0, u_texelSize.y)) * 2.0;
  c += sampleInput(uv + vec2(-u_texelSize.x, -u_texelSize.y));
  c += sampleInput(uv + vec2(u_texelSize.x, -u_texelSize.y));
  c += sampleInput(uv + vec2(-u_texelSize.x, u_texelSize.y));
  c += sampleInput(uv + vec2(u_texelSize.x, u_texelSize.y));
  return c / 16.0;
}

void main() {
  vec3 rgb = sampleInput(v_texCoord);
  vec3 blur = weightedBlur(v_texCoord);
  vec3 detail = clamp(rgb - blur, vec3(-0.06), vec3(0.06));
  float edge = abs(lumaOf(rgb) - lumaOf(blur));
  float edgeMask = smoothstep(0.012, 0.075, edge) * (1.0 - smoothstep(0.18, 0.34, edge));

  rgb += detail * SHARPEN_STRENGTH * edgeMask;
  rgb = (rgb - 0.5) * CONTRAST + 0.5;
  float y = lumaOf(rgb);
  rgb = mix(vec3(y), rgb, SATURATION);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

class SharpenFilter implements VideoFilter {
  readonly name = "sharpen";
  readonly historyFrames = 0;

  private program: WebGLProgram | null = null;
  private inputLocation: WebGLUniformLocation | null = null;
  private texelSizeLocation: WebGLUniformLocation | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, FRAGMENT_SHADER);
    this.inputLocation = gl.getUniformLocation(this.program, "u_input");
    this.texelSizeLocation = gl.getUniformLocation(this.program, "u_texelSize");
  }

  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], params: RenderParams): void {
    if (!this.program || textures.length === 0) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0]);
    gl.uniform1i(this.inputLocation, 0);
    gl.uniform2f(this.texelSizeLocation, 1 / params.width, 1 / params.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    this.inputLocation = null;
    this.texelSizeLocation = null;
  }
}

registerFilter("sharpen", () => new SharpenFilter());

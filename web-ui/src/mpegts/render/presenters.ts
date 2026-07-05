import { createProgram, FRAMEBUFFER_VERTEX_SHADER } from "./filters/gl-utils";

/**
 * Final canvas presentation pass. Presenters differ from VideoFilters in that
 * they draw to the default framebuffer and need to know the output size in
 * addition to the source size (the sizes differ when the canvas backing store
 * is scaled to the display). The renderer owns the viewport; presenters only
 * bind their program and draw.
 */
export interface Presenter {
  readonly name: string;
  /** Compile shaders / allocate GL resources. Called once per GL context. */
  init(gl: WebGL2RenderingContext): void;
  /** Draw `texture` (srcWidth x srcHeight) to the bound framebuffer (dstWidth x dstHeight). */
  present(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
  ): void;
  /** Release GL resources. The context may already be lost; guard accordingly. */
  destroy(gl: WebGL2RenderingContext): void;
}

const PASSTHROUGH_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  outColor = texture(u_input, v_texCoord);
}
`;

/** 1:1 blit; scaling to the display is left to the browser's canvas compositing. */
export class PassthroughPresenter implements Presenter {
  readonly name = "passthrough-present";

  private program: WebGLProgram | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, PASSTHROUGH_FRAGMENT_SHADER);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_input"), 0);
  }

  present(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    _srcWidth: number,
    _srcHeight: number,
    _dstWidth: number,
    _dstHeight: number,
  ): void {
    if (!this.program) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}

const BICUBIC_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform vec2 u_sourceSize;
uniform vec2 u_outputSize;

in vec2 v_texCoord;
out vec4 outColor;

float catmullRom(float x) {
  x = abs(x);
  if (x <= 1.0) {
    return 1.5 * x * x * x - 2.5 * x * x + 1.0;
  }
  if (x < 2.0) {
    return -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0;
  }
  return 0.0;
}

vec3 sampleBicubic(vec2 uv) {
  vec2 sourceCoord = uv * u_sourceSize - 0.5;
  vec2 baseCoord = floor(sourceCoord);
  vec2 fraction = sourceCoord - baseCoord;
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;

  for (int y = -1; y <= 2; y++) {
    float wy = catmullRom(float(y) - fraction.y);
    for (int x = -1; x <= 2; x++) {
      float wx = catmullRom(float(x) - fraction.x);
      float weight = wx * wy;
      vec2 sampleCoord = (baseCoord + vec2(float(x), float(y)) + 0.5) / u_sourceSize;
      sum += texture(u_input, clamp(sampleCoord, vec2(0.0), vec2(1.0))).rgb * weight;
      weightSum += weight;
    }
  }

  return weightSum != 0.0 ? sum / weightSum : texture(u_input, uv).rgb;
}

void main() {
  bool upscaling = u_outputSize.x > u_sourceSize.x + 0.5 || u_outputSize.y > u_sourceSize.y + 0.5;
  vec3 rgb = upscaling ? sampleBicubic(v_texCoord) : texture(u_input, v_texCoord).rgb;
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

/** Catmull-Rom bicubic upscaling when the canvas backing store exceeds the source size. */
export class BicubicPresenter implements Presenter {
  readonly name = "bicubic-present";

  private program: WebGLProgram | null = null;
  private inputLocation: WebGLUniformLocation | null = null;
  private sourceSizeLocation: WebGLUniformLocation | null = null;
  private outputSizeLocation: WebGLUniformLocation | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, BICUBIC_FRAGMENT_SHADER);
    this.inputLocation = gl.getUniformLocation(this.program, "u_input");
    this.sourceSizeLocation = gl.getUniformLocation(this.program, "u_sourceSize");
    this.outputSizeLocation = gl.getUniformLocation(this.program, "u_outputSize");
  }

  present(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
  ): void {
    if (!this.program) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.inputLocation, 0);
    gl.uniform2f(this.sourceSizeLocation, srcWidth, srcHeight);
    gl.uniform2f(this.outputSizeLocation, dstWidth, dstHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    this.inputLocation = null;
    this.sourceSizeLocation = null;
    this.outputSizeLocation = null;
  }
}

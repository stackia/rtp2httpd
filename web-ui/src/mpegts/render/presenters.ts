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
  /**
   * Draw `texture` (srcWidth x srcHeight) to the bound framebuffer (dstWidth x dstHeight).
   * `flipY` must be true when `texture` is a raw DOM video upload sampled without an
   * intervening source-stage render pass (bwdif's output and other framebuffer-backed
   * textures are already in native orientation and want `flipY: false`).
   */
  present(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
    flipY: boolean,
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
  private flipYLocation: WebGLUniformLocation | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, PASSTHROUGH_FRAGMENT_SHADER);
    this.flipYLocation = gl.getUniformLocation(this.program, "u_flipY");
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
    flipY: boolean,
  ): void {
    if (!this.program) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(this.flipYLocation, flipY ? 1 : 0);
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

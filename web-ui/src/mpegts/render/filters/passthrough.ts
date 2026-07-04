import { createProgram, FULLSCREEN_VERTEX_SHADER } from "./gl-utils";
import { type RenderParams, registerFilter, type VideoFilter } from "./types";

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  outColor = texture(u_input, v_texCoord);
}
`;

class PassthroughFilter implements VideoFilter {
  readonly name = "passthrough";
  readonly historyFrames = 0;

  private program: WebGLProgram | null = null;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FULLSCREEN_VERTEX_SHADER, FRAGMENT_SHADER);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_input"), 0);
  }

  render(gl: WebGL2RenderingContext, textures: WebGLTexture[], _params: RenderParams): void {
    if (!this.program || textures.length === 0) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textures[0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}

registerFilter("passthrough", () => new PassthroughFilter());

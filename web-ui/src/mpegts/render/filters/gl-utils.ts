/** Small WebGL2 helpers shared by video filters. */

export function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program");
  }
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders are owned by the program after linking
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${info}`);
  }
  return program;
}

/**
 * Vertex shader emitting a fullscreen triangle from gl_VertexID (no vertex buffers needed).
 * v_texCoord has (0,0) at the top-left of the video frame (texel row 0 = top video row,
 * so Y is flipped relative to clip space). Field parity math relies on this orientation.
 */
export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
out vec2 v_texCoord;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_texCoord = vec2(pos.x, 1.0 - pos.y);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * Vertex shader for framebuffer-backed textures. Unlike DOM video uploads,
 * framebuffer textures use WebGL's native bottom-left texture origin.
 */
export const FRAMEBUFFER_VERTEX_SHADER = `#version 300 es
out vec2 v_texCoord;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_texCoord = pos;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

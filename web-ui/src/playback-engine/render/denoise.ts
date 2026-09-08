import { createProgram, FRAMEBUFFER_VERTEX_SHADER } from "./filters/gl-utils";

/**
 * Motion-adaptive, recursive video denoising at source resolution. RGB stores
 * the filtered image; alpha stores the ORIGINAL luma. Comparing original luma
 * across a five-pixel patch distinguishes changing detail from random noise,
 * without an extra copy pass or a second history attachment.
 *
 * History is rejected on moving edges and clipped to the current neighborhood
 * before blending. Chroma also participates in rejection (isoluminant motion).
 * There is no lookahead, motion extrapolation, or added presentation latency.
 */
const FRAGMENT_SHADER = /*glsl*/ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D u_input;
uniform sampler2D u_history;
uniform vec2 u_texelSize;
uniform bool u_hasHistory;
uniform bool u_flipY;

in vec2 v_texCoord;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 toYcc(vec3 rgb) {
  float y = dot(rgb, LUMA);
  return vec3(y, (rgb.b - y) / 1.8556, (rgb.r - y) / 1.5748);
}

vec3 toRgb(vec3 ycc) {
  float r = ycc.x + 1.5748 * ycc.z;
  float b = ycc.x + 1.8556 * ycc.y;
  return vec3(r, (ycc.x - LUMA.x * r - LUMA.z * b) / LUMA.y, b);
}

void main() {
  vec2 uv = v_texCoord;
  vec2 dx = vec2(u_texelSize.x, 0.0);
  vec2 dy = vec2(0.0, u_texelSize.y);
  vec3 p[9];
  p[0] = toYcc(texture(u_input, uv - dx - dy).rgb);
  p[1] = toYcc(texture(u_input, uv      - dy).rgb);
  p[2] = toYcc(texture(u_input, uv + dx - dy).rgb);
  p[3] = toYcc(texture(u_input, uv - dx).rgb);
  p[4] = toYcc(texture(u_input, uv).rgb);
  p[5] = toYcc(texture(u_input, uv + dx).rgb);
  p[6] = toYcc(texture(u_input, uv - dx + dy).rgb);
  p[7] = toYcc(texture(u_input, uv      + dy).rgb);
  p[8] = toYcc(texture(u_input, uv + dx + dy).rgb);
  vec3 c = p[4];

  // History is framebuffer-backed, even when the input is a DOM upload.
  vec2 huv = u_flipY ? vec2(uv.x, 1.0 - uv.y) : uv;
  vec2 hdy = u_flipY ? -dy : dy;
  vec4 history = texture(u_history, huv);
  vec3 h = toYcc(history.rgb);
  float d0 = c.x - history.a;
  float dn = p[1].x - texture(u_history, huv - hdy).a;
  float dw = p[3].x - texture(u_history, huv - dx).a;
  float de = p[5].x - texture(u_history, huv + dx).a;
  float ds = p[7].x - texture(u_history, huv + hdy).a;
  float meanDelta = (d0 * 2.0 + dn + dw + de + ds) / 6.0;
  float deltaVariance = max(0.0, (2.0*d0*d0 + dn*dn + dw*dw + de*de + ds*ds) / 6.0 - meanDelta*meanDelta);
  float sigma = u_hasHistory ? clamp(sqrt(deltaVariance * 0.5), 0.0, 0.035) : 0.012;

  // Opposing differences reveal translating edges even if their average cancels.
  float structureDelta = max(abs(de - dw), abs(ds - dn));
  float motion = abs(meanDelta);
  float confidence = 1.0 - smoothstep(0.008 + sigma * 0.35, 0.024 + sigma * 0.65, motion);
  confidence *= 1.0 - smoothstep(0.020 + sigma * 1.5, 0.060 + sigma * 2.0, structureDelta);
  confidence *= 1.0 - smoothstep(0.025 + sigma, 0.070 + sigma, abs(d0));
  // A weak translating edge changes the center and at least two neighbors
  // in the same direction. Random grain rarely agrees at all three pixels.
  // This catches low-contrast motion without rejecting isolated noise peaks.
  vec4 aligned = max(vec4(dn, dw, de, ds) * sign(d0), 0.0);
  vec2 pairMin = min(aligned.xz, aligned.yw);
  vec2 pairMax = max(aligned.xz, aligned.yw);
  float secondLargest = max(min(pairMax.x, pairMax.y), max(pairMin.x, pairMin.y));
  float coherentDelta = min(abs(d0), secondLargest);
  confidence *= 1.0 - smoothstep(0.009 + sigma * 0.5, 0.020 + sigma * 0.6, coherentDelta);
  float cornerDelta = min(abs(d0), max(pairMax.x, pairMax.y));
  confidence *= 1.0 - smoothstep(0.004 + sigma * 1.8, 0.010 + sigma * 1.7, cornerDelta);
  confidence *= 1.0 - smoothstep(0.025, 0.070, max(abs(c.y - h.y), abs(c.z - h.z)));
  if (!u_hasHistory) confidence = 0.0;

  vec3 lo = c, hi = c, mean = vec3(0.0), moment = vec3(0.0);
  vec3 spatial = vec3(0.0);
  float weightSum = 0.0;
  float rangeSigma = 0.018 + min(sigma, 0.025) * 1.5;
  for (int i = 0; i < 9; ++i) {
    vec3 v = p[i];
    lo = min(lo, v);
    hi = max(hi, v);
    mean += v;
    moment += v * v;
    // Both luma and chroma edges constrain the spatial average.
    vec3 delta = v - c;
    float distance = delta.x * delta.x + dot(delta.yz, delta.yz) * 0.5;
    float w = exp2(-distance / (rangeSigma * rangeSigma));
    w *= i == 4 ? 2.0 : (i == 1 || i == 3 || i == 5 || i == 7 ? 1.0 : 0.5);
    spatial += v * w;
    weightSum += w;
  }
  spatial /= weightSum;
  mean /= 9.0;
  vec3 deviation = sqrt(max(moment / 9.0 - mean * mean, vec3(0.0)));

  // Repeated clean detail has sigma=0 and is left alone. Moving detail gets
  // only mild spatial NR; stable noisy areas can average more confidently.
  float noiseAmount = smoothstep(0.003, 0.018, sigma);
  float lumaMix = noiseAmount * mix(0.12, 0.55, confidence);
  float chromaMix = noiseAmount * mix(0.25, 0.65, confidence);
  vec3 current = mix(c, spatial, vec3(lumaMix, chromaMix, chromaMix));

  // Variance clipping prevents old silhouettes surviving a scene cut or
  // disocclusion. Use both the variance box and the true neighborhood bounds.
  vec3 extent = max(deviation * 1.25, vec3(0.004, 0.006, 0.006));
  // The current center is always a valid sample, including a thin line or a
  // texture peak outside the variance box. Do not erase consistent detail.
  vec3 clipped = clamp(h, min(current, max(lo, mean - extent)), max(current, min(hi, mean + extent)));
  float innovation = abs(current.x - h.x);
  confidence *= 1.0 - smoothstep(0.018 + sigma, 0.055 + sigma, innovation);
  vec3 weight = confidence * vec3(0.90, 0.92, 0.92);
  vec3 result = mix(current, clipped, weight);
  outColor = vec4(clamp(toRgb(result), 0.0, 1.0), c.x);
}
`;

interface HistoryTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class TemporalDenoiser {
  private program: WebGLProgram | null = null;
  private texelSizeLocation: WebGLUniformLocation | null = null;
  private flipYLocation: WebGLUniformLocation | null = null;
  private hasHistoryLocation: WebGLUniformLocation | null = null;
  private targets: HistoryTarget[] = [];
  private width = 0;
  private height = 0;
  private writeIndex = 0;
  private hasHistory = false;
  private floatHistory = false;

  init(gl: WebGL2RenderingContext): void {
    this.program = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, FRAGMENT_SHADER);
    this.texelSizeLocation = gl.getUniformLocation(this.program, "u_texelSize");
    this.flipYLocation = gl.getUniformLocation(this.program, "u_flipY");
    this.hasHistoryLocation = gl.getUniformLocation(this.program, "u_hasHistory");
    this.floatHistory = !!gl.getExtension("EXT_color_buffer_float");
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_input"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_history"), 1);
  }

  render(gl: WebGL2RenderingContext, input: WebGLTexture, width: number, height: number, flipY: boolean): WebGLTexture {
    if (!this.program) throw new Error("TemporalDenoiser.render() called before init()");
    this.ensureTargets(gl, width, height);
    const target = this.targets[this.writeIndex];
    const previous = this.targets[1 - this.writeIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, width, height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, previous.texture);
    gl.uniform2f(this.texelSizeLocation, 1 / width, 1 / height);
    gl.uniform1i(this.flipYLocation, flipY ? 1 : 0);
    gl.uniform1i(this.hasHistoryLocation, this.hasHistory ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.writeIndex = 1 - this.writeIndex;
    this.hasHistory = true;
    return target.texture;
  }

  /** Call on seeks, source/stage changes, and before re-rendering the same frame. */
  reset(): void {
    this.hasHistory = false;
  }

  private ensureTargets(gl: WebGL2RenderingContext, width: number, height: number): void {
    if (this.width === width && this.height === height && this.targets.length === 2) return;
    this.releaseTransientResources(gl);
    try {
      for (let i = 0; i < 2; i++) {
        const texture = gl.createTexture();
        const fbo = gl.createFramebuffer();
        if (!texture || !fbo) {
          gl.deleteTexture(texture);
          gl.deleteFramebuffer(fbo);
          throw new Error("Unable to allocate video denoise history");
        }
        this.targets.push({ texture, fbo });
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Half floats avoid accumulating 8-bit rounding errors in dark gradients.
        gl.texStorage2D(gl.TEXTURE_2D, 1, this.floatHistory ? gl.RGBA16F : gl.RGBA8, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Incomplete video denoise framebuffer");
        }
      }
    } catch (error) {
      this.releaseTransientResources(gl);
      throw error;
    }
    this.width = width;
    this.height = height;
  }

  releaseTransientResources(gl: WebGL2RenderingContext): void {
    for (const target of this.targets) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.fbo);
    }
    this.targets = [];
    this.width = this.height = this.writeIndex = 0;
    this.reset();
  }

  destroy(gl: WebGL2RenderingContext): void {
    this.releaseTransientResources(gl);
    gl.deleteProgram(this.program);
    this.program = null;
  }
}

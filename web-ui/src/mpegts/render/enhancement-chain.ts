import { createProgram, FRAMEBUFFER_VERTEX_SHADER } from "./filters/gl-utils";
import type { RenderParams } from "./filters/types";

interface RenderTarget {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

const SPATIAL_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform vec2 u_texelSize;
uniform vec2 u_sourceSize;

in vec2 v_texCoord;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float lumaOf(vec3 rgb) {
  return dot(rgb, LUMA);
}

vec3 sampleInput(vec2 uv) {
  return texture(u_input, clamp(uv, u_texelSize * 0.5, vec2(1.0) - u_texelSize * 0.5)).rgb;
}

vec3 blur3x3(vec2 uv) {
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += sampleInput(uv + vec2(float(x), float(y)) * u_texelSize);
    }
  }
  return sum / 9.0;
}

float edgeGradient(vec2 uv) {
  float l = lumaOf(sampleInput(uv - vec2(u_texelSize.x, 0.0)));
  float r = lumaOf(sampleInput(uv + vec2(u_texelSize.x, 0.0)));
  float d = lumaOf(sampleInput(uv - vec2(0.0, u_texelSize.y)));
  float u = lumaOf(sampleInput(uv + vec2(0.0, u_texelSize.y)));
  return max(abs(l - r), abs(d - u));
}

vec3 deblock(vec2 uv, vec3 rgb, float gradient) {
  vec2 srcPixel = uv * u_sourceSize;
  float phaseX = mod(srcPixel.x, 8.0);
  float phaseY = mod(srcPixel.y, 8.0);
  float nearVerticalEdge = 1.0 - smoothstep(0.6, 1.4, min(phaseX, 8.0 - phaseX));
  float nearHorizontalEdge = 1.0 - smoothstep(0.6, 1.4, min(phaseY, 8.0 - phaseY));
  float realEdgeGuard = 1.0 - smoothstep(0.10, 0.22, gradient);

  vec3 left = sampleInput(uv - vec2(u_texelSize.x, 0.0));
  vec3 right = sampleInput(uv + vec2(u_texelSize.x, 0.0));
  vec3 left2 = sampleInput(uv - vec2(u_texelSize.x * 2.0, 0.0));
  vec3 right2 = sampleInput(uv + vec2(u_texelSize.x * 2.0, 0.0));
  float verticalDiff = abs(lumaOf(left) - lumaOf(right));
  float verticalFlatness =
    1.0 - smoothstep(0.018, 0.065, abs(lumaOf(left2) - lumaOf(left)) + abs(lumaOf(right2) - lumaOf(right)));
  float verticalMask =
    nearVerticalEdge *
    smoothstep(0.025, 0.075, verticalDiff) *
    (1.0 - smoothstep(0.12, 0.24, verticalDiff)) *
    verticalFlatness *
    realEdgeGuard;

  vec3 down = sampleInput(uv - vec2(0.0, u_texelSize.y));
  vec3 up = sampleInput(uv + vec2(0.0, u_texelSize.y));
  vec3 down2 = sampleInput(uv - vec2(0.0, u_texelSize.y * 2.0));
  vec3 up2 = sampleInput(uv + vec2(0.0, u_texelSize.y * 2.0));
  float horizontalDiff = abs(lumaOf(down) - lumaOf(up));
  float horizontalFlatness =
    1.0 - smoothstep(0.018, 0.065, abs(lumaOf(down2) - lumaOf(down)) + abs(lumaOf(up2) - lumaOf(up)));
  float horizontalMask =
    nearHorizontalEdge *
    smoothstep(0.025, 0.075, horizontalDiff) *
    (1.0 - smoothstep(0.12, 0.24, horizontalDiff)) *
    horizontalFlatness *
    realEdgeGuard;

  rgb = mix(rgb, 0.5 * (left + right), 0.12 * verticalMask);
  return mix(rgb, 0.5 * (down + up), 0.12 * horizontalMask);
}

vec3 lumaAwareDenoise(vec2 uv, vec3 rgb, float gradient) {
  float centerLuma = lumaOf(rgb);
  vec3 accum = vec3(0.0);
  float weightSum = 0.0;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 neighbor = sampleInput(uv + vec2(float(x), float(y)) * u_texelSize);
      float weight = max(0.0, 1.0 - abs(lumaOf(neighbor) - centerLuma) * 9.0);
      accum += neighbor * weight;
      weightSum += weight;
    }
  }

  vec3 filtered = weightSum > 0.0 ? accum / weightSum : rgb;
  float edgeGuard = 1.0 - smoothstep(0.07, 0.18, gradient);
  return mix(rgb, filtered, 0.24 * edgeGuard);
}

vec3 chromaDenoise(vec2 uv, vec3 rgb, float gradient) {
  float yCenter = lumaOf(rgb);
  vec3 chromaCenter = rgb - vec3(yCenter);
  vec3 chromaSum = vec3(0.0);
  float ySum = 0.0;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 sampleRgb = sampleInput(uv + vec2(float(x), float(y)) * u_texelSize);
      float sampleY = lumaOf(sampleRgb);
      ySum += sampleY;
      chromaSum += sampleRgb - vec3(sampleY);
    }
  }

  float edgeGuard = 1.0 - smoothstep(0.11, 0.25, gradient);
  float filteredY = mix(yCenter, ySum / 9.0, 0.08 * edgeGuard);
  vec3 filteredChroma = mix(chromaCenter, chromaSum / 9.0, 0.30 * edgeGuard);
  return vec3(filteredY) + filteredChroma;
}

vec3 reduceMosquitoNoise(vec2 uv, vec3 rgb, float gradient) {
  vec3 base = blur3x3(uv);
  vec3 detail = rgb - base;
  float detailMagnitude = length(detail);
  float edgeNear = smoothstep(0.025, 0.10, gradient);
  float smallDetail = 1.0 - smoothstep(0.018, 0.08, detailMagnitude);
  float strength = 0.08 * edgeNear * smallDetail;

  float y = lumaOf(rgb);
  float baseY = lumaOf(base);
  vec3 chroma = rgb - vec3(y);
  vec3 baseChroma = base - vec3(baseY);
  vec3 softenedChroma = mix(chroma, baseChroma, strength);
  vec3 softenedRgb = vec3(y) + softenedChroma;
  return mix(rgb, softenedRgb, 0.85);
}

void main() {
  vec3 rgb = sampleInput(v_texCoord);
  float gradient = edgeGradient(v_texCoord);

  rgb = deblock(v_texCoord, rgb, gradient);
  rgb = reduceMosquitoNoise(v_texCoord, rgb, gradient);
  rgb = lumaAwareDenoise(v_texCoord, rgb, gradient);
  rgb = chromaDenoise(v_texCoord, rgb, gradient);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

const TEMPORAL_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_cur;
uniform sampler2D u_history;
uniform float u_hasHistory;
uniform float u_temporalEnabled;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  vec3 cur = texture(u_cur, v_texCoord).rgb;
  if (u_hasHistory < 0.5 || u_temporalEnabled < 0.5) {
    outColor = vec4(cur, 1.0);
    return;
  }

  vec3 prev = texture(u_history, v_texCoord).rgb;
  float diff = length(cur - prev);
  float weight = 1.0 - smoothstep(0.025, 0.18, diff);
  outColor = vec4(mix(cur, prev, 0.07 * weight), 1.0);
}
`;

const SHARPEN_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform vec2 u_texelSize;

in vec2 v_texCoord;
out vec4 outColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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

  rgb += detail * 0.22 * edgeMask;
  rgb = (rgb - 0.5) * 1.04 + 0.5;
  float y = lumaOf(rgb);
  rgb = mix(vec3(y), rgb, 1.03);

  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

const COPY_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_input;

in vec2 v_texCoord;
out vec4 outColor;

void main() {
  outColor = texture(u_input, v_texCoord);
}
`;

const PRESENT_FRAGMENT_SHADER = `#version 300 es
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

export class EnhancementChain {
  private spatialProgram: WebGLProgram | null = null;
  private temporalProgram: WebGLProgram | null = null;
  private sharpenProgram: WebGLProgram | null = null;
  private copyProgram: WebGLProgram | null = null;
  private presentProgram: WebGLProgram | null = null;

  private spatialUniforms: {
    input: WebGLUniformLocation | null;
    texelSize: WebGLUniformLocation | null;
    sourceSize: WebGLUniformLocation | null;
  } | null = null;
  private temporalUniforms: {
    cur: WebGLUniformLocation | null;
    history: WebGLUniformLocation | null;
    hasHistory: WebGLUniformLocation | null;
    temporalEnabled: WebGLUniformLocation | null;
  } | null = null;
  private sharpenUniforms: {
    input: WebGLUniformLocation | null;
    texelSize: WebGLUniformLocation | null;
  } | null = null;
  private copyUniforms: { input: WebGLUniformLocation | null } | null = null;
  private presentUniforms: {
    input: WebGLUniformLocation | null;
    sourceSize: WebGLUniformLocation | null;
    outputSize: WebGLUniformLocation | null;
  } | null = null;

  private targetA: RenderTarget | null = null;
  private targetB: RenderTarget | null = null;
  private historyTarget: RenderTarget | null = null;
  private historyValid = false;

  init(gl: WebGL2RenderingContext): void {
    this.spatialProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, SPATIAL_FRAGMENT_SHADER);
    this.temporalProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, TEMPORAL_FRAGMENT_SHADER);
    this.sharpenProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, SHARPEN_FRAGMENT_SHADER);
    this.copyProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, COPY_FRAGMENT_SHADER);
    this.presentProgram = createProgram(gl, FRAMEBUFFER_VERTEX_SHADER, PRESENT_FRAGMENT_SHADER);

    this.spatialUniforms = {
      input: gl.getUniformLocation(this.spatialProgram, "u_input"),
      texelSize: gl.getUniformLocation(this.spatialProgram, "u_texelSize"),
      sourceSize: gl.getUniformLocation(this.spatialProgram, "u_sourceSize"),
    };
    this.temporalUniforms = {
      cur: gl.getUniformLocation(this.temporalProgram, "u_cur"),
      history: gl.getUniformLocation(this.temporalProgram, "u_history"),
      hasHistory: gl.getUniformLocation(this.temporalProgram, "u_hasHistory"),
      temporalEnabled: gl.getUniformLocation(this.temporalProgram, "u_temporalEnabled"),
    };
    this.sharpenUniforms = {
      input: gl.getUniformLocation(this.sharpenProgram, "u_input"),
      texelSize: gl.getUniformLocation(this.sharpenProgram, "u_texelSize"),
    };
    this.copyUniforms = {
      input: gl.getUniformLocation(this.copyProgram, "u_input"),
    };
    this.presentUniforms = {
      input: gl.getUniformLocation(this.presentProgram, "u_input"),
      sourceSize: gl.getUniformLocation(this.presentProgram, "u_sourceSize"),
      outputSize: gl.getUniformLocation(this.presentProgram, "u_outputSize"),
    };
  }

  render(
    gl: WebGL2RenderingContext,
    inputTexture: WebGLTexture,
    params: RenderParams,
    outputWidth: number,
    outputHeight: number,
  ): boolean {
    if (
      !this.spatialProgram ||
      !this.temporalProgram ||
      !this.sharpenProgram ||
      !this.copyProgram ||
      !this.presentProgram ||
      !this.spatialUniforms ||
      !this.temporalUniforms ||
      !this.sharpenUniforms ||
      !this.copyUniforms ||
      !this.presentUniforms
    ) {
      return false;
    }

    const targetA = this.ensureRenderTarget(gl, "a", params.width, params.height);
    const targetB = this.ensureRenderTarget(gl, "b", params.width, params.height);
    const historyTarget = this.ensureRenderTarget(gl, "history", params.width, params.height);
    if (!targetA || !targetB || !historyTarget) return false;

    const texelSizeX = 1 / params.width;
    const texelSizeY = 1 / params.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetA.fbo);
    gl.viewport(0, 0, params.width, params.height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.spatialProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(this.spatialUniforms.input, 0);
    gl.uniform2f(this.spatialUniforms.texelSize, texelSizeX, texelSizeY);
    gl.uniform2f(this.spatialUniforms.sourceSize, params.width, params.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const temporalEnabled = this.historyValid && !params.spatialOnly && !params.isSecondField;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetB.fbo);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.temporalProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetA.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, historyTarget.texture);
    gl.uniform1i(this.temporalUniforms.cur, 0);
    gl.uniform1i(this.temporalUniforms.history, 1);
    gl.uniform1f(this.temporalUniforms.hasHistory, this.historyValid ? 1 : 0);
    gl.uniform1f(this.temporalUniforms.temporalEnabled, temporalEnabled ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!params.isSecondField) {
      this.copyTexture(gl, targetA.texture, historyTarget.fbo, params.width, params.height);
      this.historyValid = true;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetA.fbo);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.sharpenProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetB.texture);
    gl.uniform1i(this.sharpenUniforms.input, 0);
    gl.uniform2f(this.sharpenUniforms.texelSize, texelSizeX, texelSizeY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outputWidth, outputHeight);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.presentProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetA.texture);
    gl.uniform1i(this.presentUniforms.input, 0);
    gl.uniform2f(this.presentUniforms.sourceSize, params.width, params.height);
    gl.uniform2f(this.presentUniforms.outputSize, outputWidth, outputHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  resetHistory(): void {
    this.historyValid = false;
  }

  destroy(gl: WebGL2RenderingContext): void {
    for (const target of [this.targetA, this.targetB, this.historyTarget]) {
      this.deleteRenderTarget(gl, target);
    }
    this.targetA = null;
    this.targetB = null;
    this.historyTarget = null;
    this.historyValid = false;

    for (const program of [
      this.spatialProgram,
      this.temporalProgram,
      this.sharpenProgram,
      this.copyProgram,
      this.presentProgram,
    ]) {
      if (program) gl.deleteProgram(program);
    }

    this.spatialProgram = null;
    this.temporalProgram = null;
    this.sharpenProgram = null;
    this.copyProgram = null;
    this.presentProgram = null;
    this.spatialUniforms = null;
    this.temporalUniforms = null;
    this.sharpenUniforms = null;
    this.copyUniforms = null;
    this.presentUniforms = null;
  }

  private copyTexture(
    gl: WebGL2RenderingContext,
    inputTexture: WebGLTexture,
    targetFbo: WebGLFramebuffer,
    width: number,
    height: number,
  ): void {
    if (!this.copyProgram || !this.copyUniforms) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.viewport(0, 0, width, height);
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram, not a React hook
    gl.useProgram(this.copyProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    gl.uniform1i(this.copyUniforms.input, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private ensureRenderTarget(
    gl: WebGL2RenderingContext,
    slot: "a" | "b" | "history",
    width: number,
    height: number,
  ): RenderTarget | null {
    const existing = this.getRenderTarget(slot);
    if (existing?.width === width && existing.height === height) return existing;

    this.deleteRenderTarget(gl, existing);
    const next = this.createRenderTarget(gl, width, height);
    this.setRenderTarget(slot, next);
    if (slot === "history") this.historyValid = false;
    return next;
  }

  private getRenderTarget(slot: "a" | "b" | "history"): RenderTarget | null {
    if (slot === "a") return this.targetA;
    if (slot === "b") return this.targetB;
    return this.historyTarget;
  }

  private setRenderTarget(slot: "a" | "b" | "history", target: RenderTarget | null): void {
    if (slot === "a") {
      this.targetA = target;
    } else if (slot === "b") {
      this.targetB = target;
    } else {
      this.historyTarget = target;
    }
  }

  private createRenderTarget(gl: WebGL2RenderingContext, width: number, height: number): RenderTarget | null {
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

    return { fbo, texture, width, height };
  }

  private deleteRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget | null): void {
    if (!target) return;
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.texture);
  }
}

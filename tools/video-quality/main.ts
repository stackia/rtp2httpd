import { TemporalDenoiser } from "../../web-ui/src/playback-engine/render/denoise";
import type { VideoFilter } from "../../web-ui/src/playback-engine/render/filters/types";
import { FsrPresenter } from "../../web-ui/src/playback-engine/render/fsr";
import { PassthroughPresenter, type Presenter } from "../../web-ui/src/playback-engine/render/presenters";
import { invariants } from "./invariants";
import { lifecycle } from "./lifecycle";

declare const __QUALITY_BASELINE__: string;

type Mode = "raw" | "baseline" | "candidate" | "denoise";
type Pixels = Uint8Array<ArrayBuffer>;
function required<T>(value: T | null, description: string): T {
  if (value === null) throw new Error(description);
  return value;
}
const output = required(document.querySelector<HTMLCanvasElement>("#output"), "Output canvas missing");
const status = required(document.querySelector<HTMLPreElement>("#status"), "Status element missing");
const label = new URLSearchParams(location.search).get("label")?.replace(/[^\w-]/g, "");
const resultPrefix = label ? `${label}-` : "";
const gl = required(
  output.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true }),
  "WebGL2 unavailable",
);
const denoiser = new TemporalDenoiser();
denoiser.init(gl);
const candidate = new FsrPresenter();
candidate.init(gl);
const raw = new PassthroughPresenter();
raw.init(gl);
let baseline: Presenter;
let baselineNr: VideoFilter;
let baselineTarget: { texture: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number } | undefined;
const input = required(gl.createTexture(), "Texture allocation failed");
gl.bindTexture(gl.TEXTURE_2D, input);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

async function loadBaseline() {
  if (baseline) return;
  const fsrUrl = `${__QUALITY_BASELINE__}/fsr.ts`;
  const nrUrl = `${__QUALITY_BASELINE__}/filters/mosquito-nr.ts`;
  const module = await import(/* @vite-ignore */ fsrUrl);
  const nrModule = await import(/* @vite-ignore */ nrUrl);
  baseline = new module.FsrPresenter();
  baselineNr = new nrModule.MosquitoNrFilter();
  baseline.init(gl);
  baselineNr.init(gl);
}

function resize(width: number, height: number) {
  if (output.width !== width) output.width = width;
  if (output.height !== height) output.height = height;
}

function upload(data: Pixels | TexImageSource, width: number, height: number) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, input);
  if (data instanceof Uint8Array) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

function draw(mode: Mode, width: number, height: number, outWidth: number, outHeight: number, flipY = false) {
  let source = input;
  if (mode === "baseline") {
    if (!baselineTarget || baselineTarget.width !== width || baselineTarget.height !== height) {
      if (baselineTarget) {
        gl.deleteTexture(baselineTarget.texture);
        gl.deleteFramebuffer(baselineTarget.fbo);
      }
      const texture = required(gl.createTexture(), "Texture allocation failed");
      const fbo = required(gl.createFramebuffer(), "Framebuffer allocation failed");
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      baselineTarget = { texture, fbo, width, height };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, baselineTarget.fbo);
    gl.viewport(0, 0, width, height);
    baselineNr.render(gl, [input], { width, height, flipY, keepField: 0, isSecondField: false, spatialOnly: true });
    source = baselineTarget.texture;
    flipY = false;
  } else if (mode === "candidate" || mode === "denoise") {
    source = denoiser.render(gl, input, width, height, flipY);
    flipY = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, outWidth, outHeight);
  (mode === "raw" || mode === "denoise" ? raw : mode === "baseline" ? baseline : candidate).present(
    gl,
    source,
    width,
    height,
    outWidth,
    outHeight,
    flipY,
  );
}

function pixels(width: number, height: number, flipY = false): Pixels {
  const data = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  if (flipY) {
    const row = new Uint8Array(width * 4);
    for (let y = 0; y < Math.floor(height / 2); y++) {
      const top = y * row.length;
      const bottom = (height - y - 1) * row.length;
      row.set(data.subarray(top, top + row.length));
      data.copyWithin(top, bottom, bottom + row.length);
      data.set(row, bottom);
    }
  }
  return data;
}

function scene(width: number, height: number, frame = 0, moving = false): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      let color: number[];
      if (y < height / 3) color = [25 + (x / width) * 205, 25 + (x / width) * 205, 25 + (x / width) * 205];
      else if (x < width / 3) {
        const v = x > (y - height / 3) * 0.42 ? 195 : 50;
        color = [v, v * 0.9, v * 0.7];
      } else if (x < (width * 2) / 3) {
        const v = 110 + Math.sin(x * 1.2) * Math.cos(y * 0.7) * 22;
        color = [v * 0.7, v, v * 0.8];
      } else color = [110 + 18 * Math.sin(x * 0.04), 95 + 15 * Math.cos(y * 0.05), 160];
      const rectX = moving ? 12 + ((frame * 13) % Math.max(1, width - 60)) : -100;
      if (x >= rectX && x < rectX + 35 && y > height * 0.2 && y < height * 0.8) color = [220, 70, 55];
      for (let c = 0; c < 3; c++) data[index + c] = Math.round(color[c]);
      data[index + 3] = 255;
    }
  return data;
}

function noisy(clean: Pixels, seed: number, amplitude = 6): Pixels {
  const data = clean.slice();
  let state = seed | 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < data.length; i += 4) {
    const noise = (random() + random() + random() + random() - 2) * amplitude * Math.sqrt(3);
    for (let c = 0; c < 3; c++)
      data[i + c] = Math.round(Math.max(0, Math.min(255, clean[i + c] + noise + (random() - 0.5) * amplitude)));
  }
  return data;
}

function error(actual: Pixels, expected: Pixels) {
  let squared = 0,
    absolute = 0,
    maximum = 0;
  for (let i = 0; i < actual.length; i++)
    if (i % 4 !== 3) {
      const delta = Math.abs(actual[i] - expected[i]);
      squared += delta * delta;
      absolute += delta;
      maximum = Math.max(maximum, delta);
    }
  const count = (actual.length / 4) * 3;
  return { psnr: squared ? 10 * Math.log10((255 * 255) / (squared / count)) : 100, mae: absolute / count, maximum };
}

async function save(name: string, result: unknown) {
  const text = JSON.stringify(result, null, 2);
  const response = await fetch(`/results/${resultPrefix}${name}.json`, { method: "POST", body: text });
  if (!response.ok) throw new Error(`Saving ${name} failed: ${response.status}`);
  status.textContent = text;
}

async function savePng(name: string) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    output.toBlob((b) => (b ? resolve(b) : reject(Error("PNG failed")))),
  );
  const response = await fetch(`/results/${resultPrefix}${name}.png`, { method: "POST", body: blob });
  if (!response.ok) throw new Error(`Saving ${name} failed`);
}

async function synthetic() {
  await loadBaseline();
  const width = 384,
    height = 216;
  resize(width, height);
  const checks: Record<string, unknown> = {};
  for (const mode of ["raw", "baseline", "candidate", "denoise"] as const) {
    const modeResult: Record<string, unknown> = {};
    for (const [name, moving, amplitude] of [
      ["clean", false, 0],
      ["noise", false, 6],
      ["motion", true, 0],
      ["noisy-motion", true, 6],
    ] as const) {
      denoiser.reset();
      let expected = scene(width, height);
      for (let frame = 0; frame < 16; frame++) {
        expected = scene(width, height, frame, moving);
        const data = amplitude ? noisy(expected, 1009 + frame * 719, amplitude) : expected;
        upload(data, width, height);
        draw(mode, width, height, width, height);
      }
      modeResult[name] = error(pixels(width, height), expected);
      await savePng(`synthetic-${name}-${mode}`);
    }
    let maximum = 0;
    for (const color of [
      [0, 0, 0],
      [255, 255, 255],
      [4, 4, 4],
      [128, 128, 128],
      [251, 251, 251],
      [200, 70, 30],
      [40, 140, 190],
    ]) {
      denoiser.reset();
      const data = new Uint8Array(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set([...color, 255], i);
      for (let frame = 0; frame < 8; frame++) {
        upload(data, width, height);
        draw(mode, width, height, width, height);
      }
      maximum = Math.max(maximum, error(pixels(width, height), data).maximum);
    }
    modeResult.flatColorMaximumError = maximum;
    checks[mode] = modeResult;
  }
  checks.glError = gl.getError();
  await save("synthetic", { gpu: gpuInfo(), checks });
  return checks;
}

function gpuInfo() {
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    timer: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    floatHistory: !!gl.getExtension("EXT_color_buffer_float"),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    userAgent: navigator.userAgent,
  };
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

async function timing(width = 1920, height = 1080, outWidth = 3840, outHeight = 2160) {
  await loadBaseline();
  resize(outWidth, outHeight);
  upload(scene(width, height), width, height);
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const drawsPerSample = 8;
  const order = ["raw", "baseline", "candidate"] as const;
  const readings = Object.fromEntries(
    order.map((mode) => [mode, { samples: [] as number[], submissions: [] as number[] }]),
  );
  // Rotate the order across three rounds to distribute GPU clock/thermal drift.
  for (let round = 0; round < 3; round++)
    for (let position = 0; position < order.length; position++) {
      const mode = order[(round + position) % order.length];
      const { samples, submissions } = readings[mode];
      denoiser.reset();
      for (let i = 0; i < 12; i++) draw(mode, width, height, outWidth, outHeight);
      gl.finish();
      for (let i = 0; i < 15; i++) {
        const query = ext ? gl.createQuery() : null;
        if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        const start = performance.now();
        for (let frame = 0; frame < drawsPerSample; frame++) draw(mode, width, height, outWidth, outHeight);
        submissions.push((performance.now() - start) / drawsPerSample);
        if (query) {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          gl.flush();
          const deadline = performance.now() + 5000;
          while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
            if (performance.now() > deadline || gl.isContextLost()) {
              gl.deleteQuery(query);
              throw Error("GPU timing query did not complete");
            }
            await new Promise((r) => setTimeout(r, 0));
          }
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT))
            samples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / drawsPerSample);
          gl.deleteQuery(query);
        } else {
          gl.finish();
          samples.push((performance.now() - start) / drawsPerSample);
        }
        if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
  const modes: Record<string, unknown> = {};
  for (const mode of order) {
    const { samples, submissions } = readings[mode];
    if (samples.length < 30) throw Error(`Only ${samples.length} valid ${mode} timing samples`);
    modes[mode] = {
      measurement: ext ? "GPU timer ms" : "synchronous CPU+GPU completion ms",
      render: distribution(samples),
      submission: distribution(submissions),
      samples,
    };
  }
  const result = {
    gpu: gpuInfo(),
    source: [width, height],
    output: [outWidth, outHeight],
    drawsPerSample,
    modes,
    glError: gl.getError(),
  };
  await save(`timing-${width}x${height}-${outWidth}x${outHeight}`, result);
  return result;
}

async function compare(clip = "sport", time = 3, outWidth = 2560, outHeight = 1440) {
  if (time < 11 / 50) throw Error("Comparison needs eleven preceding 50 fps frames");
  await loadBaseline();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;width:16px;height:9px;opacity:0;pointer-events:none";
  document.body.append(video);
  try {
    video.src = `/fixtures/${clip}.mp4`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Recording load timed out")), 10000);
      video.onloadeddata = () => {
        clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(Error("Cannot load recording"));
      };
    });
    const width = video.videoWidth,
      height = video.videoHeight;
    resize(outWidth, outHeight);
    const timestamps: number[] = [];
    const seek = async (t: number) => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          video.cancelVideoFrameCallback(handle);
          reject(Error(`No decoded frame for ${t}s`));
        }, 5000);
        const handle = video.requestVideoFrameCallback((_now, metadata) => {
          clearTimeout(timeout);
          timestamps.push(metadata.mediaTime);
          if (Math.abs(metadata.mediaTime - t) > 0.001)
            reject(Error(`Requested ${t}s, decoded ${metadata.mediaTime}s`));
          else resolve();
        });
        video.currentTime = t;
      });
    };
    for (const mode of ["raw", "baseline", "candidate"] as const) {
      denoiser.reset();
      // Independent prior frames, not repeated observations of the same image.
      for (let frame = 11; frame >= 0; frame--) {
        await seek(time - frame / 50);
        upload(video, width, height);
        draw(mode, width, height, outWidth, outHeight, true);
      }
      await savePng(`${clip}-${time}-${mode}`);
    }
    const result = {
      clip,
      time,
      timestamps,
      source: [width, height],
      output: [outWidth, outHeight],
      glError: gl.getError(),
    };
    await save(`${clip}-${time}`, result);
    return result;
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

async function restoration(clip = "sport", amplitude = 0) {
  await loadBaseline();
  const response = await fetch(`/fixtures/${clip}-reference.png`);
  if (!response.ok) throw Error("Reference PNG unavailable");
  const reference = await createImageBitmap(await response.blob());
  const width = reference.width / 2,
    height = reference.height / 2;
  const canvas = document.createElement("canvas");
  canvas.width = reference.width;
  canvas.height = reference.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("2D canvas unavailable");
  ctx.drawImage(reference, 0, 0);
  const expected = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  reference.close();
  const downsampled = new Uint8Array(width * height * 4);
  // Exact 2x2 area reduction, identical for every algorithm and browser.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = (y * 2 * canvas.width + x * 2) * 4;
      for (let c = 0; c < 3; c++)
        downsampled[i + c] = Math.round(
          (expected[p + c] +
            expected[p + 4 + c] +
            expected[p + canvas.width * 4 + c] +
            expected[p + canvas.width * 4 + 4 + c]) /
            4,
        );
      downsampled[i + 3] = 255;
    }
  resize(canvas.width, canvas.height);
  const checks: Record<string, unknown> = {};
  for (const mode of ["raw", "baseline", "candidate"] as const) {
    denoiser.reset();
    for (let frame = 0; frame < 16; frame++) {
      upload(amplitude ? noisy(downsampled, 1009 + frame * 719, amplitude) : downsampled, width, height);
      draw(mode, width, height, canvas.width, canvas.height, true);
    }
    checks[mode] = error(pixels(canvas.width, canvas.height, true), expected);
    await savePng(`restoration-${clip}-${amplitude}-${mode}`);
  }
  await save(`restoration-${clip}-${amplitude}`, {
    clip,
    amplitude,
    source: [width, height],
    output: [canvas.width, canvas.height],
    checks,
    glError: gl.getError(),
  });
  return checks;
}

const lab = {
  synthetic,
  timing,
  compare,
  restoration,
  gpuInfo,
  invariants: async () => {
    const result = invariants();
    await save("invariants", result);
    return result;
  },
  lifecycle: async () => {
    const result = await lifecycle();
    await save("lifecycle", result);
    return result;
  },
};
Object.assign(window, { qualityLab: lab });
function run(task: () => Promise<unknown>) {
  status.textContent = "Running…";
  void task().catch((error) => {
    status.textContent = String(error.stack ?? error);
    console.error(error);
  });
}
required(document.querySelector("#synthetic"), "Test button missing").addEventListener("click", () => run(synthetic));
required(document.querySelector("#timing"), "Timing button missing").addEventListener("click", () =>
  run(() => timing()),
);
required(document.querySelector("#compare"), "Compare button missing").addEventListener("click", () =>
  run(() => compare(required(document.querySelector<HTMLSelectElement>("#clip"), "Clip selector missing").value)),
);
required(document.querySelector("#invariants"), "Invariant button missing").addEventListener("click", () =>
  run(lab.invariants),
);
required(document.querySelector("#lifecycle"), "Lifecycle button missing").addEventListener("click", () =>
  run(lab.lifecycle),
);
status.textContent = JSON.stringify(gpuInfo(), null, 2);

import { TemporalDenoiser } from "../../web-ui/src/playback-engine/render/denoise";
import { FsrPresenter } from "../../web-ui/src/playback-engine/render/fsr";
import { PassthroughPresenter } from "../../web-ui/src/playback-engine/render/presenters";

type Pixels = Uint8Array<ArrayBuffer>;

function difference(actual: Pixels, expected: Pixels) {
  let maximum = 0;
  let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) continue;
    const delta = Math.abs(actual[i] - expected[i]);
    maximum = Math.max(maximum, delta);
    sum += delta;
  }
  return { maximum, mae: sum / ((actual.length / 4) * 3) };
}

/** Ground-truth motion and resource checks on real GPU objects, in both history formats. */
export function invariants() {
  const results: Record<string, unknown> = {};
  for (const forceRgba8 of [false, true]) {
    const width = 193;
    const height = 109;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const real = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!real) throw Error("WebGL2 unavailable");
    const formats: number[] = [];
    const gl = new Proxy(real, {
      get(target, key) {
        if (key === "getExtension")
          return (name: string) => (forceRgba8 && name === "EXT_color_buffer_float" ? null : target.getExtension(name));
        if (key === "texStorage2D")
          return (...args: Parameters<WebGL2RenderingContext["texStorage2D"]>) => {
            formats.push(args[2]);
            target.texStorage2D(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const input = gl.createTexture();
    if (!input) throw Error("Input texture unavailable");
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const denoiser = new TemporalDenoiser();
    const raw = new PassthroughPresenter();
    const fsr = new FsrPresenter();
    denoiser.init(gl);
    raw.init(gl);
    fsr.init(gl);
    const checks: Record<string, unknown> = {};
    const draw = (data: Pixels, flipY = false, sharpen = false) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const texture = denoiser.render(gl, input, width, height, flipY);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      (sharpen ? fsr : raw).present(gl, texture, width, height, width, height, false);
      const pixels = new Uint8Array(data.length);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const solid = (color: number[]) => {
      const data = new Uint8Array(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set([...color, 255], i);
      return data;
    };
    try {
      let flatError = 0;
      for (const color of [
        [0, 0, 0],
        [255, 255, 255],
        [2, 4, 6],
        [17, 17, 17],
        [201, 41, 97],
      ]) {
        denoiser.reset();
        const data = solid(color);
        let actual = data;
        for (let frame = 0; frame < 24; frame++) actual = draw(data, false, true);
        flatError = Math.max(flatError, difference(actual, data).maximum);
      }
      checks.flatColorMaximum = flatError;
      if (flatError > 1) throw Error(`Flat color drifted by ${flatError} codes`);

      // An asymmetric gradient makes an upside-down history visible immediately.
      const gradient = solid([0, 0, 0]);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          gradient.set([20 + y, 30 + Math.floor(x / 2), 200 - y, 255], i);
        }
      const reversed = new Uint8Array(gradient.length);
      for (let y = 0; y < height; y++)
        reversed.set(gradient.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
      denoiser.reset();
      let flipped = gradient;
      for (let frame = 0; frame < 20; frame++) flipped = draw(gradient, true);
      checks.flippedHistory = difference(flipped, reversed);
      if (difference(flipped, reversed).maximum > 1) throw Error("History orientation changed the gradient");

      const before = solid([30, 100, 180]);
      denoiser.reset();
      for (let frame = 0; frame < 20; frame++) draw(before);
      const cut = draw(gradient);
      denoiser.reset();
      const fresh = draw(gradient);
      checks.sceneCut = difference(cut, fresh);
      if (difference(cut, fresh).maximum > 2) throw Error("A scene cut retained the previous image");

      for (const [name, foreground] of [
        ["low-contrast", [87, 87, 87]],
        // Almost equal BT.709 luma; only chroma can identify the moving patch.
        ["isoluminant", [120, 68, 80]],
      ] as const) {
        for (const speed of [1, 7]) {
          denoiser.reset();
          let maxError = 0;
          let maxMae = 0;
          for (let frame = 0; frame < 20; frame++) {
            const data = solid([80, 80, 80]);
            const left = 4 + frame * speed;
            for (let y = 20; y < 80; y++)
              for (let x = left; x < left + 29; x++) data.set([...foreground, 255], (y * width + x) * 4);
            const delta = difference(draw(data), data);
            maxError = Math.max(maxError, delta.maximum);
            maxMae = Math.max(maxMae, delta.mae);
          }
          checks[`${name}-${speed}px`] = { maximum: maxError, mae: maxMae };
          if (maxError > 4 || maxMae > 0.15)
            throw Error(`Visible trails in ${name} at ${speed}px/frame: maximum=${maxError}, mae=${maxMae}`);
        }
      }
      const code = gl.getError();
      if (code !== gl.NO_ERROR) throw Error(`WebGL invariant error ${code}`);
      checks.historyFormat = formats[1] === gl.RGBA16F ? "RGBA16F" : "RGBA8";
      checks.source = [width, height];
      results[forceRgba8 ? "fallback" : "preferred"] = checks;
    } finally {
      denoiser.destroy(gl);
      raw.destroy(gl);
      fsr.destroy(gl);
      gl.deleteTexture(input);
      real.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  return results;
}

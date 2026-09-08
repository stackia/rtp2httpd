import { createVideoRenderPipeline } from "../../web-ui/src/playback-engine/render";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Full-frame geometry checks against the browser's native video presentation. */
export async function anamorphic() {
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:960px;height:540px;max-width:none";
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:absolute;width:100%;height:100%;opacity:0";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;width:100%;height:100%";
  container.append(video, canvas);
  document.body.append(container);

  const context = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  assert(context, "WebGL2 unavailable");
  const gl = context;
  const drawArrays = gl.drawArrays;
  let capture: { pixels: Uint8Array; width: number; height: number } | undefined;
  let captureEnabled = false;
  const errors: number[] = [];
  // Capture in the draw call, before the browser discards the drawing buffer.
  gl.drawArrays = function (...args) {
    drawArrays.apply(this, args);
    const code = this.getError();
    if (code) errors.push(code);
    if (!captureEnabled || this.getParameter(this.FRAMEBUFFER_BINDING) !== null) return;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    this.readPixels(0, 0, canvas.width, canvas.height, this.RGBA, this.UNSIGNED_BYTE, pixels);
    capture = { pixels, width: canvas.width, height: canvas.height };
  };
  const pipeline = createVideoRenderPipeline(video, canvas);
  const results: Record<string, unknown>[] = [];
  const reference = document.createElement("canvas");
  const referenceContext = reference.getContext("2d", { willReadFrequently: true });
  assert(referenceContext, "Native video reference unavailable");

  const compare = (step: string) => {
    assert(capture, `${step}: no frame presented`);
    const { pixels, width, height } = capture;
    reference.width = width;
    reference.height = height;
    referenceContext.drawImage(video, 0, 0, width, height);
    const expected = referenceContext.getImageData(0, 0, width, height).data;
    let sum = 0;
    let large = 0;
    let maximum = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const actualIndex = ((height - y - 1) * width + x) * 4;
        const expectedIndex = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(pixels[actualIndex + c] - expected[expectedIndex + c]);
          sum += delta;
          maximum = Math.max(maximum, delta);
          if (delta > 20) large++;
        }
      }
    }
    const samples = width * height * 3;
    const result = { step, output: [width, height], mae: sum / samples, maximum, largeFraction: large / samples };
    assert(result.mae < 2 && result.largeFraction < 0.005, `Frame geometry changed: ${JSON.stringify(result)}`);
    assert(errors.length === 0 && gl.getError() === gl.NO_ERROR, `WebGL errors: ${errors}`);
    return result;
  };

  const load = async (name: string) => {
    const ready = new Promise<void>((resolve, reject) => {
      const loaded = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        video.removeEventListener("loadeddata", loaded);
        reject(Error(`No video data for ${name}`));
      }, 10000);
      video.addEventListener("loadeddata", loaded, { once: true });
    });
    video.src = `/fixtures/${name}.mp4`;
    await ready;
    const firstFrame = new Promise<VideoFrameCallbackMetadata>((resolve, reject) => {
      let handle = 0;
      const timeout = setTimeout(() => {
        video.cancelVideoFrameCallback(handle);
        reject(Error(`No decoded frame for ${name}`));
      }, 10000);
      handle = video.requestVideoFrameCallback((_now, metadata) => {
        clearTimeout(timeout);
        resolve(metadata);
      });
    });
    await video.play();
    const metadata = await firstFrame;
    video.pause();
    return metadata;
  };

  try {
    for (const name of ["anamorphic-4x3", "anamorphic-16x9", "anamorphic-ntsc"]) {
      pipeline.reset();
      pipeline.setAutoDeinterlaceEnabled(false);
      pipeline.setPictureEnhancementEnabled(false);
      captureEnabled = false;
      const metadata = await load(name);
      assert(
        metadata.width !== video.videoWidth || metadata.height !== video.videoHeight,
        `${name}: expected non-square pixels, got decoded ${metadata.width}x${metadata.height}, display ${video.videoWidth}x${video.videoHeight}`,
      );
      assert(!pipeline.active, "Raw playback unexpectedly activated WebGL");
      const checks: unknown[] = [];

      captureEnabled = true;
      capture = undefined;
      pipeline.setPictureEnhancementEnabled(true);
      assert(pipeline.active, "Paused enhancement did not activate");
      checks.push(compare("enable-after-raw-pause"));

      for (let i = 0; i < 3; i++) {
        pipeline.setPictureEnhancementEnabled(false);
        capture = undefined;
        pipeline.setPictureEnhancementEnabled(true);
        checks.push(compare(`paused-toggle-${i + 1}`));
      }

      pipeline.setScanType("interlaced");
      pipeline.setAutoDeinterlaceEnabled(true);
      checks.push(compare("deinterlace-and-enhance"));
      capture = undefined;
      pipeline.setPictureEnhancementEnabled(false);
      checks.push(compare("deinterlace-only"));
      pipeline.setPictureEnhancementEnabled(true);
      checks.push(compare("enhancement-restored"));

      const played = new Promise<void>((resolve, reject) => {
        let count = 0;
        let handle = 0;
        const timeout = setTimeout(() => {
          video.cancelVideoFrameCallback(handle);
          reject(Error(`Playback stalled for ${name}`));
        }, 10000);
        const frame = () => {
          if (++count === 4) {
            clearTimeout(timeout);
            resolve();
          } else handle = video.requestVideoFrameCallback(frame);
        };
        handle = video.requestVideoFrameCallback(frame);
      });
      await video.play();
      await played;
      video.pause();
      checks.push(compare("continuous-field-playback"));

      results.push({
        name,
        decoded: [metadata.width, metadata.height],
        display: [video.videoWidth, video.videoHeight],
        checks,
      });
    }
    return results;
  } finally {
    pipeline.destroy();
    gl.drawArrays = drawArrays;
    video.pause();
    video.removeAttribute("src");
    video.load();
    container.remove();
  }
}

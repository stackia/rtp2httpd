import { createVideoRenderPipeline } from "../../web-ui/src/playback-engine/render";
import type { PlayerRenderState } from "../../web-ui/src/playback-engine/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function event(target: EventTarget, name: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      target.removeEventListener(name, done);
      reject(new Error(`Timed out waiting for ${name}`));
    }, timeoutMs);
    target.addEventListener(name, done, { once: true });
  });
}

/** Exercises the real renderer and real WebGL objects, including context loss. */
export async function lifecycle() {
  const container = document.createElement("div");
  container.style.cssText = "position:relative;width:1280px;height:720px;max-width:none";
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:absolute;width:100%;height:100%;opacity:0";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;width:100%;height:100%";
  container.append(video, canvas);
  document.body.append(container);

  const live = new Map(["Texture", "Framebuffer", "Program", "Shader"].map((name) => [name, new Set<unknown>()]));
  const createContext = canvas.getContext.bind(canvas);
  let context: WebGL2RenderingContext | null = null;
  let draws = 0;
  let presentations = 0;
  const errors: { method: string; code: number; stack?: string }[] = [];
  const states: PlayerRenderState[] = [];
  Object.defineProperty(canvas, "getContext", {
    value(type: string, options: WebGLContextAttributes) {
      assert(type === "webgl2", "Unexpected context type");
      if (context) return context;
      const real = createContext("webgl2", options);
      assert(real, "WebGL2 unavailable");
      const functions = new Map<PropertyKey, unknown>();
      context = new Proxy(real, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          if (!functions.has(key))
            functions.set(key, (...args: unknown[]) => {
              const result = Reflect.apply(value, target, args);
              const name = String(key);
              if (name.startsWith("create") && result) live.get(name.slice(6))?.add(result);
              if (name.startsWith("delete")) live.get(name.slice(6))?.delete(args[0]);
              if (name === "drawArrays") {
                draws++;
                if (real.getParameter(real.FRAMEBUFFER_BINDING) === null) presentations++;
              }
              if (name !== "getError") {
                const code = real.getError();
                if (code && code !== real.CONTEXT_LOST_WEBGL && errors.length < 3)
                  errors.push({ method: name, code, stack: new Error().stack });
              }
              return result;
            });
          return functions.get(key);
        },
      });
      return context;
    },
  });
  // Context loss invalidates all of its objects without explicit delete calls.
  canvas.addEventListener("webglcontextlost", () => {
    for (const resources of live.values()) resources.clear();
  });
  const pipeline = createVideoRenderPipeline(video, canvas, (state) => states.push(state));
  const gl = () => {
    assert(context, "Renderer did not create a context");
    return context;
  };
  const frames = (count: number) =>
    new Promise<VideoFrameCallbackMetadata>((resolve, reject) => {
      let handle = 0;
      const timeout = setTimeout(() => {
        video.cancelVideoFrameCallback(handle);
        reject(Error("Video frames stalled"));
      }, 10000);
      const next = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (--count === 0) {
          clearTimeout(timeout);
          resolve(metadata);
        } else handle = video.requestVideoFrameCallback(next);
      };
      handle = video.requestVideoFrameCallback(next);
    });
  const sample = () => {
    const ctx = gl();
    ctx.bindFramebuffer(ctx.FRAMEBUFFER, null);
    const data = new Uint8Array(16 * 16 * 4);
    ctx.readPixels(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      16,
      16,
      ctx.RGBA,
      ctx.UNSIGNED_BYTE,
      data,
    );
    const code = ctx.getError();
    assert(
      code === ctx.NO_ERROR && errors.length === 0,
      `WebGL error while sampling output: ${code} ${JSON.stringify(errors)}`,
    );
    return data;
  };
  const snapshot = () => Object.fromEntries([...live].map(([name, objects]) => [name, objects.size]));
  const playbackQuality = () => {
    const quality = video.getVideoPlaybackQuality();
    return {
      total: quality.totalVideoFrames,
      dropped: quality.droppedVideoFrames,
      corrupted: quality.corruptedVideoFrames,
    };
  };
  const results: Record<string, unknown> = {};
  try {
    pipeline.setScanType("interlaced");
    const loaded = event(video, "loadeddata");
    video.src = "/fixtures/sport-interlaced.mp4";
    await loaded;
    await video.play();
    await frames(6);
    assert(pipeline.active, "Interlaced enhancement did not activate");
    const start = presentations;
    const first = playbackQuality();
    const metadata = await frames(25);
    const presented = presentations - start;
    assert(presented >= 42 && presented <= 54, `Expected two fields per frame, saw ${presented} presentations`);
    results.interlaced = {
      callbacks: 25,
      presentations: presented,
      mediaTime: metadata.mediaTime,
      qualityBefore: first,
      qualityAfter: playbackQuality(),
    };

    video.pause();
    pipeline.setPictureEnhancementEnabled(false);
    pipeline.setPictureEnhancementEnabled(true);
    const expected = sample();
    assert(
      expected.some((value, index) => index % 4 !== 3 && value > 0),
      "Enhanced frame is black",
    );
    const initial = snapshot();
    for (let i = 0; i < 8; i++) {
      pipeline.setPictureEnhancementEnabled(false);
      pipeline.setPictureEnhancementEnabled(true);
      const current = sample();
      assert(
        current.every((value, index) => Math.abs(value - expected[index]) <= 1),
        "Paused frame changed after repeated toggles",
      );
    }
    assert(JSON.stringify(snapshot()) === JSON.stringify(initial), "GPU resources grew across toggles");
    results.pausedToggles = { repeats: 8, resources: snapshot() };

    const seeked = event(video, "seeked");
    video.currentTime = 4;
    await seeked;
    assert(gl().getError() === gl().NO_ERROR, "WebGL error after seeking");
    results.seek = video.currentTime;

    pipeline.setAutoDeinterlaceEnabled(false);
    pipeline.setPictureEnhancementEnabled(false);
    assert(!pipeline.active, "Disabled processing did not return to raw video");
    assert(live.get("Texture")?.size === 0, "Disabling processing retained frame textures");
    pipeline.setPictureEnhancementEnabled(true);
    assert(pipeline.active, "Enhancement did not restart");

    const lose = gl().getExtension("WEBGL_lose_context");
    assert(lose, "Context-loss test unavailable");
    const lost = event(canvas, "webglcontextlost");
    lose.loseContext();
    await lost;
    assert(!pipeline.active, "Lost context did not return to raw video");
    // Restoration is only allowed after the lost event has finished dispatching.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const restored = event(canvas, "webglcontextrestored");
    lose.restoreContext();
    await restored;
    assert(pipeline.active, "Context restoration did not restart enhancement");
    assert(gl().getError() === gl().NO_ERROR, "WebGL error after context restoration");
    results.contextRestored = true;

    pipeline.reset();
    const resized = event(video, "loadeddata");
    video.src = "/fixtures/sd.mp4";
    await resized;
    await video.play();
    await frames(4);
    video.pause();
    pipeline.setPictureEnhancementEnabled(false);
    pipeline.setPictureEnhancementEnabled(true);
    assert(pipeline.active, "Enhancement did not survive source/resolution change");
    assert(gl().getError() === gl().NO_ERROR, "WebGL error after resolution change");
    results.resized = { source: [video.videoWidth, video.videoHeight], output: [canvas.width, canvas.height] };
    pipeline.destroy();
    for (const [kind, objects] of live) assert(objects.size === 0, `Leaked ${objects.size} ${kind} objects`);
    results.resourcesAfterDestroy = snapshot();
    results.states = states;
    results.draws = draws;
    assert(errors.length === 0, `WebGL errors: ${JSON.stringify(errors)}`);
    results.glErrors = errors;
    return results;
  } finally {
    pipeline.destroy();
    video.pause();
    video.removeAttribute("src");
    video.load();
    container.remove();
  }
}

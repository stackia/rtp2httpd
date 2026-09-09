import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVideoRenderPipeline, type VideoRenderPipeline } from ".";

const { present, upload } = vi.hoisted(() => ({ present: vi.fn(), upload: vi.fn() }));

// Exercise the real pipeline and frame scheduling; GPU output is checked in a browser.
vi.mock("./presenters", () => ({
  PassthroughPresenter: class {
    init() {}
    present = present;
    destroy() {}
  },
}));
vi.mock("./fsr", () => ({
  FsrPresenter: class {
    init() {}
    present = present;
    releaseTransientResources() {}
    destroy() {}
  },
}));
vi.mock("./denoise", () => ({
  TemporalDenoiser: class {
    init() {}
    render(_gl: unknown, texture: unknown) {
      return texture;
    }
    reset() {}
    releaseTransientResources() {}
    destroy() {}
  },
}));
vi.mock("./filters/bwdif", () => ({}));
vi.mock("./filters/types", () => ({
  createFilter: (name: string) => ({ name, historyFrames: 2, init() {}, render() {}, destroy() {} }),
}));

class TestVideo extends EventTarget {
  videoWidth = 768;
  videoHeight = 576;
  readyState = 1;
  paused = true;
  private nextHandle = 0;
  private callbacks = new Map<number, VideoFrameRequestCallback>();

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    const handle = ++this.nextHandle;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelVideoFrameCallback(handle: number): void {
    this.callbacks.delete(handle);
  }

  deliverFrame(mediaTime = 0): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    const now = mediaTime * 1000;
    for (const callback of callbacks) {
      callback(now, {
        width: 720,
        height: 576,
        mediaTime,
        presentationTime: now,
        expectedDisplayTime: now,
        presentedFrames: Math.round(mediaTime * 25) + 1,
        processingDuration: 0,
      });
    }
  }
}

function createCanvas(): HTMLCanvasElement {
  const gl = {
    getParameter: () => 4096,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    checkFramebufferStatus: () => 0x8cd5,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    texSubImage2D: upload,
    bindTexture() {},
    texStorage2D() {},
    texImage2D() {},
    texParameteri() {},
    activeTexture() {},
    bindFramebuffer() {},
    framebufferTexture2D() {},
    viewport() {},
    deleteTexture() {},
    deleteFramebuffer() {},
  };
  return Object.assign(new EventTarget(), {
    width: 300,
    height: 150,
    parentElement: null,
    getContext: () => gl,
  }) as unknown as HTMLCanvasElement;
}

describe("first decoded video frame", () => {
  let pipeline: VideoRenderPipeline;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("HTMLVideoElement", TestVideo);
    vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal("window", { requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
  });

  afterEach(() => {
    pipeline?.destroy();
    vi.unstubAllGlobals();
  });

  it.each([
    { enhancement: true, deinterlace: false },
    { enhancement: false, deinterlace: true },
    { enhancement: true, deinterlace: true },
  ])("presents without waiting for a second frame: %o", ({ enhancement, deinterlace }) => {
    const video = new TestVideo();
    const canvas = createCanvas();
    pipeline = createVideoRenderPipeline(video as unknown as HTMLVideoElement, canvas);
    pipeline.setPictureEnhancementEnabled(enhancement);
    pipeline.setAutoDeinterlaceEnabled(deinterlace);
    pipeline.setScanType("interlaced");

    // Chromium can deliver rVFC before it advances readyState to HAVE_CURRENT_DATA.
    video.deliverFrame();

    expect(pipeline.active).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(1);
    expect(present.mock.calls[0].slice(2, 6)).toEqual([720, 576, 768, 576]);
    expect([canvas.width, canvas.height]).toEqual([768, 576]);
  });

  it("does not upload or filter the first frame twice when it was already primed", () => {
    const video = new TestVideo();
    video.readyState = 2;
    pipeline = createVideoRenderPipeline(video as unknown as HTMLVideoElement, createCanvas());

    video.deliverFrame();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledTimes(1);

    video.deliverFrame(0.04);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("keeps raw video when both processing features are disabled", () => {
    const video = new TestVideo();
    pipeline = createVideoRenderPipeline(video as unknown as HTMLVideoElement, createCanvas());
    pipeline.setPictureEnhancementEnabled(false);
    pipeline.setAutoDeinterlaceEnabled(false);
    pipeline.setScanType("interlaced");

    video.deliverFrame();

    expect(pipeline.active).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });
});

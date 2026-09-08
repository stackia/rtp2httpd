import { createVideoRenderPipeline } from "../../web-ui/src/playback-engine/render";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function frames(video: HTMLVideoElement, count: number) {
  return new Promise<VideoFrameCallbackMetadata>((resolve, reject) => {
    let handle = 0;
    const timeout = setTimeout(() => {
      video.cancelVideoFrameCallback(handle);
      reject(Error("Presentation frames stalled"));
    }, 10000);
    const next = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (--count === 0) {
        clearTimeout(timeout);
        resolve(metadata);
      } else handle = video.requestVideoFrameCallback(next);
    };
    handle = video.requestVideoFrameCallback(next);
  });
}

/** Verify the actual shader stages and device-pixel output of 1080p/i playback. */
export async function presentation() {
  const results: Record<string, unknown>[] = [];
  for (const interlaced of [false, true]) {
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

    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false });
    assert(gl, "WebGL2 unavailable");
    const drawArrays = gl.drawArrays;
    const stages = new Map<WebGLProgram, string>();
    let trace: string[] = [];
    let outputDraws = 0;
    let easuSource: number[] = [];
    let easuOutput: number[] = [];
    const errors: number[] = [];
    gl.drawArrays = function (...args) {
      drawArrays.apply(this, args);
      const code = this.getError();
      if (code) errors.push(code);
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram;
      let stage = stages.get(program);
      if (!stage) {
        const uniforms = new Set(
          Array.from(
            { length: this.getProgramParameter(program, this.ACTIVE_UNIFORMS) as number },
            (_, i) => this.getActiveUniform(program, i)?.name,
          ),
        );
        stage = uniforms.has("u_srcSize")
          ? "easu"
          : uniforms.has("u_hasHistory")
            ? "denoise"
            : uniforms.has("u_keepField")
              ? "bwdif"
              : uniforms.has("u_texelSize")
                ? "rcas"
                : "passthrough";
        stages.set(program, stage);
      }
      trace.push(stage);
      if (stage === "easu") {
        const sourceLocation = this.getUniformLocation(program, "u_srcSize");
        const outputLocation = this.getUniformLocation(program, "u_dstSize");
        assert(sourceLocation && outputLocation, "EASU size uniforms missing");
        easuSource = Array.from(this.getUniform(program, sourceLocation) as Float32Array);
        easuOutput = Array.from(this.getUniform(program, outputLocation) as Float32Array);
      }
      if (this.getParameter(this.FRAMEBUFFER_BINDING) === null) outputDraws++;
    };
    const pipeline = createVideoRenderPipeline(video, canvas);
    try {
      pipeline.setScanType(interlaced ? "interlaced" : "progressive");
      video.src = interlaced ? "/fixtures/sport-interlaced.mp4" : "/fixtures/sport.mp4";
      await video.play();
      const metadata = await frames(video, 6);
      video.pause();
      assert(metadata.width === 1920 && metadata.height === 1080, "Expected a 1080 source fixture");

      for (const [width, height] of [
        [1920, 1080],
        [2560, 1440],
        [3840, 2160],
      ]) {
        container.style.width = `${width / devicePixelRatio}px`;
        container.style.height = `${height / devicePixelRatio}px`;
        // ResizeObserver re-primes paused output before the second animation frame.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        assert(canvas.width === width && canvas.height === height, `Canvas did not resize to ${width}x${height}`);
        pipeline.setPictureEnhancementEnabled(false);
        trace = [];
        pipeline.setPictureEnhancementEnabled(true);
        const expected = [...(interlaced ? ["bwdif"] : []), "denoise", "easu", "rcas"];
        assert(
          JSON.stringify(trace) === JSON.stringify(expected),
          `Incomplete ${width}x${height} enhancement: ${trace}`,
        );
        assert(easuSource[0] === 1920 && easuSource[1] === 1080, `EASU sampled the wrong source: ${easuSource}`);
        assert(easuOutput[0] === width && easuOutput[1] === height, `EASU used the wrong output: ${easuOutput}`);
        const pausedStages = trace;

        trace = [];
        outputDraws = 0;
        const before = video.getVideoPlaybackQuality();
        await video.play();
        await frames(video, 12);
        video.pause();
        const after = video.getVideoPlaybackQuality();
        const counts = Object.fromEntries(expected.map((stage) => [stage, trace.filter((s) => s === stage).length]));
        assert(counts.easu === outputDraws && counts.rcas === outputDraws, "A presented frame skipped EASU or RCAS");
        assert(Math.abs(counts.denoise - outputDraws) <= 1, "A field skipped denoising");
        if (interlaced) assert(counts.bwdif === counts.denoise, "A field skipped deinterlacing");
        const expectedDraws = interlaced ? 24 : 12;
        assert(Math.abs(outputDraws - expectedDraws) <= 2, `Unexpected presentation cadence: ${outputDraws}`);
        assert(errors.length === 0 && gl.getError() === gl.NO_ERROR, `WebGL errors: ${errors}`);
        results.push({
          source: interlaced ? "1080i" : "1080p",
          output: [width, height],
          cssSize: [width / devicePixelRatio, height / devicePixelRatio],
          devicePixelRatio,
          pausedStages,
          continuousStages: counts,
          presentations: outputDraws,
          dropped: after.droppedVideoFrames - before.droppedVideoFrames,
          corrupted: after.corruptedVideoFrames - before.corruptedVideoFrames,
        });
      }
    } finally {
      pipeline.destroy();
      gl.drawArrays = drawArrays;
      video.pause();
      video.removeAttribute("src");
      video.load();
      container.remove();
    }
  }
  return results;
}

import type { PlayerConfig } from "../config";
import type { PlayerSegment } from "../types";
import Log from "../utils/logger";
import type { WorkerCommand, WorkerEvent } from "./messages";
import Pipeline, { type PipelineCallbacks } from "./pipeline";

let pipeline: Pipeline | null = null;
let gen = 0;

function post(msg: WorkerEvent, transfer?: Transferable[]): void {
  if (transfer) {
    (self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }).postMessage(msg, transfer);
  } else {
    (self as unknown as { postMessage(msg: unknown): void }).postMessage(msg);
  }
}

function createPipeline(segments: PlayerSegment[], config: PlayerConfig): Pipeline {
  const callbacks: PipelineCallbacks = {
    onInitSegment(type, initSegment) {
      const data = initSegment.data as ArrayBuffer;
      post(
        {
          type: "init-segment",
          track: type as "video" | "audio",
          data,
          codec: initSegment.codec ?? "",
          container: initSegment.container,
          gen,
        },
        [data],
      );
    },
    onMediaSegment(type, mediaSegment) {
      const data = mediaSegment.data as ArrayBuffer;
      post(
        {
          type: "media-segment",
          track: type as "video" | "audio",
          data,
          timestampOffset: mediaSegment.timestampOffset,
          gen,
        },
        [data],
      );
    },
    onLoadingComplete() {
      post({ type: "complete", gen });
    },
    onIOError(type, info) {
      post({ type: "error", category: "io", detail: type, info: info.msg, code: info.code, url: info.url, gen });
    },
    onDemuxError(type, info) {
      post({ type: "error", category: "demux", detail: type, info, gen });
    },
    onHlsInfo(info) {
      post({ type: "hls-info", live: info.live, totalDuration: info.totalDuration, gen });
    },
    onMediaInfo(info) {
      post({ type: "media-info", info, gen });
    },
    onPCMAudioData(pcm, channels, sampleRate, time) {
      const buffer = pcm.buffer as ArrayBuffer;
      post({ type: "pcm-audio-data", pcm: buffer, channels, sampleRate, time, gen }, [buffer]);
    },
  };

  return new Pipeline(segments, config, callbacks);
}

self.addEventListener("message", (e: MessageEvent) => {
  const cmd = e.data as WorkerCommand;

  switch (cmd.type) {
    case "init":
      gen = cmd.gen;
      Log.setLogLevel(cmd.config.logLevel);
      pipeline = createPipeline(cmd.segments, cmd.config);
      break;
    case "start":
      pipeline?.start();
      break;
    case "load-segments":
      gen = cmd.gen;
      pipeline?.loadSegments(cmd.segments);
      break;
    case "pause":
      pipeline?.pause();
      break;
    case "resume":
      pipeline?.resume();
      break;
    case "reset":
      if (pipeline) {
        pipeline.destroy();
        pipeline = null;
      }
      break;
    case "destroy":
      if (pipeline) {
        pipeline.destroy();
        pipeline = null;
      }
      (self as unknown as { postMessage(msg: unknown): void }).postMessage({ type: "destroyed" });
      break;
  }
});

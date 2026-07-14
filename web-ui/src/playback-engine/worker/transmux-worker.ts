import type { PlayerConfig } from "../config";
import type { TSAudioTrackInfo } from "../demux/ts-demuxer";
import type { HlsInfo } from "../hls/hls-source";
import type {
  PlaybackLoadOptions,
  PlayerAudioTrack,
  PlayerAudioTrackState,
  PlayerMediaInfo,
  PlayerSegment,
} from "../types";
import { buildAudioTrackPreferenceKey } from "../types";
import Log from "../utils/logger";
import type { WorkerCommand, WorkerEvent } from "./messages";
import Pipeline, { type MediaTimelineAnchor, type PipelineCallbacks } from "./pipeline";

type OutputEvent =
  | { kind: "init"; track: "video" | "audio"; data: ArrayBuffer; codec: string; container: string }
  | { kind: "media"; track: "video" | "audio"; data: ArrayBuffer; timestampOffset?: number };

interface PendingAudioSwitchOutput {
  queued: OutputEvent[];
  pcm: Array<{ pcm: Float32Array; channels: number; sampleRate: number; time: number }>;
  audioMode: "pending" | "mse" | "pcm";
  mediaReady: boolean;
  prepared: boolean;
}

let primaryPipeline: Pipeline | null = null;
let audioPipeline: Pipeline | null = null;
let pendingAudioPipeline: Pipeline | null = null;
let config: PlayerConfig | null = null;
let unsupportedTsAudioCodecs = new Set<string>();
let gen = 0;
let started = false;

let audioTracks: PlayerAudioTrack[] = [];
let audioTrackUrls = new Map<string, string>();
let hasHlsAudioGroup = false;
let tsAudioTrackPids = new Map<string, number>();
let selectedAudioTrackId: string | undefined;
let pendingAudioTrackId: string | undefined;
let timelineProgramDateTime: number | undefined;
let liveEdgeDistance: number | undefined;
let mediaTimelineAnchor: MediaTimelineAnchor | undefined;
let pendingInitialAudioInfo: HlsInfo | undefined;
let completePendingAudioSwitch: ((trackId: string, success: boolean, currentTime: number) => void) | null = null;

interface PendingInternalAudioSwitch extends PendingAudioSwitchOutput {
  trackId: string;
  oldTrackId: string;
  oldPid: number;
  fromTime: number;
}

let pendingInternalAudioSwitch: PendingInternalAudioSwitch | null = null;

let primaryMediaInfo: PlayerMediaInfo = {};
let audioMediaInfo: PlayerMediaInfo = {};
let primaryComplete = false;
let audioComplete = true;

// Some browsers must see both SourceBuffers before either init is parsed. When
// an alternate audio rendition is present, hold initial output until its init
// segment is ready, then post all init segments ahead of media segments.
let initialOutputGated = false;
let primaryInitSeen = false;
let audioInitSeen = false;
let primaryOutputQueue: OutputEvent[] = [];
let audioOutputQueue: OutputEvent[] = [];

function post(msg: WorkerEvent, transfer?: Transferable[]): void {
  if (transfer) {
    (self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }).postMessage(msg, transfer);
  } else {
    (self as unknown as { postMessage(msg: unknown): void }).postMessage(msg);
  }
}

function forEachPipeline(action: (pipeline: Pipeline) => void): void {
  for (const pipeline of [primaryPipeline, audioPipeline, pendingAudioPipeline]) {
    if (pipeline) action(pipeline);
  }
}

function postOutput(event: OutputEvent): void {
  if (event.kind === "init") {
    post(
      {
        type: "init-segment",
        track: event.track,
        data: event.data,
        codec: event.codec,
        container: event.container,
        gen,
      },
      [event.data],
    );
    return;
  }
  post(
    {
      type: "media-segment",
      track: event.track,
      data: event.data,
      timestampOffset: event.timestampOffset,
      gen,
    },
    [event.data],
  );
}

function postOutputEvents(events: readonly OutputEvent[], kind: OutputEvent["kind"]): void {
  for (const event of events) {
    if (event.kind === kind) postOutput(event);
  }
}

function postPCMAudio(pcm: Float32Array, channels: number, sampleRate: number, time: number): void {
  const buffer = pcm.buffer as ArrayBuffer;
  post({ type: "pcm-audio-data", pcm: buffer, channels, sampleRate, time, gen }, [buffer]);
}

function createPendingAudioSwitchOutput(): PendingAudioSwitchOutput {
  return {
    queued: [],
    pcm: [],
    audioMode: "pending",
    mediaReady: false,
    prepared: false,
  };
}

function audioModeForTsCodec(codec: string): "mse" | "pcm" {
  return codec.toLowerCase() === "mp2" ? "pcm" : "mse";
}

function reportUnsupportedTsAudioCodec(codec: string): void {
  if (unsupportedTsAudioCodecs.has(codec.toLowerCase())) {
    post({ type: "audio-codec-unsupported", codec, gen });
  }
}

function preparePendingAudioSwitch(pending: PendingAudioSwitchOutput, trackId: string, fromTime: number): void {
  if (
    pending.prepared ||
    !pending.mediaReady ||
    pending.audioMode === "pending" ||
    (pending.audioMode === "pcm" && pending.pcm.length === 0)
  )
    return;

  pending.prepared = true;
  postOutputEvents(pending.queued, "init");
  if (pending.audioMode === "pcm") {
    post({
      type: "audio-track-switch",
      trackId,
      fromTime,
      audioMode: "pcm",
      pcmFromTime: pending.pcm[0].time,
      gen,
    });
  } else {
    post({ type: "audio-track-switch", trackId, fromTime, audioMode: "mse", gen });
  }
}

function commitPendingAudioSwitch(pending: PendingAudioSwitchOutput): void {
  postOutputEvents(pending.queued, "media");
  for (const item of pending.pcm) {
    postPCMAudio(item.pcm, item.channels, item.sampleRate, item.time);
  }
  pending.queued.length = 0;
  pending.pcm.length = 0;
}

function flushInitialOutput(force = false): void {
  if (!initialOutputGated) return;
  if (!force && (!primaryInitSeen || !audioInitSeen)) return;
  initialOutputGated = false;
  const events = [...primaryOutputQueue, ...audioOutputQueue];
  primaryOutputQueue = [];
  audioOutputQueue = [];
  postOutputEvents(events, "init");
  postOutputEvents(events, "media");
}

function emitAudioTrackState(): void {
  const state: PlayerAudioTrackState = {
    tracks: audioTracks,
    selectedTrackId: selectedAudioTrackId,
    pendingTrackId: pendingAudioTrackId,
  };
  post({ type: "audio-tracks", state, gen });
}

function emitMergedMediaInfo(): void {
  post({
    type: "media-info",
    info: {
      ...primaryMediaInfo,
      audio: audioMediaInfo.audio ?? primaryMediaInfo.audio,
    },
    gen,
  });
}

function maybeComplete(): void {
  if (primaryComplete && audioComplete) post({ type: "complete", gen });
}

function outputFromInit(type: string, initSegment: Parameters<PipelineCallbacks["onInitSegment"]>[1]): OutputEvent {
  return {
    kind: "init",
    track: type as "video" | "audio",
    data: initSegment.data as ArrayBuffer,
    codec: initSegment.codec ?? "",
    container: initSegment.container,
  };
}

function outputFromMedia(type: string, mediaSegment: Parameters<PipelineCallbacks["onMediaSegment"]>[1]): OutputEvent {
  return {
    kind: "media",
    track: type as "video" | "audio",
    data: mediaSegment.data as ArrayBuffer,
    timestampOffset: mediaSegment.timestampOffset,
  };
}

function postPipelineError(
  category: "io" | "demux",
  detail: Parameters<PipelineCallbacks["onIOError"]>[0] | Parameters<PipelineCallbacks["onDemuxError"]>[0],
  info: { msg?: string; code?: number; url?: string },
  track?: "video" | "audio",
): void {
  post({
    type: "error",
    category,
    detail,
    info: info.msg,
    code: info.code,
    url: info.url,
    track,
    gen,
  });
}

function createAudioPipeline(
  url: string,
  options: {
    liveTimelineOffset?: number;
    startTime?: number;
    programDateTimeAnchor?: number;
    liveEdgeDistance?: number;
    mediaTimelineAnchor?: MediaTimelineAnchor;
  },
): Pipeline {
  if (!config) throw new Error("Worker has not been initialized");
  audioComplete = false;
  const callbacks: PipelineCallbacks = {
    onInitSegment(type, initSegment) {
      const event = outputFromInit(type, initSegment);
      if (initialOutputGated) {
        audioOutputQueue.push(event);
        audioInitSeen = true;
        flushInitialOutput();
      } else {
        postOutput(event);
      }
    },
    onMediaSegment(type, mediaSegment) {
      const event = outputFromMedia(type, mediaSegment);
      if (initialOutputGated) audioOutputQueue.push(event);
      else postOutput(event);
    },
    onLoadingComplete() {
      audioComplete = true;
      maybeComplete();
    },
    onIOError(type, info) {
      audioComplete = true;
      flushInitialOutput(true);
      postPipelineError("io", type, info, "audio");
      maybeComplete();
    },
    onDemuxError(type, info) {
      audioComplete = true;
      flushInitialOutput(true);
      postPipelineError("demux", type, { msg: info }, "audio");
      maybeComplete();
    },
    onHlsInfo() {},
    onTimelineAnchor() {},
    onTsAudioTracks() {},
    onTsAudioSourceCodec(codec) {
      reportUnsupportedTsAudioCodec(codec);
    },
    onMediaInfo(info) {
      audioMediaInfo = info;
      emitMergedMediaInfo();
    },
    onPCMAudioData(pcm, channels, sampleRate, time) {
      postPCMAudio(pcm, channels, sampleRate, time);
    },
  };
  return new Pipeline([{ url, duration: 0 }], config, callbacks, {
    forcedTrack: "audio",
    silentTsAudioCodecs: [...unsupportedTsAudioCodecs],
    ...options,
  });
}

function startInitialAudio(info: HlsInfo, anchor: MediaTimelineAnchor): void {
  const url = info.selectedAudioTrackUrl;
  if (!url) return;
  audioPipeline?.destroy();
  audioPipeline = createAudioPipeline(url, {
    programDateTimeAnchor: info.timelineProgramDateTime,
    liveEdgeDistance: info.liveEdgeDistance,
    mediaTimelineAnchor: anchor,
  });
  audioPipeline.start();
  if (!started) audioPipeline.pause();
}

function maybeStartInitialAudio(): void {
  if (!pendingInitialAudioInfo || !mediaTimelineAnchor) return;
  const info = pendingInitialAudioInfo;
  pendingInitialAudioInfo = undefined;
  startInitialAudio(info, mediaTimelineAnchor);
}

function handlePrimaryTimelineAnchor(anchor: MediaTimelineAnchor): void {
  mediaTimelineAnchor = anchor;
  maybeStartInitialAudio();
}

function handlePrimaryHlsInfo(info: HlsInfo): void {
  post({ type: "hls-info", live: info.live, totalDuration: info.totalDuration, gen });
  audioTracks = info.audioTracks ?? [];
  audioTrackUrls = new Map(Object.entries(info.audioTrackUrls ?? {}));
  hasHlsAudioGroup = info.hasAudioGroup ?? false;
  selectedAudioTrackId = info.selectedAudioTrackId;
  timelineProgramDateTime = info.timelineProgramDateTime;
  liveEdgeDistance = info.liveEdgeDistance;
  pendingAudioTrackId = undefined;
  emitAudioTrackState();
  if (info.selectedAudioTrackUrl) {
    initialOutputGated = true;
    pendingInitialAudioInfo = info;
    maybeStartInitialAudio();
  }
}

function tsAudioTrackId(pid: number): string {
  return `ts:${pid}`;
}

function tsAudioPreferenceKey(track: TSAudioTrackInfo): string {
  return buildAudioTrackPreferenceKey(tsAudioTrackId(track.pid), track.language, track.codec);
}

function preferredTsAudioPid(preferenceKey: string | undefined): number | undefined {
  if (!preferenceKey?.startsWith("ts:")) return undefined;
  const pid = Number.parseInt(preferenceKey.slice(3).split("\u001f", 1)[0], 10);
  return Number.isInteger(pid) && pid >= 0 ? pid : undefined;
}

function handlePrimaryTsAudioTracks(tracks: TSAudioTrackInfo[], selectedPid: number | undefined): void {
  // An EXT-X-MEDIA group is authoritative; audio PIDs accidentally present in
  // its video rendition must not leak into the user-facing track list.
  if (hasHlsAudioGroup) return;

  tsAudioTrackPids = new Map(tracks.map((track) => [tsAudioTrackId(track.pid), track.pid]));
  audioTracks = tracks.map((track, index) => ({
    id: tsAudioTrackId(track.pid),
    label: track.language || `Audio ${index + 1}`,
    language: track.language,
    isDefault: index === 0,
    preferenceKey: tsAudioPreferenceKey(track),
  }));
  if (!pendingInternalAudioSwitch)
    selectedAudioTrackId = selectedPid === undefined ? undefined : tsAudioTrackId(selectedPid);
  emitAudioTrackState();
}

function prepareInternalAudioSwitch(): void {
  const pending = pendingInternalAudioSwitch;
  if (pending) preparePendingAudioSwitch(pending, pending.trackId, pending.fromTime);
}

function selectInternalAudioTrack(trackId: string, pid: number, currentTime: number): void {
  if (!primaryPipeline || !selectedAudioTrackId) return;
  const oldTrackId = selectedAudioTrackId;
  const oldPid = tsAudioTrackPids.get(oldTrackId);
  if (oldPid === undefined) return;

  pendingAudioTrackId = trackId;
  pendingInternalAudioSwitch = {
    ...createPendingAudioSwitchOutput(),
    trackId,
    oldTrackId,
    oldPid,
    fromTime: currentTime,
  };
  emitAudioTrackState();

  completePendingAudioSwitch = (resultTrackId, success, resultTime) => {
    const pending = pendingInternalAudioSwitch;
    if (!pending || resultTrackId !== pending.trackId) return;
    completePendingAudioSwitch = null;
    pendingInternalAudioSwitch = null;
    pendingAudioTrackId = undefined;
    if (!success) {
      primaryPipeline?.selectTsAudioPid(pending.oldPid, resultTime);
      selectedAudioTrackId = pending.oldTrackId;
      emitAudioTrackState();
      return;
    }

    selectedAudioTrackId = pending.trackId;
    emitAudioTrackState();
    commitPendingAudioSwitch(pending);
  };

  if (!primaryPipeline.selectTsAudioPid(pid, currentTime)) {
    completePendingAudioSwitch = null;
    pendingInternalAudioSwitch = null;
    pendingAudioTrackId = undefined;
    emitAudioTrackState();
  }
}

function createPrimaryPipeline(segments: PlayerSegment[], loadOptions: PlaybackLoadOptions | undefined): Pipeline {
  if (!config) throw new Error("Worker has not been initialized");
  const callbacks: PipelineCallbacks = {
    onInitSegment(type, initSegment) {
      const event = outputFromInit(type, initSegment);
      if (type === "audio" && pendingInternalAudioSwitch) {
        pendingInternalAudioSwitch.queued.push(event);
        return;
      }
      if (initialOutputGated) {
        primaryOutputQueue.push(event);
        primaryInitSeen = true;
        flushInitialOutput();
      } else postOutput(event);
    },
    onMediaSegment(type, mediaSegment) {
      const event = outputFromMedia(type, mediaSegment);
      if (type === "audio" && pendingInternalAudioSwitch) {
        pendingInternalAudioSwitch.queued.push(event);
        pendingInternalAudioSwitch.mediaReady = true;
        prepareInternalAudioSwitch();
        return;
      }
      if (initialOutputGated) primaryOutputQueue.push(event);
      else postOutput(event);
    },
    onLoadingComplete() {
      primaryComplete = true;
      maybeComplete();
    },
    onIOError(type, info) {
      postPipelineError("io", type, info, "video");
    },
    onDemuxError(type, info) {
      postPipelineError("demux", type, { msg: info }, "video");
    },
    onHlsInfo: handlePrimaryHlsInfo,
    onTimelineAnchor: handlePrimaryTimelineAnchor,
    onTsAudioTracks: handlePrimaryTsAudioTracks,
    onTsAudioSourceCodec(codec) {
      const pending = pendingInternalAudioSwitch;
      reportUnsupportedTsAudioCodec(codec);
      if (pending) {
        pending.audioMode = audioModeForTsCodec(codec);
        prepareInternalAudioSwitch();
      }
    },
    onMediaInfo(info) {
      primaryMediaInfo = info;
      emitMergedMediaInfo();
    },
    onPCMAudioData(pcm, channels, sampleRate, time) {
      if (pendingInternalAudioSwitch) {
        pendingInternalAudioSwitch.pcm.push({ pcm, channels, sampleRate, time });
        pendingInternalAudioSwitch.mediaReady = true;
        prepareInternalAudioSwitch();
        return;
      }
      postPCMAudio(pcm, channels, sampleRate, time);
    },
  };
  return new Pipeline(segments, config, callbacks, {
    preferredAudioTrackKey: loadOptions?.preferredAudioTrackKey,
    selectedTsAudioPid: preferredTsAudioPid(loadOptions?.preferredAudioTrackKey),
    silentTsAudioCodecs: [...unsupportedTsAudioCodecs],
  });
}

function resetPipelines(): void {
  forEachPipeline((pipeline) => pipeline.destroy());
  primaryPipeline = null;
  audioPipeline = null;
  pendingAudioPipeline = null;
  audioTracks = [];
  audioTrackUrls.clear();
  hasHlsAudioGroup = false;
  tsAudioTrackPids.clear();
  selectedAudioTrackId = undefined;
  pendingAudioTrackId = undefined;
  timelineProgramDateTime = undefined;
  liveEdgeDistance = undefined;
  mediaTimelineAnchor = undefined;
  pendingInitialAudioInfo = undefined;
  completePendingAudioSwitch = null;
  pendingInternalAudioSwitch = null;
  primaryMediaInfo = {};
  audioMediaInfo = {};
  primaryComplete = false;
  audioComplete = true;
  initialOutputGated = false;
  primaryInitSeen = false;
  audioInitSeen = false;
  primaryOutputQueue = [];
  audioOutputQueue = [];
}

function load(segments: PlayerSegment[], options?: PlaybackLoadOptions): void {
  resetPipelines();
  emitAudioTrackState();
  primaryPipeline = createPrimaryPipeline(segments, options);
  if (started) primaryPipeline.start();
}

function selectAudioTrack(trackId: string, currentTime: number): void {
  if (!config || trackId === selectedAudioTrackId || trackId === pendingAudioTrackId) return;
  const tsPid = tsAudioTrackPids.get(trackId);
  if (tsPid !== undefined) {
    selectInternalAudioTrack(trackId, tsPid, currentTime);
    return;
  }
  const url = audioTrackUrls.get(trackId);
  if (!url) return;

  pendingAudioPipeline?.destroy();
  pendingAudioTrackId = trackId;
  emitAudioTrackState();

  const pendingOutput = createPendingAudioSwitchOutput();
  let candidate: Pipeline;
  let committed = false;
  let candidateComplete = false;
  let switchBoundary = currentTime;
  let candidateMediaInfo: PlayerMediaInfo = {};

  const fail = (
    category: "io" | "demux",
    detail: Parameters<PipelineCallbacks["onIOError"]>[0] | Parameters<PipelineCallbacks["onDemuxError"]>[0],
    info: { msg?: string; code?: number; url?: string },
  ) => {
    if (committed || pendingAudioPipeline !== candidate) return;
    candidate.destroy();
    pendingAudioPipeline = null;
    pendingAudioTrackId = undefined;
    completePendingAudioSwitch = null;
    emitAudioTrackState();
    postPipelineError(category, detail, info, "audio");
  };

  const prepare = () => {
    if (pendingAudioPipeline !== candidate) return;
    preparePendingAudioSwitch(pendingOutput, trackId, switchBoundary);
  };

  completePendingAudioSwitch = (resultTrackId, success) => {
    if (resultTrackId !== trackId || committed || pendingAudioPipeline !== candidate) return;
    completePendingAudioSwitch = null;
    if (!success) {
      candidate.destroy();
      pendingAudioPipeline = null;
      pendingAudioTrackId = undefined;
      emitAudioTrackState();
      return;
    }
    committed = true;
    audioComplete = candidateComplete;
    audioPipeline?.destroy();
    audioPipeline = candidate;
    pendingAudioPipeline = null;
    selectedAudioTrackId = trackId;
    pendingAudioTrackId = undefined;
    audioMediaInfo = candidateMediaInfo;
    emitMergedMediaInfo();
    emitAudioTrackState();
    commitPendingAudioSwitch(pendingOutput);
    maybeComplete();
  };

  const callbacks: PipelineCallbacks = {
    onInitSegment(type, initSegment) {
      if (committed) postOutput(outputFromInit(type, initSegment));
      else pendingOutput.queued.push(outputFromInit(type, initSegment));
    },
    onMediaSegment(type, mediaSegment) {
      if (committed) postOutput(outputFromMedia(type, mediaSegment));
      else {
        pendingOutput.queued.push(outputFromMedia(type, mediaSegment));
        pendingOutput.mediaReady = true;
        if (pendingOutput.audioMode === "pending") pendingOutput.audioMode = "mse";
        prepare();
      }
    },
    onLoadingComplete() {
      candidateComplete = true;
      if (!pendingOutput.mediaReady)
        fail("demux", "FormatError", { msg: "Selected audio rendition contains no media" });
      else if (committed) {
        audioComplete = true;
        maybeComplete();
      }
    },
    onIOError(type, info) {
      fail("io", type, info);
    },
    onDemuxError(type, info) {
      fail("demux", type, { msg: info });
    },
    onHlsInfo(info) {
      switchBoundary = info.playbackStartTime ?? currentTime;
    },
    onTimelineAnchor() {},
    onTsAudioTracks() {},
    onTsAudioSourceCodec(codec) {
      reportUnsupportedTsAudioCodec(codec);
      pendingOutput.audioMode = audioModeForTsCodec(codec);
      prepare();
    },
    onMediaInfo(info) {
      candidateMediaInfo = info;
      if (committed) {
        audioMediaInfo = info;
        emitMergedMediaInfo();
      }
    },
    onPCMAudioData(pcm, channels, sampleRate, time) {
      if (committed) {
        postPCMAudio(pcm, channels, sampleRate, time);
        return;
      }
      pendingOutput.pcm.push({ pcm, channels, sampleRate, time });
      pendingOutput.audioMode = "pcm";
      pendingOutput.mediaReady = true;
      prepare();
    },
  };

  candidate = new Pipeline([{ url, duration: 0 }], config, callbacks, {
    forcedTrack: "audio",
    silentTsAudioCodecs: [...unsupportedTsAudioCodecs],
    liveTimelineOffset: currentTime,
    startTime: currentTime,
    programDateTimeAnchor:
      timelineProgramDateTime === undefined ? undefined : timelineProgramDateTime + currentTime * 1000,
    liveEdgeDistance,
    mediaTimelineAnchor,
  });
  pendingAudioPipeline = candidate;
  candidate.start();
}

self.addEventListener("message", (e: MessageEvent) => {
  const cmd = e.data as WorkerCommand;
  switch (cmd.type) {
    case "init":
      gen = cmd.gen;
      config = cmd.config;
      unsupportedTsAudioCodecs = new Set(cmd.unsupportedTsAudioCodecs.map((codec) => codec.toLowerCase()));
      Log.setLogLevel(cmd.config.logLevel);
      load(cmd.segments, cmd.options);
      break;
    case "start":
      started = true;
      primaryPipeline?.start();
      break;
    case "load-segments":
      gen = cmd.gen;
      load(cmd.segments, cmd.options);
      break;
    case "select-audio-track":
      selectAudioTrack(cmd.trackId, cmd.currentTime);
      break;
    case "audio-track-switch-result":
      completePendingAudioSwitch?.(cmd.trackId, cmd.success, cmd.currentTime);
      break;
    case "pause":
      forEachPipeline((pipeline) => pipeline.pause());
      break;
    case "resume":
      forEachPipeline((pipeline) => pipeline.resume());
      break;
    case "reset":
      resetPipelines();
      started = false;
      break;
    case "destroy":
      resetPipelines();
      started = false;
      (self as unknown as { postMessage(msg: unknown): void }).postMessage({ type: "destroyed" });
      break;
  }
});

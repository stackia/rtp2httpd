import type { PlayerConfig } from "../config";
import { createDefaultConfig } from "../config";
import { WorkerAudioDecoder } from "../decoder/worker-audio-decoder";
import DemuxErrors from "../demux/demux-errors";
import TSDemuxer from "../demux/ts-demuxer";
import { containsMoov, getSegmentStartTime, parseInitSegment, probeFmp4, splitInitFromSegment } from "../hls/fmp4";
import { type HlsInfo, HlsSource } from "../hls/hls-source";
import FetchLoader, { LoaderErrors } from "../io/fetch-loader";
import MP4Remuxer from "../remux/mp4-remuxer";
import type { PlayerSegment } from "../types";
import Log from "../utils/logger";
import {
  ContinuousLiveSegmentSource,
  type SegmentMeta,
  type SegmentSource,
  StaticSegmentSource,
} from "./segment-source";

export interface PipelineCallbacks {
  onInitSegment: (
    type: string,
    initSegment: {
      type: string;
      container: string;
      codec?: string;
      data?: ArrayBuffer;
      [key: string]: unknown;
    },
  ) => void;
  onMediaSegment: (
    type: string,
    mediaSegment: {
      type: string;
      data?: ArrayBuffer;
      timestampOffset?: number;
      [key: string]: unknown;
    },
  ) => void;
  onLoadingComplete: () => void;
  onIOError: (type: string, info: { code: number; msg: string }) => void;
  onDemuxError: (type: string, info: string) => void;
  onHlsInfo: (info: HlsInfo) => void;
  /** `time` is normalized to the MSE timeline (seconds, same space as video.currentTime). */
  onPCMAudioData: (pcm: Float32Array, channels: number, sampleRate: number, time: number) => void;
}

class LoadError extends Error {
  constructor(
    public errorType: string,
    public info: { code: number; msg: string },
  ) {
    super(info.msg);
  }
}

const HLS_URL_RE = /\.m3u8?($|\?)/i;
/** Sentinel rejection value for intentionally cancelled segment loads. */
const CANCELLED = Symbol("cancelled");
type SourceMode = "continuous-live-ts" | "static-ts-list" | "hls";

/** Copy a Uint8Array view into a standalone (transferable) ArrayBuffer. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
    return view.buffer as ArrayBuffer;
  }
  return view.slice().buffer as ArrayBuffer;
}

class Pipeline {
  private readonly TAG = "Pipeline";

  private _config: PlayerConfig;
  private _callbacks: PipelineCallbacks;

  private _initialSegments: PlayerSegment[];

  /** Increments to invalidate the currently running load loop. */
  private _runId = 0;

  private _source: SegmentSource | null = null;
  private _hlsSource: HlsSource | null = null;
  private _sourceMode: SourceMode = "static-ts-list";

  private _demuxer: TSDemuxer | null = null;
  private _remuxer: MP4Remuxer | null = null;
  private _ioctl: FetchLoader | null = null;
  /** Settles the in-flight segment load promise (so a cancelled loop can exit). */
  private _cancelLoad: (() => void) | null = null;

  private _paused = false;
  private _resumeGate: (() => void) | null = null;
  /** dts offset (ms) to apply when the remuxer is next created (HLS discontinuity / seek). */
  private _pendingDtsOffsetMs = 0;

  // --- fMP4 passthrough state ---
  private _fmp4Mode = false;
  private _fmp4InitSent = false;
  private _fmp4Chunks: Uint8Array[] = [];
  private _lastInitUrl: string | null = null;
  private _fmp4Timescales = new Map<number, number>();
  private _fmp4TimestampOffsetWarningLogged = false;

  private _workerAudioDecoder: WorkerAudioDecoder | null = null;
  private _workerAudioDecoderInitPromise: Promise<boolean> | null = null;

  // --- MP2 software decode timing state ---
  /** PTS anchor (ms) for sample-count extrapolation across PES packets. */
  private _audioAnchorPtsMs: number | null = null;
  private _audioSamplesSinceAnchor = 0;
  private _audioSampleRate = 0;
  /** PCM decoded before the remuxer dts base is known (flushed once available). */
  private _pendingPcm: Array<{
    pcm: Float32Array;
    channels: number;
    sampleRate: number;
    ptsMs: number;
    durationMs: number;
  }> = [];
  /** Incremented on audio timing resets to invalidate decode callbacks queued before the reset. */
  private _audioGen = 0;

  constructor(segments: PlayerSegment[], config: PlayerConfig, callbacks: PipelineCallbacks) {
    this._callbacks = callbacks;
    this._config = { ...createDefaultConfig(), ...config };
    this._initialSegments = segments;
  }

  start(): void {
    this._load(this._initialSegments);
  }

  loadSegments(newSegments: PlayerSegment[]): void {
    this._load(newSegments);
  }

  pause(): void {
    this._paused = true;
    // Continuous live TS streams pause mid-fetch and resume with a fresh request.
    if (this._sourceMode === "continuous-live-ts") {
      this._ioctl?.pause();
    }
  }

  resume(): void {
    this._paused = false;
    if (this._sourceMode === "continuous-live-ts") {
      this._ioctl?.resume();
    }
    this._resumeGate?.();
    this._resumeGate = null;
  }

  destroy(): void {
    this._runId++;
    this._teardown();
    if (this._workerAudioDecoder) {
      this._workerAudioDecoder.destroy();
      this._workerAudioDecoder = null;
    }
    this._workerAudioDecoderInitPromise = null;
  }

  // ---- Private methods ----

  private _load(segments: PlayerSegment[]): void {
    this._runId++;
    this._teardown();

    // Reset WASM audio decoder state (clear stale mdct/qmf + carry from previous stream)
    this._workerAudioDecoder?.reset();
    this._resetAudioTiming();

    const firstSegment = segments[0];
    if (!firstSegment) return;
    const url = firstSegment.url;
    const isHls = segments.length === 1 && HLS_URL_RE.test(url);
    const isContinuousLiveTs = segments.length === 1 && !isHls && (firstSegment.duration ?? 0) === 0;

    this._sourceMode = isHls ? "hls" : isContinuousLiveTs ? "continuous-live-ts" : "static-ts-list";

    if (isHls) {
      // Fast path: known playlist URL, skip the content-type detection round-trip
      this._startHls(url);
    } else if (isContinuousLiveTs) {
      this._source = new ContinuousLiveSegmentSource(firstSegment);
      void this._run(this._runId);
    } else {
      this._source = new StaticSegmentSource(segments);
      void this._run(this._runId);
    }
  }

  private _startHls(url: string, preloaded?: { text: string; url: string }): void {
    this._sourceMode = "hls";
    const hls = new HlsSource(url, this._config, preloaded);
    hls.onInfo = (info) => this._callbacks.onHlsInfo(info);
    this._hlsSource = hls;
    this._source = hls;
    void this._run(this._runId);
  }

  /** Stop all loading and demux/remux state, keeping the worker reusable. */
  private _teardown(): void {
    this._abortCurrentLoad();
    this._source?.destroy();
    this._source = null;
    this._hlsSource = null;
    if (this._demuxer) {
      this._demuxer.destroy();
      this._demuxer = null;
    }
    if (this._remuxer) {
      this._remuxer.destroy();
      this._remuxer = null;
    }
    this._pendingDtsOffsetMs = 0;
    this._fmp4Mode = false;
    this._fmp4InitSent = false;
    this._fmp4Chunks = [];
    this._lastInitUrl = null;
    this._fmp4Timescales = new Map();
    this._fmp4TimestampOffsetWarningLogged = false;
    this._paused = false;
    this._sourceMode = "static-ts-list";
    this._resumeGate?.();
    this._resumeGate = null;
  }

  private _abortCurrentLoad(): void {
    if (this._ioctl) {
      this._ioctl.destroy();
      this._ioctl = null;
    }
    this._cancelLoad?.();
    this._cancelLoad = null;
  }

  /** Block until unpaused or this run is superseded (seek / reload). */
  private async _waitIfPaused(runId: number): Promise<boolean> {
    while (this._paused && this._runId === runId) {
      await new Promise<void>((resolve) => {
        this._resumeGate = resolve;
      });
    }
    return this._runId === runId;
  }

  // ---- Load loop ----

  private async _run(runId: number): Promise<void> {
    const source = this._source;
    if (!source) return;

    while (this._runId === runId) {
      if (!(await this._waitIfPaused(runId))) return;

      let meta: SegmentMeta | null;
      try {
        meta = await source.next();
      } catch (e) {
        if (this._runId === runId) {
          Log.e(this.TAG, `Segment source failed: ${(e as Error).message}`);
          this._callbacks.onIOError(LoaderErrors.EXCEPTION, { code: -1, msg: (e as Error).message });
        }
        return;
      }
      if (this._runId !== runId) return;

      if (!meta) {
        this._demuxer?.flushSegmentBoundary();
        this._remuxer?.flushStashedSamples();
        this._callbacks.onLoadingComplete();
        return;
      }

      try {
        if (meta.resetRemuxer) {
          this._resetTransmux(meta.start);
        }
        if (meta.initUrl && meta.initUrl !== this._lastInitUrl) {
          if (!(await this._waitIfPaused(runId))) return;
          await this._loadFmp4Init(meta.initUrl, runId);
          if (this._runId !== runId) return;
          this._lastInitUrl = meta.initUrl;
        }
        if (!(await this._waitIfPaused(runId))) return;
        await this._loadSegment(meta);
        if (this._runId !== runId) return;

        if (this._fmp4Mode) {
          this._flushFmp4Segment(meta);
        } else if (this._hlsSource) {
          // Keep each HLS TS input segment as a hard batching boundary. Codec
          // metadata remains reusable, but all complete media samples must be
          // emitted before loading the next playlist segment.
          this._demuxer?.flushSegmentBoundary();
          this._remuxer?.flushStashedSamples();
        } else {
          this._finishTsInputBoundary();
        }
      } catch (e) {
        if (this._runId !== runId || e === CANCELLED) return;
        if (e instanceof LoadError) {
          Log.e(this.TAG, `IOException: type = ${e.errorType}, code = ${e.info.code}, msg = ${e.info.msg}`);
          this._callbacks.onIOError(e.errorType, e.info);
        } else {
          Log.e(this.TAG, `Segment load failed: ${(e as Error).message}`);
          this._callbacks.onIOError(LoaderErrors.EXCEPTION, { code: -1, msg: (e as Error).message });
        }
        return;
      }
    }
  }

  /** Destroy demuxer + remuxer so the next segment re-anchors the output timeline at `startSeconds`. */
  private _resetTransmux(startSeconds: number): void {
    if (this._demuxer) {
      this._demuxer.destroy();
      this._demuxer = null;
    }
    if (this._remuxer) {
      this._remuxer.destroy();
      this._remuxer = null;
    }
    this._pendingDtsOffsetMs = startSeconds * 1000;
    // The output timeline restarts: stale carry bytes and the PTS anchor are invalid
    this._workerAudioDecoder?.reset();
    this._resetAudioTiming();
  }

  private _shouldAnchorSegment(meta: SegmentMeta): boolean {
    return meta.resetRemuxer || !this._hlsSource;
  }

  private _finishTsInputBoundary(): void {
    // Flush stashed samples at every TS segment boundary so the next segment's first
    // remux batch is not mixed with the previous segment's tail.
    this._demuxer?.flushSegmentBoundary();
    this._remuxer?.flushStashedSamples();
    this._workerAudioDecoder?.reset();
    this._resetAudioTiming();
  }

  private _prepareContinuousLiveTsRestart(meta: SegmentMeta, ioctl: FetchLoader): void {
    if (this._sourceMode !== "continuous-live-ts") {
      return;
    }

    this._finishTsInputBoundary();
    this._fmp4Mode = false;
    this._fmp4Chunks = [];
    ioctl.onDataArrival = (data, byteStart) => this._onProbeChunk(meta, data, byteStart);
  }

  private _resetAudioTiming(): void {
    this._audioGen++;
    this._audioAnchorPtsMs = null;
    this._audioSamplesSinceAnchor = 0;
    this._audioSampleRate = 0;
    this._pendingPcm = [];
  }

  private _loadSegment(meta: SegmentMeta): Promise<void> {
    const ioctl = new FetchLoader(
      {
        url: meta.url,
        cors: true,
        withCredentials: false,
        referrerPolicy: this._config.referrerPolicy as ReferrerPolicy | undefined,
      },
      this._config,
      undefined,
      { resumeMode: this._sourceMode === "continuous-live-ts" ? "restart" : "range" },
    );
    this._ioctl = ioctl;

    return new Promise<void>((resolve, reject) => {
      this._cancelLoad = () => reject(CANCELLED);

      ioctl.onError = (type, info) => reject(new LoadError(type, info));
      ioctl.onSeeked = () => this._remuxer?.insertDiscontinuity();
      ioctl.onRestarted = () => this._prepareContinuousLiveTsRestart(meta, ioctl);
      ioctl.onComplete = () => resolve();
      ioctl.onHLSDetected = (text, url) => {
        // Playlist served from a non-.m3u8 URL: switch the pipeline to the HLS source,
        // reusing the playlist content we already downloaded
        this._runId++;
        reject(CANCELLED);
        this._startHls(meta.url, { text, url });
      };
      ioctl.onDataArrival = (data, byteStart) => this._onProbeChunk(meta, data, byteStart);
      ioctl.open();
    }).finally(() => {
      ioctl.destroy();
      if (this._ioctl === ioctl) {
        this._ioctl = null;
        this._cancelLoad = null;
      }
    });
  }

  /** First-chunk handler: probe the container format, then hand off to the right path. */
  private _onProbeChunk(meta: SegmentMeta, data: Uint8Array, byteStart: number): number {
    if (this._fmp4Mode) {
      return this._onFmp4Chunk(data);
    }

    const probeData = TSDemuxer.probe(data);
    if (probeData.match) {
      this._setupTSDemuxerRemuxer(probeData, meta);
      if (this._ioctl && this._demuxer) {
        this._ioctl.onDataArrival = this._demuxer.parseChunks.bind(this._demuxer);
      }
      return this._demuxer?.parseChunks(data, byteStart) ?? 0;
    }

    if (probeFmp4(data)) {
      this._fmp4Mode = true;
      if (this._ioctl) {
        this._ioctl.onDataArrival = (chunk) => this._onFmp4Chunk(chunk);
      }
      return this._onFmp4Chunk(data);
    }

    if (!probeData.needMoreData) {
      Log.e(this.TAG, "Unsupported media type (neither MPEG-TS nor fMP4)");
      Promise.resolve().then(() => this._abortCurrentLoad());
      this._callbacks.onDemuxError(DemuxErrors.FORMAT_UNSUPPORTED, "Unsupported media type!");
    }
    return 0;
  }

  // ---- MPEG-TS path ----

  private _setupTSDemuxerRemuxer(probeData: unknown, meta: SegmentMeta): void {
    const shouldAnchor = this._shouldAnchorSegment(meta);
    const canReuseHls = this._hlsSource !== null && !shouldAnchor && this._demuxer !== null && this._remuxer !== null;
    const canReuseTsInputBoundary = this._sourceMode !== "hls" && this._demuxer !== null && this._remuxer !== null;
    const canReuse = canReuseHls || canReuseTsInputBoundary;
    if (canReuse) {
      this._demuxer?.resetSegmentBoundary(probeData as ConstructorParameters<typeof TSDemuxer>[0], {
        resetAudioParserState: canReuseTsInputBoundary,
      });
      this._remuxer?.setTsSegmentContinuityNormalization(canReuseTsInputBoundary);
      return;
    }

    if (this._demuxer) {
      this._demuxer.destroy();
    }
    const demuxer = new TSDemuxer(probeData as ConstructorParameters<typeof TSDemuxer>[0], {
      waitForInitialVideoKeyframe: shouldAnchor || !this._demuxer || !this._remuxer,
    });
    this._demuxer = demuxer;

    if (!this._remuxer) {
      this._remuxer = new MP4Remuxer();
      if (this._pendingDtsOffsetMs !== 0) {
        this._remuxer.setDtsBaseOffset(this._pendingDtsOffsetMs);
        this._pendingDtsOffsetMs = 0;
      }
    }
    this._remuxer.setTsSegmentContinuityNormalization(false);

    demuxer.onError = this._onDemuxException.bind(this);
    demuxer.timestampBase = 0;
    demuxer.onTrackDiscontinuity = (track) => {
      if (track === "video") {
        this._remuxer?.flushStashedSamples();
        this._remuxer?.insertDiscontinuity();
      }
      this._workerAudioDecoder?.reset();
      this._resetAudioTiming();
    };

    // Set up software audio decode callback when MP2 WASM URL is configured
    if (this._config.wasmDecoders.mp2) {
      demuxer.onRawAudioData = (frame) => {
        this._handleRawAudioFrame(frame);
      };
    }

    this._remuxer.bindDataSource(
      demuxer as unknown as {
        onDataAvailable: (...args: unknown[]) => void;
        onTrackMetadata: (...args: unknown[]) => void;
      },
    );

    this._remuxer.onInitSegment = (type, initSegment) => {
      this._callbacks.onInitSegment(type, initSegment as unknown as Parameters<PipelineCallbacks["onInitSegment"]>[1]);
    };
    this._remuxer.onMediaSegment = (type, mediaSegment) => {
      this._callbacks.onMediaSegment(
        type,
        mediaSegment as unknown as Parameters<PipelineCallbacks["onMediaSegment"]>[1],
      );
    };
  }

  private _onDemuxException(type: string, info: string): void {
    Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
    this._callbacks.onDemuxError(type, info);
  }

  // ---- fMP4 passthrough path ----

  private async _loadFmp4Init(initUrl: string, runId: number): Promise<void> {
    this._fmp4Mode = true;
    const response = await fetch(initUrl, {
      headers: this._config.headers,
      referrerPolicy: (this._config.referrerPolicy as ReferrerPolicy | undefined) ?? "no-referrer-when-downgrade",
    });
    if (this._runId !== runId) return;
    if (!response.ok) {
      throw new LoadError(LoaderErrors.HTTP_STATUS_CODE_INVALID, { code: response.status, msg: response.statusText });
    }
    const data = new Uint8Array(await response.arrayBuffer());
    // Superseded mid-fetch (seek/reload/destroy): don't append a stale init segment
    if (this._runId !== runId) return;
    this._sendFmp4Init(data);
  }

  private _sendFmp4Init(data: Uint8Array): void {
    const initInfo = parseInitSegment(data);
    this._fmp4Timescales = initInfo.timescales;
    this._fmp4TimestampOffsetWarningLogged = false;
    const codec = this._hlsSource?.info.codecs ?? initInfo.codecs.join(",");
    this._callbacks.onInitSegment("video", {
      type: "video",
      container: "video/mp4",
      codec,
      data: toArrayBuffer(data),
    });
    this._fmp4InitSent = true;
  }

  private _warnFmp4TimestampOffsetUnavailable(reason: string): void {
    if (this._fmp4TimestampOffsetWarningLogged) {
      return;
    }
    this._fmp4TimestampOffsetWarningLogged = true;
    Log.w(this.TAG, `fMP4 timestampOffset unavailable: ${reason}; appending media with original tfdt`);
  }

  private _getFmp4TimestampOffset(meta: SegmentMeta, media: Uint8Array): number | undefined {
    if (this._fmp4Timescales.size === 0) {
      this._warnFmp4TimestampOffsetUnavailable("init segment timescales missing");
      return undefined;
    }

    const segmentStart = getSegmentStartTime(media, this._fmp4Timescales);
    if (segmentStart === null) {
      this._warnFmp4TimestampOffsetUnavailable("media segment has no tfdt");
      return undefined;
    }

    const timestampOffset = (meta.start - segmentStart) * 1000;
    return Math.abs(timestampOffset) < 0.001 ? 0 : timestampOffset;
  }

  private _onFmp4Chunk(data: Uint8Array): number {
    this._fmp4Chunks.push(data);
    return data.byteLength;
  }

  /** Forward a fully buffered fMP4 segment to MSE (extracting the init part on first use). */
  private _flushFmp4Segment(meta: SegmentMeta): void {
    if (this._fmp4Chunks.length === 0) {
      return;
    }
    const total = this._fmp4Chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const segment = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this._fmp4Chunks) {
      segment.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this._fmp4Chunks = [];

    let media: Uint8Array = segment;
    if (!this._fmp4InitSent) {
      if (!containsMoov(segment)) {
        this._callbacks.onDemuxError(DemuxErrors.FORMAT_ERROR, "fMP4 stream has no initialization segment (moov)");
        return;
      }
      const parts = splitInitFromSegment(segment);
      this._sendFmp4Init(parts.init);
      media = parts.media;
    }

    if (media.byteLength > 0) {
      this._pendingDtsOffsetMs = 0;
      this._callbacks.onMediaSegment("video", {
        type: "video",
        data: toArrayBuffer(media),
        timestampOffset: this._getFmp4TimestampOffset(meta, media),
      });
    }
  }

  // ---- MP2 software audio decode ----

  private _handleRawAudioFrame(frame: { codec: "mp2"; data: Uint8Array; pts: number }): void {
    // Lazily create WorkerAudioDecoder on first raw audio frame
    if (!this._workerAudioDecoder) {
      const mp2Url = this._config.wasmDecoders.mp2;
      if (!mp2Url) return;
      this._workerAudioDecoder = new WorkerAudioDecoder(mp2Url);
      this._workerAudioDecoderInitPromise = this._workerAudioDecoder.initDecoder();
    }

    // Queue decode after init completes; gen guard drops frames queued before a reset
    const gen = this._audioGen;
    this._workerAudioDecoderInitPromise?.then((ready) => {
      if (!ready || !this._workerAudioDecoder || gen !== this._audioGen) return;

      const result = this._workerAudioDecoder.decode(frame.data);
      if (!result) return;

      // PTS extrapolation: anchor on the PES PTS, advance by decoded sample count.
      // This gives every decoded chunk a jitter-free timestamp even when frames
      // straddle PES boundaries or a PES contains multiple frames. Re-anchor only
      // on genuine discontinuities (> 100ms deviation).
      const sr = result.sampleRate;
      const carriedSamples = Math.min(Math.max(0, result.samplesBeforeInput), result.samplesPerChannel);
      const decodedStartPts = frame.pts - (carriedSamples / sr) * 1000;
      if (this._audioAnchorPtsMs === null || this._audioSampleRate !== sr) {
        this._audioAnchorPtsMs = decodedStartPts;
        this._audioSamplesSinceAnchor = 0;
        this._audioSampleRate = sr;
      } else {
        const extrapolatedMs = this._audioAnchorPtsMs + (this._audioSamplesSinceAnchor / sr) * 1000;
        if (Math.abs(decodedStartPts - extrapolatedMs) > 100) {
          Log.v(
            this.TAG,
            `Audio PTS discontinuity: decoded=${decodedStartPts.toFixed(1)}ms extrap=${extrapolatedMs.toFixed(1)}ms`,
          );
          this._audioAnchorPtsMs = decodedStartPts;
          this._audioSamplesSinceAnchor = 0;
        }
      }
      const ptsMs = this._audioAnchorPtsMs + (this._audioSamplesSinceAnchor / sr) * 1000;
      this._audioSamplesSinceAnchor += result.samplesPerChannel;

      this._emitPcm(result.pcm, result.channels, sr, ptsMs);
    });
  }

  /**
   * Normalize PCM timestamps to the MSE timeline using the remuxer's dts base
   * (the exact mapping used for video), then forward to the main thread.
   * PCM decoded before the first remux (dts base unknown) is queued.
   */
  private _emitPcm(pcm: Float32Array, channels: number, sampleRate: number, ptsMs: number): void {
    const durationMs = (Math.floor(pcm.length / channels) / sampleRate) * 1000;
    this._pendingPcm.push({ pcm, channels, sampleRate, ptsMs, durationMs });

    if (this._remuxer?.getTimestampBase() === undefined) {
      // Bound the queue: ~25s of audio at one payload per ~72ms is plenty
      if (this._pendingPcm.length > 512) {
        this._pendingPcm.shift();
      }
      return;
    }

    const pending = this._pendingPcm;
    this._pendingPcm = [];

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      const mapping = this._remuxer?.mapPcmTimestamp(item.ptsMs, item.durationMs);
      if (mapping === undefined) {
        this._pendingPcm.push(...pending.slice(i));
        if (this._pendingPcm.length > 512) {
          this._pendingPcm.splice(0, this._pendingPcm.length - 512);
        }
        break;
      }
      if (mapping.action === "drop") {
        continue;
      }

      let pcm = item.pcm;
      if (mapping.trimStartMs > 0) {
        const cutFrames = Math.round((mapping.trimStartMs / 1000) * item.sampleRate);
        const totalFrames = Math.floor(pcm.length / item.channels);
        if (cutFrames >= totalFrames) {
          continue;
        }
        if (cutFrames > 0) {
          pcm = pcm.slice(cutFrames * item.channels);
        }
      }
      this._callbacks.onPCMAudioData(pcm, item.channels, item.sampleRate, mapping.time);
    }
  }
}

export default Pipeline;

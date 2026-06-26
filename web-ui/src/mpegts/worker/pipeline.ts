import type { PlayerConfig } from "../config";
import { createDefaultConfig } from "../config";
import type { EncodedAudioFrame, ProcessedAudioChunk } from "../decoder/software-audio-processor";
import { WorkerSoftwareAudioProcessor } from "../decoder/worker-software-audio-processor";
import DemuxErrors from "../demux/demux-errors";
import TSDemuxer from "../demux/ts-demuxer";
import { containsMoov, parseInitSegment, probeFmp4, splitInitFromSegment } from "../hls/fmp4";
import { type HlsInfo, HlsSource } from "../hls/hls-source";
import FetchLoader, { LoaderErrors } from "../io/fetch-loader";
import MP4Remuxer from "../remux/mp4-remuxer";
import type { PlayerSegment } from "../types";
import Log from "../utils/logger";
import { type SegmentMeta, type SegmentSource, StaticSegmentSource } from "./segment-source";

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
  /** `streamStart`/`streamEnd` are normalized to the MSE timeline (seconds). */
  onPCMAudioData: (
    planes: Float32Array[],
    channels: number,
    sampleRate: number,
    frames: number,
    streamStart: number,
    streamEnd: number,
  ) => void;
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

  private _demuxer: TSDemuxer | null = null;
  private _remuxer: MP4Remuxer | null = null;
  private _ioctl: FetchLoader | null = null;
  /** Settles the in-flight segment load promise (so a cancelled loop can exit). */
  private _cancelLoad: (() => void) | null = null;

  private _paused = false;
  private _resumeGate: (() => void) | null = null;
  /**
   * Discrete segment sources (HLS, catchup lists) load one short URL per iteration.
   * For these, pause only gates between segments — never abort an in-flight fetch
   * (which shows up as immediate cancel/retry on later segments).
   */
  private _discreteSegments = false;

  /** dts offset (ms) to apply when the remuxer is next created (HLS discontinuity / seek). */
  private _pendingDtsOffsetMs = 0;

  // --- fMP4 passthrough state ---
  private _fmp4Mode = false;
  private _fmp4InitSent = false;
  private _fmp4Chunks: Uint8Array[] = [];
  private _lastInitUrl: string | null = null;

  private _workerAudioProcessor: WorkerSoftwareAudioProcessor | null = null;

  /** Processed PCM before the remuxer dts base is known (flushed once available). */
  private _pendingPcm: Array<ProcessedAudioChunk> = [];
  /** Incremented on audio timing resets to invalidate decode callbacks queued before the reset. */
  private _audioGen = 0;
  private _audioStretchRatio = 1;
  private _audioProcessChain: Promise<void> = Promise.resolve();

  constructor(segments: PlayerSegment[], config: PlayerConfig, callbacks: PipelineCallbacks) {
    this._callbacks = callbacks;
    this._config = { ...createDefaultConfig(), ...config };
    this._config.wasmAudioProcessors = {
      ...this._config.wasmDecoders,
      ...this._config.wasmAudioProcessors,
    };
    this._config.wasmDecoders = this._config.wasmAudioProcessors;
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
    // Continuous single-URL TS streams can pause mid-fetch and resume via Range.
    if (!this._discreteSegments) {
      this._ioctl?.pause();
    }
  }

  resume(): void {
    this._paused = false;
    if (!this._discreteSegments) {
      this._ioctl?.resume();
    }
    this._resumeGate?.();
    this._resumeGate = null;
  }

  setAudioStretchRatio(ratio: number): void {
    this._audioStretchRatio = Math.min(2, Math.max(0.5, ratio));
    this._workerAudioProcessor?.setStretchRatio(this._audioStretchRatio);
  }

  destroy(): void {
    this._runId++;
    this._teardown();
    this._resetAudioTiming();
    if (this._workerAudioProcessor) {
      this._workerAudioProcessor.destroy();
      this._workerAudioProcessor = null;
    }
  }

  // ---- Private methods ----

  private _load(segments: PlayerSegment[]): void {
    this._runId++;
    this._teardown();

    // Reset WASM audio processor state (clear stale decoder/WSOLA/carry from previous stream)
    this.setAudioStretchRatio(1);
    this._workerAudioProcessor?.reset();
    this._resetAudioTiming();

    const url = segments[0]?.url ?? "";
    this._discreteSegments = segments.length > 1 || HLS_URL_RE.test(url);
    if (segments.length === 1 && HLS_URL_RE.test(url)) {
      // Fast path: known playlist URL, skip the content-type detection round-trip
      this._startHls(url);
    } else {
      this._source = new StaticSegmentSource(segments);
      void this._run(this._runId);
    }
  }

  private _startHls(url: string, preloaded?: { text: string; url: string }): void {
    this._discreteSegments = true;
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
    this._paused = false;
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
          this._flushFmp4Segment();
        }
        // Flush stashed samples at every segment boundary so the next segment's first
        // remux batch is not mixed with the previous segment's tail (which would share
        // one dtsCorrection and preserve upstream HLS timestamp gaps in MSE).
        this._remuxer?.flushStashedSamples();
        if (!this._hlsSource) {
          // Each static segment is an independent TS timeline: a partial MP2
          // frame carried from the previous URL must not be prepended to the
          // next one, and the PTS anchor must re-establish from the new PES
          this._workerAudioProcessor?.reset();
          this._resetAudioTiming();
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
    this._workerAudioProcessor?.reset();
    this._resetAudioTiming();
  }

  private _resetAudioTiming(): void {
    this._audioGen++;
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
    );
    this._ioctl = ioctl;

    return new Promise<void>((resolve, reject) => {
      this._cancelLoad = () => reject(CANCELLED);

      ioctl.onError = (type, info) => reject(new LoadError(type, info));
      ioctl.onSeeked = () => this._remuxer?.insertDiscontinuity();
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
  private _onProbeChunk(meta: SegmentMeta, data: ArrayBuffer, byteStart: number): number {
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
    if (this._demuxer) {
      this._demuxer.destroy();
    }
    const demuxer = new TSDemuxer(probeData as ConstructorParameters<typeof TSDemuxer>[0]);
    this._demuxer = demuxer;

    if (!this._remuxer) {
      this._remuxer = new MP4Remuxer(this._config);
      if (this._pendingDtsOffsetMs !== 0) {
        this._remuxer.setDtsBaseOffset(this._pendingDtsOffsetMs);
        this._pendingDtsOffsetMs = 0;
      }
    }

    demuxer.onError = this._onDemuxException.bind(this);
    demuxer.timestampBase = meta.timestampBase * 90000; // seconds → 90kHz ticks

    // Set up software audio processing callback when a matching WASM URL is configured
    if (this._config.wasmAudioProcessors.mp2) {
      demuxer.onEncodedAudioData = (frame) => {
        this._handleEncodedAudioFrame(frame);
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
    const codec = this._hlsSource?.info.codecs ?? parseInitSegment(data).codecs.join(",");
    this._callbacks.onInitSegment("video", {
      type: "video",
      container: "video/mp4",
      codec,
      data: toArrayBuffer(data),
    });
    this._fmp4InitSent = true;
  }

  private _onFmp4Chunk(data: ArrayBuffer): number {
    this._fmp4Chunks.push(new Uint8Array(data));
    return data.byteLength;
  }

  /** Forward a fully buffered fMP4 segment to MSE (extracting the init part on first use). */
  private _flushFmp4Segment(): void {
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
      this._callbacks.onMediaSegment("video", { type: "video", data: toArrayBuffer(media) });
    }
  }

  // ---- Software audio processing ----

  private _handleEncodedAudioFrame(frame: EncodedAudioFrame): void {
    if (!this._workerAudioProcessor) {
      this._workerAudioProcessor = new WorkerSoftwareAudioProcessor(this._config.wasmAudioProcessors);
      this._workerAudioProcessor.setStretchRatio(this._audioStretchRatio);
    }

    // The WASM processor is stateful (decoder carry, WSOLA tail, timeline cursor).
    // Serialize frames explicitly so lazy init and promise scheduling cannot reorder
    // processed PCM chunks.
    const gen = this._audioGen;
    const processor = this._workerAudioProcessor;
    this._audioProcessChain = this._audioProcessChain
      .then(async () => {
        if (gen !== this._audioGen) return;
        const audioProcessor = await processor.getProcessor(frame.codec);
        if (!audioProcessor || gen !== this._audioGen) return;
        const result = audioProcessor.process(frame);
        if (!result || gen !== this._audioGen) return;
        this._emitProcessedAudio(result);
      })
      .catch((err) => {
        if (gen === this._audioGen) {
          Log.e(this.TAG, `Software audio processing failed: ${(err as Error).message}`);
        }
      });
  }

  /**
   * Normalize PCM timestamps to the MSE timeline using the remuxer's dts base
   * (the exact mapping used for video), then forward to the main thread.
   * PCM processed before the first remux (dts base unknown) is queued.
   */
  private _emitProcessedAudio(chunk: ProcessedAudioChunk): void {
    this._pendingPcm.push(chunk);

    const dtsBase = this._remuxer?.getTimestampBase();
    if (dtsBase === undefined) {
      // Bound the queue: ~25s of audio at one payload per ~72ms is plenty
      if (this._pendingPcm.length > 512) {
        this._pendingPcm.shift();
      }
      return;
    }

    for (const item of this._pendingPcm) {
      this._callbacks.onPCMAudioData(
        item.planes,
        item.channels,
        item.sampleRate,
        item.frames,
        (item.streamStartMs - dtsBase) / 1000,
        (item.streamEndMs - dtsBase) / 1000,
      );
    }
    this._pendingPcm = [];
  }
}

export default Pipeline;

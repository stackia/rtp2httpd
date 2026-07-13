import type { PlayerConfig } from "../config";
import { createDefaultConfig } from "../config";
import { WorkerAudioDecoder } from "../decoder/worker-audio-decoder";
import TSDemuxer from "../demux/ts-demuxer";
import { type DemuxErrorDetail, type LoaderErrorDetail, PlayerErrors } from "../errors";
import {
  containsMoov,
  getSegmentStartTime,
  type InitSegmentTrackInfo,
  parseInitSegment,
  probeFmp4,
  splitInitFromSegment,
} from "../hls/fmp4";
import { type HlsInfo, HlsRequestError, HlsSource } from "../hls/hls-source";
import FetchLoader, { type LoaderErrorInfo } from "../io/fetch-loader";
import { identifyAudioCodec, identifyVideoCodec } from "../media-codecs";
import MP4Remuxer from "../remux/mp4-remuxer";
import type { PlayerDynamicRange, PlayerMediaInfo, PlayerSegment } from "../types";
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
  onIOError: (type: LoaderErrorDetail, info: LoaderErrorInfo) => void;
  onDemuxError: (type: DemuxErrorDetail, info: string) => void;
  onHlsInfo: (info: HlsInfo) => void;
  onMediaInfo: (info: PlayerMediaInfo) => void;
  /** `time` is normalized to the MSE timeline (seconds, same space as video.currentTime). */
  onPCMAudioData: (pcm: Float32Array, channels: number, sampleRate: number, time: number) => void;
}

class LoadError extends Error {
  constructor(
    public errorType: LoaderErrorDetail,
    public info: LoaderErrorInfo,
  ) {
    super(info.msg);
  }
}

const HLS_URL_RE = /\.m3u8?($|\?)/i;
/** Sentinel rejection value for intentionally cancelled segment loads. */
const CANCELLED = Symbol("cancelled");
type SourceMode = "continuous-live-ts" | "static-ts-list" | "hls";
const PCR_TIMESCALE = 90000;
const BITRATE_MEDIA_WINDOW_MS = 5000;
const BITRATE_STABLE_AFTER_MS = 500;
const BITRATE_UPDATE_INTERVAL_MS = 1000;
const BITRATE_MINIMUM_SAMPLES = 2;
const SEGMENT_BITRATE_SAMPLE_COUNT = 5;

type MediaInfoVideo = NonNullable<PlayerMediaInfo["video"]>;
type MediaInfoAudio = NonNullable<PlayerMediaInfo["audio"]>;

function mergeDefinedProperties<T extends object>(current: T | undefined, update: T): T {
  const merged = { ...(current ?? {}) } as Record<string, unknown>;
  for (const [property, value] of Object.entries(update)) {
    if (value !== undefined) {
      merged[property] = value;
    }
  }
  return merged as T;
}

function dynamicRangeFromTransfer(transferCharacteristics: unknown): PlayerDynamicRange | undefined {
  if (transferCharacteristics === 16) return "hdr10";
  if (transferCharacteristics === 18) return "hlg";
  if ([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17].includes(transferCharacteristics as number)) {
    return "sdr";
  }
  return undefined;
}

function dynamicRangeFromHlsVideoRange(videoRange: string | undefined): PlayerDynamicRange | undefined {
  switch (videoRange?.toUpperCase()) {
    case "PQ":
      return "hdr10";
    case "HLG":
      return "hlg";
    case "SDR":
      return "sdr";
    default:
      return undefined;
  }
}

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

  // --- player-facing media metadata ---
  private _mediaInfo: PlayerMediaInfo = {};
  private _serializedMediaInfo = "{}";
  private _hasActualVideoInfo = false;
  private _hasActualAudioInfo = false;
  private _advertisedBitrate: number | undefined;
  private _lastHlsInfo: HlsInfo | undefined;
  private _tsBitrateSamples: Array<{ pcrBase: number; bytePosition: number }> = [];
  private _segmentBitrateSamples: number[] = [];
  private _currentSegmentBytes = 0;
  private _lastBitrateUpdatePcr = 0;
  private _measuredBitrateStable = false;

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

  private _publishMediaInfo(nextMediaInfo: PlayerMediaInfo): void {
    const serialized = JSON.stringify(nextMediaInfo);
    if (serialized === this._serializedMediaInfo) return;

    this._mediaInfo = nextMediaInfo;
    this._serializedMediaInfo = serialized;
    this._callbacks.onMediaInfo({
      ...nextMediaInfo,
      video: nextMediaInfo.video ? { ...nextMediaInfo.video } : undefined,
      audio: nextMediaInfo.audio ? { ...nextMediaInfo.audio } : undefined,
      bitrate: nextMediaInfo.bitrate ? { ...nextMediaInfo.bitrate } : undefined,
    });
  }

  private _mergeMediaInfo(update: PlayerMediaInfo): void {
    this._publishMediaInfo({
      ...this._mediaInfo,
      video: update.video
        ? mergeDefinedProperties(this._mediaInfo.video, update.video as MediaInfoVideo)
        : this._mediaInfo.video,
      audio: update.audio
        ? mergeDefinedProperties(this._mediaInfo.audio, update.audio as MediaInfoAudio)
        : this._mediaInfo.audio,
      bitrate: update.bitrate ?? this._mediaInfo.bitrate,
    });
  }

  private _replaceBitrate(bitrate: PlayerMediaInfo["bitrate"]): void {
    const nextMediaInfo = { ...this._mediaInfo };
    if (bitrate) {
      nextMediaInfo.bitrate = bitrate;
    } else {
      delete nextMediaInfo.bitrate;
    }
    this._publishMediaInfo(nextMediaInfo);
  }

  private _resetMediaInfo(): void {
    this._mediaInfo = {};
    this._serializedMediaInfo = "{}";
    this._hasActualVideoInfo = false;
    this._hasActualAudioInfo = false;
    this._advertisedBitrate = undefined;
    this._lastHlsInfo = undefined;
    this._tsBitrateSamples = [];
    this._segmentBitrateSamples = [];
    this._currentSegmentBytes = 0;
    this._lastBitrateUpdatePcr = 0;
    this._measuredBitrateStable = false;
    // A new generation must clear the previous stream's badges immediately.
    this._callbacks.onMediaInfo({});
  }

  private _resetBitrateMeasurement(): void {
    this._tsBitrateSamples = [];
    this._segmentBitrateSamples = [];
    this._currentSegmentBytes = 0;
    this._lastBitrateUpdatePcr = 0;
    this._measuredBitrateStable = false;
    this._replaceBitrate(
      this._advertisedBitrate ? { bitsPerSecond: this._advertisedBitrate, source: "advertised" } : undefined,
    );
  }

  private _resetPeriodMediaInfo(): void {
    this._hasActualVideoInfo = false;
    this._hasActualAudioInfo = false;
    this._publishMediaInfo(this._mediaInfo.bitrate ? { bitrate: { ...this._mediaInfo.bitrate } } : {});
    if (this._lastHlsInfo) {
      this._applyHlsInfo(this._lastHlsInfo);
    }
  }

  private _recordInputBytes(bytes: number): void {
    if (bytes <= 0) return;

    // Segmented fMP4 has no PCR, so retain the complete-segment fallback.
    if (this._sourceMode !== "continuous-live-ts") {
      this._currentSegmentBytes += bytes;
    }
  }

  private _recordTsPcr(pcrBase: number, bytePosition: number, discontinuity: boolean): void {
    if (this._sourceMode === "hls" || !Number.isFinite(pcrBase) || !Number.isFinite(bytePosition)) return;

    const previousSample = this._tsBitrateSamples.at(-1);
    if (
      discontinuity ||
      (previousSample !== undefined &&
        (pcrBase <= previousSample.pcrBase || bytePosition <= previousSample.bytePosition))
    ) {
      this._tsBitrateSamples = [];
      this._lastBitrateUpdatePcr = 0;
    }

    this._tsBitrateSamples.push({ pcrBase, bytePosition });
    const windowStart = pcrBase - (BITRATE_MEDIA_WINDOW_MS * PCR_TIMESCALE) / 1000;
    while (this._tsBitrateSamples.length > 1 && this._tsBitrateSamples[1].pcrBase <= windowStart) {
      this._tsBitrateSamples.shift();
    }

    const firstSample = this._tsBitrateSamples[0];
    const lastSample = this._tsBitrateSamples.at(-1);
    if (!firstSample || !lastSample) return;
    const elapsedPcr = lastSample.pcrBase - firstSample.pcrBase;
    const elapsedMediaMilliseconds = (elapsedPcr * 1000) / PCR_TIMESCALE;
    const estimateStable =
      elapsedMediaMilliseconds >= BITRATE_STABLE_AFTER_MS && this._tsBitrateSamples.length >= BITRATE_MINIMUM_SAMPLES;
    const updateTooSoon =
      this._lastBitrateUpdatePcr > 0 &&
      ((pcrBase - this._lastBitrateUpdatePcr) * 1000) / PCR_TIMESCALE < BITRATE_UPDATE_INTERVAL_MS;
    if (!estimateStable || updateTooSoon) return;

    const totalBytes = lastSample.bytePosition - firstSample.bytePosition;
    // PCR advances with the media timeline, so server-side delivery bursts do
    // not inflate this transport-stream bitrate as wall-clock sampling would.
    const bitsPerSecond = Math.round((totalBytes * 8 * PCR_TIMESCALE) / elapsedPcr / 1000) * 1000;
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return;

    this._lastBitrateUpdatePcr = pcrBase;
    this._measuredBitrateStable = true;
    this._replaceBitrate({ bitsPerSecond, source: "measured" });
  }

  private _publishSegmentBitrate(durationSeconds: number): void {
    if (durationSeconds <= 0 || this._currentSegmentBytes <= 0) return;

    const sampleBitsPerSecond = (this._currentSegmentBytes * 8) / durationSeconds;
    if (!Number.isFinite(sampleBitsPerSecond) || sampleBitsPerSecond <= 0) return;

    this._segmentBitrateSamples.push(sampleBitsPerSecond);
    if (this._segmentBitrateSamples.length > SEGMENT_BITRATE_SAMPLE_COUNT) {
      this._segmentBitrateSamples.shift();
    }
    const averageBitsPerSecond =
      this._segmentBitrateSamples.reduce((sum, bitsPerSecond) => sum + bitsPerSecond, 0) /
      this._segmentBitrateSamples.length;
    const roundedBitsPerSecond = Math.round(averageBitsPerSecond / 1000) * 1000;
    if (!Number.isFinite(roundedBitsPerSecond) || roundedBitsPerSecond <= 0) return;

    this._measuredBitrateStable = true;
    this._replaceBitrate({ bitsPerSecond: roundedBitsPerSecond, source: "measured" });
  }

  private _handleHlsInfo(info: HlsInfo): void {
    this._lastHlsInfo = info;
    this._applyHlsInfo(info);
  }

  private _applyHlsInfo(info: HlsInfo): void {
    const codecHints =
      info.codecs
        ?.split(",")
        .map((codec) => codec.trim())
        .filter(Boolean) ?? [];
    const videoCodec = codecHints.find((codec) => identifyVideoCodec(codec) !== undefined);
    const audioCodec = codecHints.find((codec) => identifyAudioCodec(codec) !== undefined);

    const update: PlayerMediaInfo = {};
    if (!this._hasActualVideoInfo) {
      const videoHints: MediaInfoVideo = {
        codec: videoCodec,
        width: info.resolution?.width,
        height: info.resolution?.height,
        frameRate: info.frameRate,
        dynamicRange: dynamicRangeFromHlsVideoRange(info.videoRange),
      };
      if (Object.values(videoHints).some((value) => value !== undefined)) {
        update.video = videoHints;
      }
    }
    if (!this._hasActualAudioInfo && audioCodec) {
      update.audio = { codec: audioCodec };
    }

    const advertisedBitrate = info.averageBandwidth ?? info.bandwidth;
    if (advertisedBitrate && advertisedBitrate > 0) {
      this._advertisedBitrate = advertisedBitrate;
      if (!this._measuredBitrateStable) {
        update.bitrate = { bitsPerSecond: advertisedBitrate, source: "advertised" };
      }
    }
    this._mergeMediaInfo(update);
  }

  private _handleTsTrackMetadata(type: string, metadata: unknown): void {
    if (!metadata || typeof metadata !== "object") return;
    const trackMetadata = metadata as Record<string, unknown>;

    if (type === "video") {
      const frameRateMetadata = trackMetadata.frameRate;
      const frameRate =
        frameRateMetadata && typeof frameRateMetadata === "object"
          ? (frameRateMetadata as Record<string, unknown>).fps
          : frameRateMetadata;
      this._hasActualVideoInfo = true;
      this._mergeMediaInfo({
        video: {
          codec: typeof trackMetadata.codec === "string" ? trackMetadata.codec : undefined,
          width: typeof trackMetadata.presentWidth === "number" ? trackMetadata.presentWidth : undefined,
          height: typeof trackMetadata.presentHeight === "number" ? trackMetadata.presentHeight : undefined,
          scanType: trackMetadata.mayBeInterlaced === false ? "progressive" : undefined,
          frameRate: typeof frameRate === "number" && frameRate > 0 ? frameRate : undefined,
          dynamicRange: dynamicRangeFromTransfer(trackMetadata.transferCharacteristics),
        },
      });
      return;
    }

    if (type === "audio") {
      const sourceCodec = trackMetadata.sourceCodec ?? trackMetadata.originalCodec ?? trackMetadata.codec;
      this._hasActualAudioInfo = true;
      this._mergeMediaInfo({
        audio: {
          codec: typeof sourceCodec === "string" ? sourceCodec : undefined,
          channelCount: typeof trackMetadata.channelCount === "number" ? trackMetadata.channelCount : undefined,
        },
      });
    }
  }

  private _handleFmp4TrackMetadata(track: InitSegmentTrackInfo): void {
    if (track.type === "video") {
      this._hasActualVideoInfo = true;
      this._mergeMediaInfo({
        video: {
          codec: track.codec,
          width: track.width,
          height: track.height,
          scanType: track.scanType,
          dynamicRange: dynamicRangeFromTransfer(track.transferCharacteristics),
        },
      });
    } else {
      this._hasActualAudioInfo = true;
      this._mergeMediaInfo({ audio: { codec: track.codec, channelCount: track.channelCount } });
    }
  }

  private _load(segments: PlayerSegment[]): void {
    this._runId++;
    this._teardown();
    this._resetMediaInfo();

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
    hls.onInfo = (info) => {
      this._callbacks.onHlsInfo(info);
      this._handleHlsInfo(info);
    };
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
          const error = e as Error;
          Log.e(this.TAG, `Segment source failed: ${error.message}`);
          if (e instanceof HlsRequestError) {
            this._callbacks.onIOError(
              e.code !== undefined ? PlayerErrors.HTTP_STATUS_CODE_INVALID : PlayerErrors.REQUEST_FAILED,
              {
                code: e.code ?? -1,
                msg: e.statusText || e.message,
                url: e.url,
              },
            );
          } else {
            this._callbacks.onIOError(PlayerErrors.EXCEPTION, { code: -1, msg: error.message });
          }
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
          const initSegmentChanged = meta.initUrl !== undefined && meta.initUrl !== this._lastInitUrl;
          this._resetTransmux(meta.start, !this._fmp4Mode || initSegmentChanged);
        }
        if (meta.initUrl && meta.initUrl !== this._lastInitUrl) {
          if (!(await this._waitIfPaused(runId))) return;
          await this._loadFmp4Init(meta.initUrl, runId);
          if (this._runId !== runId) return;
          this._lastInitUrl = meta.initUrl;
        }
        if (!(await this._waitIfPaused(runId))) return;
        this._currentSegmentBytes = 0;
        await this._loadSegment(meta);
        if (this._runId !== runId) return;
        if (this._sourceMode === "hls" || this._fmp4Mode) {
          this._publishSegmentBitrate(meta.duration);
        }

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
          this._callbacks.onIOError(PlayerErrors.EXCEPTION, { code: -1, msg: (e as Error).message });
        }
        return;
      }
    }
  }

  /** Destroy demuxer + remuxer so the next segment re-anchors the output timeline at `startSeconds`. */
  private _resetTransmux(startSeconds: number, resetPeriodMediaInfo: boolean): void {
    this._resetBitrateMeasurement();
    if (resetPeriodMediaInfo) {
      this._resetPeriodMediaInfo();
    }
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
    ioctl.onDataArrival = (data, byteStart) => this._onInputChunk(meta, data, byteStart);
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
      ioctl.onDataArrival = (data, byteStart) => this._onInputChunk(meta, data, byteStart);
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
  private _onInputChunk(meta: SegmentMeta, data: Uint8Array, byteStart: number): number {
    this._recordInputBytes(data.byteLength);
    return this._onProbeChunk(meta, data, byteStart);
  }

  private _onProbeChunk(meta: SegmentMeta, data: Uint8Array, byteStart: number): number {
    if (this._fmp4Mode) {
      return this._onFmp4Chunk(data);
    }

    const probeData = TSDemuxer.probe(data);
    if (probeData.match) {
      this._setupTSDemuxerRemuxer(probeData, meta);
      if (this._ioctl && this._demuxer) {
        const demuxer = this._demuxer;
        this._ioctl.onDataArrival = (chunk, chunkByteStart) => {
          this._recordInputBytes(chunk.byteLength);
          return demuxer.parseChunks(chunk, chunkByteStart);
        };
      }
      return this._demuxer?.parseChunks(data, byteStart) ?? 0;
    }

    if (probeFmp4(data)) {
      this._fmp4Mode = true;
      if (this._ioctl) {
        this._ioctl.onDataArrival = (chunk) => {
          this._recordInputBytes(chunk.byteLength);
          return this._onFmp4Chunk(chunk);
        };
      }
      return this._onFmp4Chunk(data);
    }

    if (!probeData.needMoreData) {
      Log.e(this.TAG, "Unsupported media type (neither MPEG-TS nor fMP4)");
      Promise.resolve().then(() => this._abortCurrentLoad());
      this._callbacks.onDemuxError(PlayerErrors.FORMAT_UNSUPPORTED, "Unsupported media type!");
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
    demuxer.onPcr = (pcrBase, bytePosition, discontinuity) => {
      this._recordTsPcr(pcrBase, bytePosition, discontinuity);
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
    const remuxTrackMetadata = demuxer.onTrackMetadata;
    demuxer.onTrackMetadata = (type, metadata) => {
      this._handleTsTrackMetadata(type, metadata);
      remuxTrackMetadata?.(type, metadata);
    };

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

  private _onDemuxException(type: DemuxErrorDetail, info: string): void {
    Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
    this._callbacks.onDemuxError(type, info);
  }

  // ---- fMP4 passthrough path ----

  private async _loadFmp4Init(initUrl: string, runId: number): Promise<void> {
    this._fmp4Mode = true;
    let response: Response;
    try {
      response = await fetch(initUrl, {
        headers: this._config.headers,
        referrerPolicy: (this._config.referrerPolicy as ReferrerPolicy | undefined) ?? "no-referrer-when-downgrade",
      });
    } catch (error) {
      throw new LoadError(PlayerErrors.REQUEST_FAILED, {
        code: -1,
        msg: error instanceof Error ? error.message : String(error),
        url: initUrl,
      });
    }
    if (this._runId !== runId) return;
    if (!response.ok) {
      throw new LoadError(PlayerErrors.HTTP_STATUS_CODE_INVALID, {
        code: response.status,
        msg: response.statusText,
        url: response.url || initUrl,
      });
    }
    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new LoadError(PlayerErrors.REQUEST_FAILED, {
        code: -1,
        msg: error instanceof Error ? error.message : String(error),
        url: response.url || initUrl,
      });
    }
    // Superseded mid-fetch (seek/reload/destroy): don't append a stale init segment
    if (this._runId !== runId) return;
    this._sendFmp4Init(data);
  }

  private _sendFmp4Init(data: Uint8Array): void {
    const initInfo = parseInitSegment(data);
    this._fmp4Timescales = initInfo.timescales;
    this._fmp4TimestampOffsetWarningLogged = false;
    for (const track of initInfo.tracks) {
      this._handleFmp4TrackMetadata(track);
    }
    const codec = initInfo.codecs.join(",") || this._hlsSource?.info.codecs || "";
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
        this._callbacks.onDemuxError(PlayerErrors.FORMAT_ERROR, "fMP4 stream has no initialization segment (moov)");
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

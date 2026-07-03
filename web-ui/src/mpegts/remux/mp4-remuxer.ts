import { isFirefox } from "../utils/browser";
import { IllegalStateException } from "../utils/exception";
import Log from "../utils/logger";
import AAC from "./aac-silent";
import MP4 from "./mp4-generator";

interface AudioSample {
  unit: Uint8Array;
  dts: number;
  pts: number;
  length: number;
  [key: string]: unknown;
}

interface VideoUnit {
  data: Uint8Array;
  /** false for H.264 AnnexB payloads that need AVC length-prefixes written at remux time. */
  lengthPrefixed?: boolean;
}

interface VideoSample {
  units: VideoUnit[];
  dts: number;
  pts: number;
  cts: number;
  length: number;
  isKeyframe: boolean;
  fileposition?: number;
  [key: string]: unknown;
}

interface DemuxTrack {
  type: string;
  id: number;
  sequenceNumber: number;
  samples: unknown[];
  length: number;
  [key: string]: unknown;
}

interface TrackMetadata {
  codec: string;
  originalCodec?: string;
  channelCount?: number;
  audioSampleRate?: number;
  refSampleDuration?: number;
  duration?: number;
  [key: string]: unknown;
}

interface InitSegment {
  type: string;
  data: ArrayBufferLike;
  codec: string;
  container: string;
  mediaDuration?: number;
  /** Codec-level video info for the video track (metadata interlace hint etc.). */
  videoInfo?: { width: number; height: number; mayBeInterlaced: boolean };
}

interface MediaSegment {
  type: string;
  data: ArrayBufferLike;
  timestampOffset?: number;
}

interface MP4SampleFlags {
  isLeading: number;
  dependsOn: number;
  isDependedOn: number;
  hasRedundancy: number;
  isNonSync?: number;
}

interface MP4Sample {
  dts: number;
  pts: number;
  cts: number;
  unit?: Uint8Array;
  units?: VideoUnit[];
  size: number;
  duration: number;
  originalDts: number;
  isKeyframe?: boolean;
  flags: MP4SampleFlags;
}

interface TrackTimingState {
  lastOriginalDts: number | undefined;
  lastOriginalEndDts: number | undefined;
  lastOutputEndDts: number | undefined;
  lastOutputDuration: number | undefined;
  durationResidual: number;
}

type PcmTimestampMapping = { action: "drop" } | { action: "emit"; time: number; trimStartMs: number };

type InitSegmentCallback = (type: string, segment: InitSegment) => void;
type MediaSegmentCallback = (type: string, segment: MediaSegment) => void;

interface DataProducer {
  onDataAvailable: (...args: unknown[]) => void;
  onTrackMetadata: (...args: unknown[]) => void;
}

function writeUint32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

// Fragmented mp4 remuxer
class MP4Remuxer {
  TAG: string;

  private _dtsBase: number;
  private _dtsBaseInited: boolean;
  private _dtsBaseOffset: number;
  private _audioDtsBase: number;
  private _videoDtsBase: number;
  private _audioNextDts: number | undefined;
  private _videoNextDts: number | undefined;
  private _audioStashedLastSample: AudioSample | null;
  private _videoStashedLastSample: VideoSample | null;
  private _audioTiming: TrackTimingState;
  private _videoTiming: TrackTimingState;
  private _pcmTiming: TrackTimingState;
  private _videoPresentationOffset: number | undefined;
  private _videoInitialPresentationOffset: number | undefined;
  private _videoInitialOutputTime: number | undefined;

  private _audioMeta: TrackMetadata | null;
  private _videoMeta: TrackMetadata | null;

  private _onInitSegment: InitSegmentCallback | null;
  private _onMediaSegment: MediaSegmentCallback | null;

  private _mp3UseMpegAudio: boolean;

  private _silentAudioMode: boolean;
  private _silentAudioLastDts: number | undefined;
  private _tsSegmentContinuityNormalization: boolean;

  constructor() {
    this.TAG = "MP4Remuxer";

    this._dtsBase = -1;
    this._dtsBaseInited = false;
    this._dtsBaseOffset = 0;
    this._audioDtsBase = Infinity;
    this._videoDtsBase = Infinity;
    this._audioNextDts = undefined;
    this._videoNextDts = undefined;
    this._audioStashedLastSample = null;
    this._videoStashedLastSample = null;
    this._audioTiming = this._createTrackTimingState();
    this._videoTiming = this._createTrackTimingState();
    this._pcmTiming = this._createTrackTimingState();
    this._videoPresentationOffset = undefined;
    this._videoInitialPresentationOffset = undefined;
    this._videoInitialOutputTime = undefined;

    this._audioMeta = null;
    this._videoMeta = null;

    this._onInitSegment = null;
    this._onMediaSegment = null;

    // While only FireFox supports 'audio/mp4, codecs="mp3"', use 'audio/mpeg' for chrome, safari, ...
    this._mp3UseMpegAudio = !isFirefox;

    this._silentAudioMode = false;
    this._silentAudioLastDts = undefined;
    this._tsSegmentContinuityNormalization = false;
  }

  destroy(): void {
    this._dtsBase = -1;
    this._dtsBaseInited = false;
    this._silentAudioMode = false;
    this._silentAudioLastDts = undefined;
    this._tsSegmentContinuityNormalization = false;
    this._audioTiming = this._createTrackTimingState();
    this._videoTiming = this._createTrackTimingState();
    this._pcmTiming = this._createTrackTimingState();
    this._videoPresentationOffset = undefined;
    this._videoInitialPresentationOffset = undefined;
    this._videoInitialOutputTime = undefined;
    this._audioMeta = null;
    this._videoMeta = null;
    this._onInitSegment = null;
    this._onMediaSegment = null;
  }

  bindDataSource(producer: DataProducer): this {
    producer.onDataAvailable = this.remux.bind(this) as (...args: unknown[]) => void;
    producer.onTrackMetadata = this._onTrackMetadataReceived.bind(this) as (...args: unknown[]) => void;
    return this;
  }

  /* prototype: function onInitSegment(type: string, initSegment: ArrayBuffer): void
       InitSegment: {
           type: string,
           data: ArrayBuffer,
           codec: string,
           container: string
       }
    */
  get onInitSegment(): InitSegmentCallback | null {
    return this._onInitSegment;
  }

  set onInitSegment(callback: InitSegmentCallback | null) {
    this._onInitSegment = callback;
  }

  /* prototype: function onMediaSegment(type: string, mediaSegment: MediaSegment): void */
  get onMediaSegment(): MediaSegmentCallback | null {
    return this._onMediaSegment;
  }

  set onMediaSegment(callback: MediaSegmentCallback | null) {
    this._onMediaSegment = callback;
  }

  insertDiscontinuity(): void {
    this._audioNextDts = this._videoNextDts = undefined;
    this._silentAudioLastDts = undefined;
    this._videoPresentationOffset = undefined;
  }

  setTsSegmentContinuityNormalization(enabled: boolean): void {
    this._tsSegmentContinuityNormalization = enabled;
  }

  private _createTrackTimingState(): TrackTimingState {
    return {
      lastOriginalDts: undefined,
      lastOriginalEndDts: undefined,
      lastOutputEndDts: undefined,
      lastOutputDuration: undefined,
      durationResidual: 0,
    };
  }

  /**
   * Map upstream timestamps onto a continuous output timeline.
   * When `_nextDts` is set (continuous playback), always splice to it.
   * After a discontinuity, preserve the last timeline correction and bridge
   * forward holes so MSE stays on a continuous output timeline.
   */
  private _computeDtsCorrection(
    type: "audio" | "video",
    firstSampleOriginalDts: number,
    nextDts: number | undefined,
    timing: TrackTimingState,
  ): number {
    if (nextDts !== undefined) {
      return firstSampleOriginalDts - nextDts;
    }

    if (timing.lastOriginalEndDts === undefined || timing.lastOutputEndDts === undefined) {
      return firstSampleOriginalDts - this._dtsBaseOffset;
    }

    const distance = firstSampleOriginalDts - timing.lastOriginalEndDts;
    const bridgedDistance = distance > 0 ? 0 : distance;
    if (bridgedDistance !== distance) {
      Log.v(this.TAG, `${type}: bridging ${Math.round(distance)}ms timestamp hole after discontinuity`);
    }
    const expectedDts = timing.lastOutputEndDts + bridgedDistance;
    return firstSampleOriginalDts - expectedDts;
  }

  private _recordTrackTiming(timing: TrackTimingState, sample: MP4Sample): void {
    timing.lastOriginalDts = sample.originalDts;
    timing.lastOriginalEndDts = sample.originalDts + sample.duration;
    timing.lastOutputEndDts = sample.dts + sample.duration;
  }

  private _dropOverlappingTrackSamples<T extends { dts: number; length: number }>(
    samples: T[],
    timing: TrackTimingState,
    mdatBytes: number,
  ): number {
    if (!this._tsSegmentContinuityNormalization) {
      return mdatBytes;
    }

    const lastOriginalDts = timing.lastOriginalDts;
    if (lastOriginalDts === undefined) {
      return mdatBytes;
    }

    while (samples.length > 0) {
      const originalDts = samples[0].dts - this._dtsBase;
      if (originalDts > lastOriginalDts) {
        break;
      }

      const sample = samples.shift() as T;
      mdatBytes -= sample.length;
    }

    return mdatBytes;
  }

  private _nextSampleDuration(timing: TrackTimingState, refSampleDuration: unknown, fallbackDuration: number): number {
    const reference =
      typeof refSampleDuration === "number" && Number.isFinite(refSampleDuration) && refSampleDuration > 0
        ? refSampleDuration
        : (timing.lastOutputDuration ?? fallbackDuration);
    const withResidual = reference + timing.durationResidual;
    const duration = Math.max(1, Math.round(withResidual));
    timing.durationResidual = withResidual - duration;
    timing.lastOutputDuration = duration;
    return duration;
  }

  /**
   * Position the output timeline: the first remuxed sample will be emitted at `offsetMs`
   * instead of 0. Must be called before any samples are remuxed.
   */
  setDtsBaseOffset(offsetMs: number): void {
    this._dtsBaseOffset = offsetMs;
  }

  remux(audioTrack: DemuxTrack | null | undefined, videoTrack: DemuxTrack | null | undefined, force = false): void {
    if (!this._onMediaSegment) {
      throw new IllegalStateException("MP4Remuxer: onMediaSegment callback must be specificed!");
    }
    if (!this._dtsBaseInited) {
      this._calculateDtsBase(audioTrack, videoTrack);
    }
    if (videoTrack) {
      this._remuxVideo(videoTrack, force);
    }
    if (audioTrack) {
      this._remuxAudio(audioTrack, force);
    }
  }

  /**
   * Generate silent AAC audio frames synced to video timestamps.
   * Used in soft decode mode to keep MSE audio track active (prevents
   * Safari/Chrome from pausing video when tab goes to background).
   */
  private _generateSilentAudio(videoSamples: MP4Sample[]): void {
    if (!this._audioMeta || !this._onMediaSegment) {
      return;
    }

    const sampleRate = (this._audioMeta.audioSampleRate as number) || 48000;
    const channelCount = (this._audioMeta.channelCount as number) || 2;
    const frameDuration = (1024 / sampleRate) * 1000; // AAC frame duration in ms

    const silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec ?? "mp4a.40.2", channelCount);
    if (!silentUnit) {
      return;
    }

    if (videoSamples.length === 0) {
      return;
    }

    const videoEndDts = videoSamples[videoSamples.length - 1].dts + videoSamples[videoSamples.length - 1].duration;

    if (this._silentAudioLastDts === undefined) {
      this._silentAudioLastDts = videoSamples[0].dts;
    }

    const samples: Array<{ unit: Uint8Array; dts: number; pts: number }> = [];
    let mdatBytes = 0;
    let dts = this._silentAudioLastDts;

    while (dts < videoEndDts) {
      samples.push({ unit: silentUnit, dts, pts: dts });
      mdatBytes += silentUnit.byteLength;
      dts += frameDuration;
    }

    this._silentAudioLastDts = dts;

    if (samples.length === 0) {
      return;
    }

    // Build mp4 samples
    const mp4Samples: MP4Sample[] = [];
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const sampleDuration = i < samples.length - 1 ? samples[i + 1].dts - sample.dts : frameDuration;

      mp4Samples.push({
        dts: sample.dts,
        pts: sample.pts,
        cts: 0,
        unit: sample.unit,
        size: sample.unit.byteLength,
        duration: sampleDuration,
        originalDts: sample.dts,
        flags: {
          isLeading: 0,
          dependsOn: 1,
          isDependedOn: 0,
          hasRedundancy: 0,
        },
      });
    }

    // Generate mdat
    const mdatbox = new Uint8Array(mdatBytes + 8);
    const mdatView = new DataView(mdatbox.buffer);
    mdatView.setUint32(0, mdatBytes + 8);
    mdatbox.set(new Uint8Array(MP4.types.mdat), 4);

    let offset = 8;
    for (const s of mp4Samples) {
      mdatbox.set(s.unit as Uint8Array, offset);
      offset += s.size;
    }

    // Generate moof
    const firstDts = mp4Samples[0].dts;
    const sequenceNumber = ((this._audioMeta as Record<string, unknown>).sequenceNumber as number) ?? 0;
    (this._audioMeta as Record<string, unknown>).sequenceNumber = sequenceNumber + 1;

    const silentTrack = {
      type: "audio",
      id: this._audioMeta.id ?? 2,
      sequenceNumber,
      samples: mp4Samples,
    };
    const moofbox = MP4.moof(silentTrack as unknown as import("./mp4-generator").MP4Track, firstDts);

    // Emit media segment
    const segment = new Uint8Array(moofbox.byteLength + mdatbox.byteLength);
    segment.set(moofbox, 0);
    segment.set(mdatbox, moofbox.byteLength);

    this._onMediaSegment("audio", {
      type: "audio",
      data: segment.buffer,
    });
  }

  private _onTrackMetadataReceived(type: string, metadata: TrackMetadata): void {
    let metabox: Uint8Array | null = null;

    let container = "mp4";
    let codec = metadata.codec;

    if (type === "audio") {
      this._audioMeta = metadata;
      if (metadata.silentAudioMode === true) {
        this._silentAudioMode = true;
      }
      if (metadata.codec === "mp3" && this._mp3UseMpegAudio) {
        // 'audio/mpeg' for MP3 audio track
        container = "mpeg";
        codec = "";
        metabox = new Uint8Array();
      } else {
        // 'audio/mp4, codecs="codec"'
        metabox = MP4.generateInitSegment(metadata as unknown as import("./mp4-generator").MP4Meta);
      }
    } else if (type === "video") {
      this._videoMeta = metadata;
      metabox = MP4.generateInitSegment(metadata as unknown as import("./mp4-generator").MP4Meta);
    } else {
      return;
    }

    // dispatch metabox (Initialization Segment)
    if (!this._onInitSegment) {
      throw new IllegalStateException("MP4Remuxer: onInitSegment callback must be specified!");
    }
    this._onInitSegment(type, {
      type: type,
      data: (metabox as Uint8Array).buffer,
      codec: codec,
      container: `${type}/${container}`,
      mediaDuration: metadata.duration, // in timescale 1000 (milliseconds)
      videoInfo:
        type === "video"
          ? {
              width: (metadata.codecWidth as number) ?? 0,
              height: (metadata.codecHeight as number) ?? 0,
              mayBeInterlaced: metadata.mayBeInterlaced === true,
            }
          : undefined,
    });
  }

  private _calculateDtsBase(
    audioTrack: DemuxTrack | null | undefined,
    videoTrack: DemuxTrack | null | undefined,
  ): void {
    if (this._dtsBaseInited) {
      return;
    }

    if (audioTrack?.samples?.length) {
      this._audioDtsBase = (audioTrack.samples[0] as AudioSample).dts;
    }
    if (videoTrack?.samples?.length) {
      this._videoDtsBase = (videoTrack.samples[0] as VideoSample).dts;
    }

    // With video present, the output timeline starts at the first emitted
    // keyframe. Audio before that point is discarded/compressed onto this same
    // video anchor so MSE never starts at an audio-only offset.
    if (this._videoDtsBase !== Infinity) {
      this._dtsBase = this._videoDtsBase;
    } else {
      this._dtsBase = this._audioDtsBase;
    }
    this._dtsBase -= this._dtsBaseOffset;
    this._dtsBaseInited = true;
  }

  getTimestampBase(): number | undefined {
    if (!this._dtsBaseInited) {
      return undefined;
    }
    return this._dtsBase;
  }

  getInitialPresentationOffset(): number {
    return this._videoInitialPresentationOffset ?? 0;
  }

  getInitialOutputTime(): number {
    return this._videoInitialOutputTime ?? 0;
  }

  mapPcmTimestamp(ptsMs: number, durationMs: number): PcmTimestampMapping | undefined {
    if (!this._dtsBaseInited) {
      return undefined;
    }

    const originalTime = ptsMs - this._dtsBase;
    const duration = Math.max(0, durationMs);
    let outputTime: number;
    let trimStartMs = 0;

    if (this._pcmTiming.lastOriginalEndDts === undefined || this._pcmTiming.lastOutputEndDts === undefined) {
      if (
        this._videoDtsBase !== Infinity &&
        (this._videoInitialPresentationOffset === undefined || this._videoInitialOutputTime === undefined)
      ) {
        return undefined;
      }

      const presentationFloor = this.getInitialOutputTime();
      const presentationStart = originalTime - this.getInitialPresentationOffset();
      const presentationEnd = presentationStart + duration;

      if (presentationEnd <= presentationFloor) {
        return { action: "drop" };
      }

      trimStartMs = Math.max(0, presentationFloor - presentationStart);
      outputTime = Math.max(presentationFloor, presentationStart);
    } else {
      const distance = originalTime - this._pcmTiming.lastOriginalEndDts;
      outputTime = this._pcmTiming.lastOutputEndDts + (distance > 0 ? 0 : distance);
      if (distance > 0) {
        Log.v(this.TAG, `PCM: bridging ${Math.round(distance)}ms timestamp hole`);
      }
    }

    const emittedDuration = duration - trimStartMs;
    if (emittedDuration <= 0) {
      return { action: "drop" };
    }

    this._pcmTiming.lastOriginalEndDts = originalTime + duration;
    this._pcmTiming.lastOutputEndDts = outputTime + emittedDuration;
    this._pcmTiming.lastOutputDuration = emittedDuration;
    return { action: "emit", time: outputTime / 1000, trimStartMs };
  }

  flushStashedSamples(): void {
    const videoSample = this._videoStashedLastSample;
    const audioSample = this._audioStashedLastSample;

    const videoTrack: DemuxTrack = {
      type: "video",
      id: 1,
      sequenceNumber: 0,
      samples: [],
      length: 0,
    };

    if (videoSample != null) {
      videoTrack.samples.push(videoSample);
      videoTrack.length = videoSample.length;
    }

    const audioTrack: DemuxTrack = {
      type: "audio",
      id: 2,
      sequenceNumber: 0,
      samples: [],
      length: 0,
    };

    if (audioSample != null) {
      audioTrack.samples.push(audioSample);
      audioTrack.length = audioSample.length;
    }

    this._videoStashedLastSample = null;
    this._audioStashedLastSample = null;

    this._remuxVideo(videoTrack, true);
    this._remuxAudio(audioTrack, true);
  }

  private _remuxAudio(audioTrack: DemuxTrack, force?: boolean): void {
    if (this._audioMeta == null) {
      return;
    }

    const track = audioTrack;
    const samples = track.samples as AudioSample[];
    let firstDts = -1;
    const refSampleDuration = this._audioMeta.refSampleDuration;

    const mpegRawTrack = this._audioMeta.codec === "mp3" && this._mp3UseMpegAudio;
    const firstSegmentAfterSeek = this._dtsBaseInited && this._audioNextDts === undefined;

    if (!samples || samples.length === 0) {
      return;
    }
    if (samples.length === 1 && !force) {
      // If [sample count in current batch] === 1 && (force != true)
      // Ignore and keep in demuxer's queue
      return;
    } // else if (force === true) do remux

    let offset = 0;
    let mdatbox: Uint8Array | null = null;
    let mdatBytes = 0;

    // calculate initial mdat size
    if (mpegRawTrack) {
      // for raw mpeg buffer
      offset = 0;
      mdatBytes = track.length;
    } else {
      // for fmp4 mdat box
      offset = 8; // size + type
      mdatBytes = 8 + track.length;
    }

    let lastSample: AudioSample | null = null;

    // Pop the lastSample and waiting for stash
    if (samples.length > 1) {
      lastSample = samples.pop() as AudioSample;
      mdatBytes -= lastSample.length;
    }

    // Insert [stashed lastSample in the previous batch] to the front
    if (this._audioStashedLastSample != null) {
      const sample = this._audioStashedLastSample;
      this._audioStashedLastSample = null;
      samples.unshift(sample);
      mdatBytes += sample.length;
    }

    // Stash the lastSample of current batch, waiting for next batch
    if (lastSample != null) {
      this._audioStashedLastSample = lastSample;
    }

    mdatBytes = this._dropOverlappingTrackSamples(samples, this._audioTiming, mdatBytes);
    if (samples.length === 0) {
      track.samples = [];
      track.length = 0;
      return;
    }

    const firstSampleOriginalDts = (samples[0] as AudioSample).dts - this._dtsBase;

    const dtsCorrection = this._computeDtsCorrection(
      "audio",
      firstSampleOriginalDts,
      this._audioNextDts,
      this._audioTiming,
    );

    const mp4Samples: MP4Sample[] = [];
    let nextOutputDts = firstSampleOriginalDts - dtsCorrection;

    // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] as AudioSample;
      const originalDts = sample.dts - this._dtsBase;

      if (originalDts < -0.001) {
        continue; //pass the first sample with the invalid dts
      }

      const dts = nextOutputDts;
      const sampleDuration = this._nextSampleDuration(this._audioTiming, refSampleDuration, 26);
      nextOutputDts += sampleDuration;

      if (firstDts === -1) {
        firstDts = dts;
      }
      mp4Samples.push({
        dts: dts,
        pts: dts,
        cts: 0,
        unit: sample.unit,
        size: sample.unit.byteLength,
        duration: sampleDuration,
        originalDts: originalDts,
        flags: {
          isLeading: 0,
          dependsOn: 1,
          isDependedOn: 0,
          hasRedundancy: 0,
        },
      });
    }

    if (mp4Samples.length === 0) {
      //no samples need to remux
      track.samples = [];
      track.length = 0;
      return;
    }

    // allocate mdatbox
    if (mpegRawTrack) {
      // allocate for raw mpeg buffer
      mdatbox = new Uint8Array(mdatBytes);
    } else {
      // allocate for fmp4 mdat box
      mdatbox = new Uint8Array(mdatBytes);
      // size field
      mdatbox[0] = (mdatBytes >>> 24) & 0xff;
      mdatbox[1] = (mdatBytes >>> 16) & 0xff;
      mdatbox[2] = (mdatBytes >>> 8) & 0xff;
      mdatbox[3] = mdatBytes & 0xff;
      // type field (fourCC)
      mdatbox.set(MP4.types.mdat, 4);
    }

    // Write samples into mdatbox
    for (let i = 0; i < mp4Samples.length; i++) {
      const unit = mp4Samples[i].unit as Uint8Array;
      mdatbox.set(unit, offset);
      offset += unit.byteLength;
    }

    track.samples = mp4Samples;
    track.sequenceNumber++;
    const latest = mp4Samples[mp4Samples.length - 1];
    this._audioNextDts = latest.dts + latest.duration;
    this._recordTrackTiming(this._audioTiming, latest);

    let moofbox: Uint8Array;

    if (mpegRawTrack) {
      // Generate empty buffer, because useless for raw mpeg
      moofbox = new Uint8Array();
    } else {
      // Generate moof for fmp4 segment
      moofbox = MP4.moof(track as unknown as import("./mp4-generator").MP4Track, firstDts);
    }

    track.samples = [];
    track.length = 0;

    const segment: MediaSegment = {
      type: "audio",
      data: this._mergeBoxes(moofbox, mdatbox).buffer,
    };

    if (mpegRawTrack && firstSegmentAfterSeek) {
      // For MPEG audio stream in MSE, if seeking occurred, before appending new buffer
      // We need explicitly set timestampOffset to the desired point in timeline for mpeg SourceBuffer.
      segment.timestampOffset = firstDts;
    }

    this._onMediaSegment?.("audio", segment);
  }

  private _remuxVideo(videoTrack: DemuxTrack, force?: boolean): void {
    if (this._videoMeta == null) {
      return;
    }

    const track = videoTrack;
    const samples = track.samples as VideoSample[];
    let firstDts = -1;

    if (!samples || samples.length === 0) {
      return;
    }
    if (samples.length === 1 && !force) {
      // If [sample count in current batch] === 1 && (force != true)
      // Ignore and keep in demuxer's queue
      return;
    } // else if (force === true) do remux

    let mdatBytes = 8 + videoTrack.length;

    let lastSample: VideoSample | null = null;

    // Pop the lastSample and waiting for stash
    if (samples.length > 1) {
      lastSample = samples.pop() as VideoSample;
      mdatBytes -= lastSample.length;
    }

    // Insert [stashed lastSample in the previous batch] to the front
    if (this._videoStashedLastSample != null) {
      const sample = this._videoStashedLastSample;
      this._videoStashedLastSample = null;
      samples.unshift(sample);
      mdatBytes += sample.length;
    }

    // Stash the lastSample of current batch, waiting for next batch
    if (lastSample != null) {
      this._videoStashedLastSample = lastSample;
    }

    mdatBytes = this._dropOverlappingTrackSamples(samples, this._videoTiming, mdatBytes);
    if (samples.length === 0) {
      track.samples = [];
      track.length = 0;
      return;
    }

    const firstSampleOriginalDts = (samples[0] as VideoSample).dts - this._dtsBase;

    const dtsCorrection = this._computeDtsCorrection(
      "video",
      firstSampleOriginalDts,
      this._videoNextDts,
      this._videoTiming,
    );

    const mp4Samples: MP4Sample[] = [];
    let nextOutputDts = firstSampleOriginalDts - dtsCorrection;
    const presentationFloor = this._videoInitialOutputTime ?? this._dtsBaseOffset;

    // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] as VideoSample;
      const originalDts = sample.dts - this._dtsBase;
      const isKeyframe = sample.isKeyframe;

      const dts = nextOutputDts;
      const originalPts = originalDts + sample.cts;
      const correctedPtsBase = this._tsSegmentContinuityNormalization ? originalPts - dtsCorrection : originalPts;
      if (this._videoPresentationOffset === undefined) {
        this._videoPresentationOffset = correctedPtsBase - dts;
        if (this._videoInitialPresentationOffset === undefined) {
          this._videoInitialPresentationOffset = this._videoPresentationOffset;
        }
      }

      const pts = correctedPtsBase - this._videoPresentationOffset;
      if (pts < presentationFloor - 0.001) {
        mdatBytes -= sample.length;
        continue;
      }

      if (firstDts === -1) {
        firstDts = dts;
      }
      if (this._videoInitialOutputTime === undefined) {
        this._videoInitialOutputTime = dts;
      }

      const sampleDuration = this._nextSampleDuration(this._videoTiming, this._videoMeta?.refSampleDuration, 40);
      nextOutputDts += sampleDuration;
      const cts = pts - dts;

      mp4Samples.push({
        dts: dts,
        pts: pts,
        cts: cts,
        units: sample.units,
        size: sample.length,
        isKeyframe: isKeyframe,
        duration: sampleDuration,
        originalDts: originalDts,
        flags: {
          isLeading: 0,
          dependsOn: isKeyframe ? 2 : 1,
          isDependedOn: isKeyframe ? 1 : 0,
          hasRedundancy: 0,
          isNonSync: isKeyframe ? 0 : 1,
        },
      });
    }

    if (mp4Samples.length === 0) {
      track.samples = [];
      track.length = 0;
      return;
    }

    const latest = mp4Samples[mp4Samples.length - 1];
    this._videoNextDts = latest.dts + latest.duration;
    this._recordTrackTiming(this._videoTiming, latest);

    track.samples = mp4Samples;
    track.sequenceNumber++;

    const moofbox = MP4.moof(track as unknown as import("./mp4-generator").MP4Track, firstDts);
    track.samples = [];
    track.length = 0;

    const segment = new Uint8Array(moofbox.byteLength + mdatBytes);
    segment.set(moofbox, 0);
    let offset = moofbox.byteLength;
    writeUint32(segment, offset, mdatBytes);
    segment.set(MP4.types.mdat, offset + 4);
    offset += 8;

    for (const sample of mp4Samples) {
      const units = sample.units as VideoUnit[];
      for (const unit of units) {
        const data = unit.data;
        if (unit.lengthPrefixed === false) {
          writeUint32(segment, offset, data.byteLength);
          offset += 4;
        }
        segment.set(data, offset);
        offset += data.byteLength;
      }
    }

    this._onMediaSegment?.("video", {
      type: "video",
      data: segment.buffer,
    });
    if (this._silentAudioMode) {
      this._generateSilentAudio(mp4Samples);
    }
  }

  private _mergeBoxes(moof: Uint8Array, mdat: Uint8Array): Uint8Array {
    const result = new Uint8Array(moof.byteLength + mdat.byteLength);
    result.set(moof, 0);
    result.set(mdat, moof.byteLength);
    return result;
  }
}

export default MP4Remuxer;

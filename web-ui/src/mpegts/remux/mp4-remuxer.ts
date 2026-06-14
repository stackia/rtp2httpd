import { defaultConfig, type PlayerConfig } from "../config";
import { MediaSegmentInfo, MediaSegmentInfoList, SampleInfo } from "../core/media-segment-info";
import { isFirefox } from "../utils/browser";
import { IllegalStateException } from "../utils/exception";
import Log from "../utils/logger";
import AAC from "./aac-silent";
import MP4 from "./mp4-generator";

type RemuxerConfig = Pick<PlayerConfig, "maxBufferHoleMs">;

interface AudioSample {
  unit: Uint8Array;
  dts: number;
  pts: number;
  length: number;
  [key: string]: unknown;
}

interface VideoSample {
  units: Array<{ data: Uint8Array }>;
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
}

interface MediaSegment {
  type: string;
  data: ArrayBufferLike;
  sampleCount: number;
  info: MediaSegmentInfo;
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
  units?: Array<{ data: Uint8Array }>;
  size: number;
  duration: number;
  originalDts: number;
  isKeyframe?: boolean;
  flags: MP4SampleFlags;
}

type InitSegmentCallback = (type: string, segment: InitSegment) => void;
type MediaSegmentCallback = (type: string, segment: MediaSegment) => void;

interface DataProducer {
  onDataAvailable: (...args: unknown[]) => void;
  onTrackMetadata: (...args: unknown[]) => void;
}

// Fragmented mp4 remuxer
class MP4Remuxer {
  TAG: string;

  private _config: RemuxerConfig;

  private _dtsBase: number;
  private _dtsBaseInited: boolean;
  private _dtsBaseOffset: number;
  private _audioDtsBase: number;
  private _videoDtsBase: number;
  private _audioNextDts: number | undefined;
  private _videoNextDts: number | undefined;
  private _audioStashedLastSample: AudioSample | null;
  private _videoStashedLastSample: VideoSample | null;

  private _audioMeta: TrackMetadata | null;
  private _videoMeta: TrackMetadata | null;

  private _audioSegmentInfoList: MediaSegmentInfoList | null;
  private _videoSegmentInfoList: MediaSegmentInfoList | null;

  private _onInitSegment: InitSegmentCallback | null;
  private _onMediaSegment: MediaSegmentCallback | null;

  private _mp3UseMpegAudio: boolean;

  private _silentAudioMode: boolean;
  private _silentAudioLastDts: number | undefined;

  constructor(config: RemuxerConfig) {
    this.TAG = "MP4Remuxer";

    this._config = config;

    this._dtsBase = -1;
    this._dtsBaseInited = false;
    this._dtsBaseOffset = 0;
    this._audioDtsBase = Infinity;
    this._videoDtsBase = Infinity;
    this._audioNextDts = undefined;
    this._videoNextDts = undefined;
    this._audioStashedLastSample = null;
    this._videoStashedLastSample = null;

    this._audioMeta = null;
    this._videoMeta = null;

    this._audioSegmentInfoList = new MediaSegmentInfoList("audio");
    this._videoSegmentInfoList = new MediaSegmentInfoList("video");

    this._onInitSegment = null;
    this._onMediaSegment = null;

    // While only FireFox supports 'audio/mp4, codecs="mp3"', use 'audio/mpeg' for chrome, safari, ...
    this._mp3UseMpegAudio = !isFirefox;

    this._silentAudioMode = false;
    this._silentAudioLastDts = undefined;
  }

  destroy(): void {
    this._dtsBase = -1;
    this._dtsBaseInited = false;
    this._silentAudioMode = false;
    this._silentAudioLastDts = undefined;
    this._audioMeta = null;
    this._videoMeta = null;
    this._audioSegmentInfoList?.clear();
    this._audioSegmentInfoList = null;
    this._videoSegmentInfoList?.clear();
    this._videoSegmentInfoList = null;
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

  /* prototype: function onMediaSegment(type: string, mediaSegment: MediaSegment): void
       MediaSegment: {
           type: string,
           data: ArrayBuffer,
           sampleCount: int32
           info: MediaSegmentInfo
       }
    */
  get onMediaSegment(): MediaSegmentCallback | null {
    return this._onMediaSegment;
  }

  set onMediaSegment(callback: MediaSegmentCallback | null) {
    this._onMediaSegment = callback;
  }

  insertDiscontinuity(): void {
    this._audioNextDts = this._videoNextDts = undefined;
    this._silentAudioLastDts = undefined;
  }

  /**
   * Map upstream timestamps onto a continuous output timeline.
   * When `_nextDts` is set (continuous playback), always splice to it.
   * After a discontinuity, bridge only small forward gaps (<= maxBufferHoleMs).
   */
  private _computeDtsCorrection(
    firstSampleOriginalDts: number,
    nextDts: number | undefined,
    segmentInfoList: MediaSegmentInfoList | null,
  ): number {
    if (nextDts !== undefined) {
      return firstSampleOriginalDts - nextDts;
    }

    if (!segmentInfoList || segmentInfoList.isEmpty()) {
      return 0;
    }

    let prevSample = segmentInfoList.getLastSampleBefore(firstSampleOriginalDts);
    if (prevSample == null) {
      const lastSample = segmentInfoList.getLastSample();
      // Fall back only when upstream time moved forward but binary search missed (e.g. HLS segment splice).
      if (lastSample != null && firstSampleOriginalDts >= lastSample.originalDts) {
        prevSample = lastSample;
      }
    }
    if (prevSample == null) {
      return 0;
    }

    let distance = firstSampleOriginalDts - (prevSample.originalDts + prevSample.duration);
    const maxBufferHoleMs = this._config.maxBufferHoleMs ?? defaultConfig.maxBufferHoleMs;
    if (distance > 0 && distance <= maxBufferHoleMs) {
      distance = 0;
    }
    const expectedDts = prevSample.dts + prevSample.duration + distance;
    return firstSampleOriginalDts - expectedDts;
  }

  /**
   * Position the output timeline: the first remuxed sample will be emitted at `offsetMs`
   * instead of 0. Must be called before any samples are remuxed.
   */
  setDtsBaseOffset(offsetMs: number): void {
    this._dtsBaseOffset = offsetMs;
  }

  remux(audioTrack: DemuxTrack | undefined, videoTrack: DemuxTrack | undefined): void {
    if (!this._onMediaSegment) {
      throw new IllegalStateException("MP4Remuxer: onMediaSegment callback must be specificed!");
    }
    if (!this._dtsBaseInited) {
      this._calculateDtsBase(audioTrack, videoTrack);
    }
    if (videoTrack) {
      this._remuxVideo(videoTrack);
    }
    if (audioTrack) {
      this._remuxAudio(audioTrack);
    }
    // In silent audio mode, generate silent frames synced to video
    if (this._silentAudioMode && videoTrack?.samples?.length) {
      this._generateSilentAudio(videoTrack);
    }
  }

  /**
   * Generate silent AAC audio frames synced to video timestamps.
   * Used in soft decode mode to keep MSE audio track active (prevents
   * Safari/Chrome from pausing video when tab goes to background).
   */
  private _generateSilentAudio(videoTrack: DemuxTrack): void {
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

    const videoSamples = videoTrack.samples as VideoSample[];
    const videoEndDts = videoSamples[videoSamples.length - 1].dts - this._dtsBase;

    if (this._silentAudioLastDts === undefined) {
      this._silentAudioLastDts = videoSamples[0].dts - this._dtsBase;
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

    const info = new MediaSegmentInfo();
    info.beginDts = firstDts;
    info.endDts = mp4Samples[mp4Samples.length - 1].dts + mp4Samples[mp4Samples.length - 1].duration;
    info.beginPts = firstDts;
    info.endPts = info.endDts;
    info.originalBeginDts = firstDts;
    info.originalEndDts = info.endDts;
    info.syncPoints = [];
    info.firstSample = new SampleInfo(firstDts, firstDts, frameDuration, firstDts, true);
    const lastSample = mp4Samples[mp4Samples.length - 1];
    info.lastSample = new SampleInfo(lastSample.dts, lastSample.pts, lastSample.duration, lastSample.originalDts, true);

    this._onMediaSegment("audio", {
      type: "audio",
      data: segment.buffer,
      sampleCount: mp4Samples.length,
      info,
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
    });
  }

  private _calculateDtsBase(audioTrack: DemuxTrack | undefined, videoTrack: DemuxTrack | undefined): void {
    if (this._dtsBaseInited) {
      return;
    }

    if (audioTrack?.samples?.length) {
      this._audioDtsBase = (audioTrack.samples[0] as AudioSample).dts;
    }
    if (videoTrack?.samples?.length) {
      this._videoDtsBase = (videoTrack.samples[0] as VideoSample).dts;
    }

    // In silent audio mode, use video DTS as base (no real audio samples)
    if (this._silentAudioMode) {
      this._dtsBase = this._videoDtsBase;
    } else {
      this._dtsBase = Math.min(this._audioDtsBase, this._videoDtsBase);
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
    const samples = track.samples;
    let dtsCorrection: number | undefined;
    let firstDts = -1,
      lastDts = -1,
      _lastPts = -1;
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

    const firstSampleOriginalDts = (samples[0] as AudioSample).dts - this._dtsBase;

    dtsCorrection = this._computeDtsCorrection(firstSampleOriginalDts, this._audioNextDts, this._audioSegmentInfoList);

    const mp4Samples: MP4Sample[] = [];

    // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] as AudioSample;
      const originalDts = sample.dts - this._dtsBase;
      let sampleDuration = 0;

      if (originalDts < -0.001) {
        continue; //pass the first sample with the invalid dts
      }

      const dts = originalDts - (dtsCorrection as number);

      if (i !== samples.length - 1) {
        const nextDts = (samples[i + 1] as AudioSample).dts - this._dtsBase - (dtsCorrection as number);
        sampleDuration = nextDts - dts;
      } else {
        // the last sample
        if (lastSample != null) {
          // use stashed sample's dts to calculate sample duration
          const nextDts = lastSample.dts - this._dtsBase - (dtsCorrection as number);
          sampleDuration = nextDts - dts;
        } else if (mp4Samples.length >= 1) {
          // use second last sample duration
          sampleDuration = mp4Samples[mp4Samples.length - 1].duration as number;
        } else {
          // the only one sample, use reference sample duration
          sampleDuration = Math.floor(refSampleDuration as number);
        }
      }

      if (sampleDuration <= 0) {
        const fallbackDuration =
          Math.floor(refSampleDuration as number) ||
          (mp4Samples.length >= 1 ? (mp4Samples[mp4Samples.length - 1].duration as number) : 0) ||
          26;
        Log.w(
          this.TAG,
          `Audio: non-monotonic dts detected (dts: ${dts} ms, duration: ${Math.round(sampleDuration)} ms), ` +
            `clamping sample duration to ${fallbackDuration} ms`,
        );
        dtsCorrection = (dtsCorrection as number) + (sampleDuration - fallbackDuration);
        sampleDuration = fallbackDuration;
      }

      this._audioNextDts = dts + sampleDuration;

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

    const latest = mp4Samples[mp4Samples.length - 1];
    lastDts = latest.dts + latest.duration;
    //this._audioNextDts = lastDts;

    // fill media segment info & add to info list
    const info = new MediaSegmentInfo();
    info.beginDts = firstDts;
    info.endDts = lastDts;
    info.beginPts = firstDts;
    info.endPts = lastDts;
    info.originalBeginDts = mp4Samples[0].originalDts;
    info.originalEndDts = latest.originalDts + latest.duration;
    info.firstSample = new SampleInfo(
      mp4Samples[0].dts,
      mp4Samples[0].pts,
      mp4Samples[0].duration,
      mp4Samples[0].originalDts,
      false,
    );
    info.lastSample = new SampleInfo(latest.dts, latest.pts, latest.duration, latest.originalDts, false);

    track.samples = mp4Samples;
    track.sequenceNumber++;

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
      sampleCount: mp4Samples.length,
      info: info,
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
    const samples = track.samples;
    let dtsCorrection: number | undefined;
    let firstDts = -1,
      lastDts = -1;
    let firstPts = -1,
      lastPts = -1;

    if (!samples || samples.length === 0) {
      return;
    }
    if (samples.length === 1 && !force) {
      // If [sample count in current batch] === 1 && (force != true)
      // Ignore and keep in demuxer's queue
      return;
    } // else if (force === true) do remux

    let offset = 8;
    let mdatbox: Uint8Array | null = null;
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

    const firstSampleOriginalDts = (samples[0] as VideoSample).dts - this._dtsBase;

    dtsCorrection = this._computeDtsCorrection(firstSampleOriginalDts, this._videoNextDts, this._videoSegmentInfoList);

    const info = new MediaSegmentInfo();
    const mp4Samples: MP4Sample[] = [];

    // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i] as VideoSample;
      const originalDts = sample.dts - this._dtsBase;
      const isKeyframe = sample.isKeyframe;
      const dts = originalDts - (dtsCorrection as number);
      const cts = sample.cts;
      const pts = dts + cts;

      if (firstDts === -1) {
        firstDts = dts;
        firstPts = pts;
      }

      let sampleDuration = 0;

      if (i !== samples.length - 1) {
        const nextDts = (samples[i + 1] as VideoSample).dts - this._dtsBase - (dtsCorrection as number);
        sampleDuration = nextDts - dts;
      } else {
        // the last sample
        if (lastSample != null) {
          // use stashed sample's dts to calculate sample duration
          const nextDts = lastSample.dts - this._dtsBase - (dtsCorrection as number);
          sampleDuration = nextDts - dts;
        } else if (mp4Samples.length >= 1) {
          // use second last sample duration
          sampleDuration = mp4Samples[mp4Samples.length - 1].duration as number;
        } else {
          // the only one sample, use reference sample duration
          sampleDuration = Math.floor(this._videoMeta?.refSampleDuration ?? 0);
        }
      }

      if (sampleDuration <= 0) {
        // Spliced streams (e.g. telco catchup recordings) can regress dts mid-batch. A
        // non-positive duration would be written into the trun box as a huge unsigned
        // value and trigger a decode error, so clamp it to keep the timeline monotonic.
        const fallbackDuration =
          Math.floor(this._videoMeta?.refSampleDuration ?? 0) ||
          (mp4Samples.length >= 1 ? (mp4Samples[mp4Samples.length - 1].duration as number) : 0) ||
          40;
        Log.w(
          this.TAG,
          `Video: non-monotonic dts detected (dts: ${dts} ms, duration: ${Math.round(sampleDuration)} ms), ` +
            `clamping sample duration to ${fallbackDuration} ms`,
        );
        // Re-anchor the remaining samples of this batch so their dts continue right
        // after the clamped sample (mirrors the inter-batch dtsCorrection behavior)
        dtsCorrection = (dtsCorrection as number) + (sampleDuration - fallbackDuration);
        sampleDuration = fallbackDuration;
      }

      if (isKeyframe) {
        const syncPoint = new SampleInfo(dts, pts, sampleDuration, sample.dts, true);
        syncPoint.fileposition = sample.fileposition ?? null;
        info.appendSyncPoint(syncPoint);
      }

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

    // allocate mdatbox
    mdatbox = new Uint8Array(mdatBytes);
    mdatbox[0] = (mdatBytes >>> 24) & 0xff;
    mdatbox[1] = (mdatBytes >>> 16) & 0xff;
    mdatbox[2] = (mdatBytes >>> 8) & 0xff;
    mdatbox[3] = mdatBytes & 0xff;
    mdatbox.set(MP4.types.mdat, 4);

    // Write samples into mdatbox
    for (let i = 0; i < mp4Samples.length; i++) {
      const units = mp4Samples[i].units as Array<{ data: Uint8Array }>;
      while (units.length) {
        const unit = units.shift() as { data: Uint8Array };
        const data = unit.data;
        mdatbox.set(data, offset);
        offset += data.byteLength;
      }
    }

    const latest = mp4Samples[mp4Samples.length - 1];
    lastDts = latest.dts + latest.duration;
    lastPts = latest.pts + latest.duration;
    this._videoNextDts = lastDts;

    // fill media segment info & add to info list
    info.beginDts = firstDts;
    info.endDts = lastDts;
    info.beginPts = firstPts;
    info.endPts = lastPts;
    info.originalBeginDts = mp4Samples[0].originalDts;
    info.originalEndDts = latest.originalDts + latest.duration;
    info.firstSample = new SampleInfo(
      mp4Samples[0].dts,
      mp4Samples[0].pts,
      mp4Samples[0].duration,
      mp4Samples[0].originalDts,
      mp4Samples[0].isKeyframe ?? false,
    );
    info.lastSample = new SampleInfo(
      latest.dts,
      latest.pts,
      latest.duration,
      latest.originalDts,
      latest.isKeyframe ?? false,
    );
    track.samples = mp4Samples;
    track.sequenceNumber++;

    const moofbox = MP4.moof(track as unknown as import("./mp4-generator").MP4Track, firstDts);
    track.samples = [];
    track.length = 0;

    this._onMediaSegment?.("video", {
      type: "video",
      data: this._mergeBoxes(moofbox, mdatbox).buffer,
      sampleCount: mp4Samples.length,
      info: info,
    });
  }

  private _mergeBoxes(moof: Uint8Array, mdat: Uint8Array): Uint8Array {
    const result = new Uint8Array(moof.byteLength + mdat.byteLength);
    result.set(moof, 0);
    result.set(mdat, moof.byteLength);
    return result;
  }
}

export default MP4Remuxer;

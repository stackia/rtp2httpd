import { IllegalStateException } from "../utils/exception";
import Log from "../utils/logger";
import { AACADTSParser, type AACFrame, AACLOASParser, AudioSpecificConfig, type LOASAACFrame } from "./aac";
import { AC3Config, type AC3Frame, AC3Parser, EAC3Config, type EAC3Frame, EAC3Parser } from "./ac3";
import {
  AVCDecoderConfigurationRecord,
  H264AnnexBParser,
  H264NaluAVC1,
  type H264NaluPayload,
  H264NaluType,
} from "./h264";
import {
  H265AnnexBParser,
  H265NaluHVC1,
  type H265NaluPayload,
  H265NaluType,
  HEVCDecoderConfigurationRecord,
} from "./h265";
import H265Parser from "./h265-parser";
import { MP3Data } from "./mp3";
import { type MPEG4AudioObjectTypes, MPEG4SamplingFrequencies, type MPEG4SamplingFrequencyIndex } from "./mpeg4-audio";
import {
  PAT,
  PESData,
  type PIDToSliceQueues,
  PMT,
  type ProgramToPMTMap,
  SectionData,
  SliceQueue,
  StreamType,
} from "./pat-pmt-pes";
import SPSParser from "./sps-parser";

export interface TSProbeResult {
  match: boolean;
  needMoreData?: boolean;
  consumed?: number;
  ts_packet_size?: number;
  sync_offset?: number;
}

interface TSSliceMisc {
  pid: number;
  file_position: number;
  payload_unit_start_indicator: number;
  continuity_conunter: number;
  random_access_indicator?: number;
  stream_type?: StreamType;
}

type AdaptationFieldInfo = {
  discontinuity_indicator?: number;
  random_access_indicator?: number;
  elementary_stream_priority_indicator?: number;
};
type CommonPidKey = keyof PMT["common_pids"];
type TSDemuxerOptions = {
  waitForInitialVideoKeyframe?: boolean;
};
type TSSegmentBoundaryOptions = {
  resetAudioParserState?: boolean;
};
type AACAudioMetadata = {
  codec: "aac";
  audio_object_type: MPEG4AudioObjectTypes;
  sampling_freq_index: MPEG4SamplingFrequencyIndex;
  sampling_frequency: number;
  channel_config: number;
};
type AC3AudioMetadata = {
  codec: "ac-3";
  sampling_frequency: number;
  bit_stream_identification: number;
  bit_stream_mode: number;
  low_frequency_effects_channel_on: number;
  channel_mode: number;
};
type EAC3AudioMetadata = {
  codec: "ec-3";
  sampling_frequency: number;
  bit_stream_identification: number;
  low_frequency_effects_channel_on: number;
  channel_mode: number;
  num_blks: number;
};
type MP3AudioMetadata = {
  codec: "mp3";
  object_type: number;
  sample_rate: number;
  channel_count: number;
};
type AudioData =
  | {
      codec: "aac";
      data: AACFrame;
    }
  | {
      codec: "ac-3";
      data: AC3Frame;
    }
  | {
      codec: "ec-3";
      data: EAC3Frame;
    }
  | {
      codec: "mp3";
      data: MP3Data;
    };

const VIDEO_PID_KEYS: readonly CommonPidKey[] = ["h264", "h265"];
const AUDIO_PID_KEYS: readonly CommonPidKey[] = ["adts_aac", "loas_aac", "ac3", "eac3", "mp3"];

export type OnErrorCallback = (type: string, info: string) => void;
export type OnTrackMetadataCallback = (type: string, metadata: unknown) => void;
export type OnDataAvailableCallback = (audioTrack: unknown, videoTrack: unknown, force?: boolean) => void;
export type OnTrackDiscontinuityCallback = (track: "audio" | "video") => void;

class TSDemuxer {
  private readonly TAG: string = "TSDemuxer";

  public onError: OnErrorCallback | null = null;
  public onTrackMetadata: OnTrackMetadataCallback | null = null;
  public onDataAvailable: OnDataAvailableCallback | null = null;
  public onTrackDiscontinuity: OnTrackDiscontinuityCallback | null = null;
  /** Software audio decode support (MP2) */
  public onRawAudioData: ((frame: { codec: "mp2"; data: Uint8Array; pts: number }) => void) | null = null;

  private ts_packet_size_: number;
  private sync_offset_: number;
  private first_parse_: boolean = true;

  private readonly timescale_ = 90;

  private pat_!: PAT;
  private current_program_!: number;
  private current_pmt_pid_: number = -1;
  private pmt_!: PMT;
  private program_pmt_map_: ProgramToPMTMap = {};

  private pes_slice_queues_: PIDToSliceQueues = {};
  private section_slice_queues_: PIDToSliceQueues = {};
  private continuity_counters_: Record<number, number | undefined> = {};

  private video_metadata_: {
    vps: H265NaluHVC1 | undefined;
    sps: H264NaluAVC1 | H265NaluHVC1 | undefined;
    pps: H264NaluAVC1 | H265NaluHVC1 | undefined;
    details: Record<string, unknown>;
  } = {
    vps: undefined,
    sps: undefined,
    pps: undefined,
    details: {} as Record<string, unknown>,
  };

  private audio_metadata_: AACAudioMetadata | AC3AudioMetadata | EAC3AudioMetadata | MP3AudioMetadata = {
    codec: undefined as unknown as "aac",
    audio_object_type: undefined as unknown as MPEG4AudioObjectTypes,
    sampling_freq_index: undefined as unknown as MPEG4SamplingFrequencyIndex,
    sampling_frequency: undefined as unknown as number,
    channel_config: undefined as unknown as number,
  };

  private last_pcr_base_: number = NaN;
  private timestamp_offset_: number = 0;

  private audio_last_sample_pts_: number | undefined = undefined;
  private aac_last_incomplete_data_: Uint8Array | null = null;
  private ac3_last_incomplete_data_: Uint8Array | null = null;
  private eac3_last_incomplete_data_: Uint8Array | null = null;

  private has_video_ = false;
  private has_audio_ = false;
  private video_init_segment_dispatched_ = false;
  private audio_init_segment_dispatched_ = false;
  private video_metadata_changed_ = false;
  private video_output_started_ = false;
  private video_discontinuity_pending_ = false;
  private loas_previous_frame: LOASAACFrame | null = null;

  private soft_decode_audio_codec_: "mp2" | null = null;
  private audio_drop_until_sync_ = false;
  private drop_video_until_keyframe_ = true;

  private video_track_ = {
    type: "video",
    id: 1,
    sequenceNumber: 0,
    samples: [] as Record<string, unknown>[],
    length: 0,
  };
  private audio_track_ = {
    type: "audio",
    id: 2,
    sequenceNumber: 0,
    samples: [] as Record<string, unknown>[],
    length: 0,
  };

  public set timestampBase(value: number) {
    this.timestamp_offset_ = value;
  }

  public constructor(probe_data: TSProbeResult, options: TSDemuxerOptions = {}) {
    this.ts_packet_size_ = probe_data.ts_packet_size as number;
    this.sync_offset_ = probe_data.sync_offset as number;
    if (options.waitForInitialVideoKeyframe === false) {
      this.drop_video_until_keyframe_ = false;
      this.video_output_started_ = true;
    }
  }

  public destroy() {
    this.pes_slice_queues_ = {};
    this.section_slice_queues_ = {};

    this.video_metadata_ = null as unknown as typeof this.video_metadata_;
    this.audio_metadata_ = null as unknown as typeof this.audio_metadata_;
    this.aac_last_incomplete_data_ = null;
    this.ac3_last_incomplete_data_ = null;
    this.eac3_last_incomplete_data_ = null;

    this.video_track_ = null as unknown as typeof this.video_track_;
    this.audio_track_ = null as unknown as typeof this.audio_track_;

    this.onError = null;
    this.onTrackMetadata = null;
    this.onDataAvailable = null;
    this.onTrackDiscontinuity = null;
    this.onRawAudioData = null;
    this.soft_decode_audio_codec_ = null;
  }

  public resetSegmentBoundary(probe_data?: TSProbeResult, options: TSSegmentBoundaryOptions = {}): void {
    if (probe_data) {
      this.ts_packet_size_ = probe_data.ts_packet_size as number;
      this.sync_offset_ = probe_data.sync_offset as number;
    }
    this.first_parse_ = true;
    this.pes_slice_queues_ = {};
    this.section_slice_queues_ = {};
    this.continuity_counters_ = {};
    if (options.resetAudioParserState === true) {
      this.resetAudioParserState();
    }
  }

  public flushSegmentBoundary(): void {
    if (this.shouldWaitForVideoKeyframe() || !this.isInitSegmentDispatched()) {
      return;
    }
    if (this.audio_track_.length || this.video_track_.length) {
      this.onDataAvailable?.(this.audio_track_, this.video_track_, true);
    }
  }

  public static probe(data: Uint8Array): TSProbeResult {
    let sync_offset = -1;
    let ts_packet_size = 188;

    if (data.byteLength <= 3 * ts_packet_size) {
      return { match: false, needMoreData: true };
    }

    while (sync_offset === -1) {
      const scan_window = Math.min(1000, data.byteLength - 3 * ts_packet_size);

      for (let i = 0; i < scan_window; ) {
        // sync_byte should all be 0x47
        if (data[i] === 0x47 && data[i + ts_packet_size] === 0x47 && data[i + 2 * ts_packet_size] === 0x47) {
          sync_offset = i;
          break;
        } else {
          i++;
        }
      }

      // find sync_offset failed in previous ts_packet_size
      if (sync_offset === -1) {
        if (ts_packet_size === 188) {
          // try 192 packet size (BDAV, etc.)
          ts_packet_size = 192;
        } else if (ts_packet_size === 192) {
          // try 204 packet size (European DVB, etc.)
          ts_packet_size = 204;
        } else {
          // 192, 204 also failed, exit
          break;
        }
      }
    }

    if (sync_offset === -1) {
      // both 188, 192, 204 failed, Non MPEG-TS
      return { match: false };
    }

    if (ts_packet_size === 192 && sync_offset >= 4) {
      Log.v("TSDemuxer", `ts_packet_size = 192, m2ts mode`);
      sync_offset -= 4;
    } else if (ts_packet_size === 204) {
      Log.v("TSDemuxer", `ts_packet_size = 204, RS encoded MPEG2-TS stream`);
    }

    return {
      match: true,
      consumed: 0,
      ts_packet_size,
      sync_offset,
    };
  }

  private isCommonPid(pid: number, keys: readonly CommonPidKey[]): boolean {
    const commonPids = this.pmt_?.common_pids;
    return !!commonPids && keys.some((key) => commonPids[key] === pid);
  }

  private isVideoPid(pid: number): boolean {
    return this.isCommonPid(pid, VIDEO_PID_KEYS);
  }

  private isAudioPid(pid: number): boolean {
    return this.isCommonPid(pid, AUDIO_PID_KEYS);
  }

  private isMediaPid(pid: number): boolean {
    return this.isVideoPid(pid) || this.isAudioPid(pid);
  }

  private resetAudioParserState(): void {
    this.audio_last_sample_pts_ = undefined;
    this.aac_last_incomplete_data_ = null;
    this.ac3_last_incomplete_data_ = null;
    this.eac3_last_incomplete_data_ = null;
    this.loas_previous_frame = null;
    this.audio_drop_until_sync_ = true;
  }

  private clearAudioTrack(): void {
    this.audio_track_.samples = [];
    this.audio_track_.length = 0;
  }

  private clearVideoTrack(): void {
    this.video_track_.samples = [];
    this.video_track_.length = 0;
  }

  private clearAudioPESQueues(): void {
    const commonPids = this.pmt_?.common_pids;
    if (!commonPids) {
      return;
    }

    for (const key of AUDIO_PID_KEYS) {
      const pid = commonPids[key];
      if (pid !== undefined) {
        delete this.pes_slice_queues_[pid];
      }
    }
  }

  private shouldWaitForVideoKeyframe(): boolean {
    return this.has_video_ && !this.video_output_started_;
  }

  private flushMediaBeforeTrackDiscontinuity(): void {
    if (this.shouldWaitForVideoKeyframe() || !this.isInitSegmentDispatched()) {
      return;
    }
    if (this.audio_track_.length || this.video_track_.length) {
      this.onDataAvailable?.(this.audio_track_, this.video_track_, true);
    }
  }

  private resumeVideoOutputFromKeyframe(): void {
    const reason = this.video_discontinuity_pending_ ? "after TS discontinuity; resuming" : "at stream start; starting";
    this.drop_video_until_keyframe_ = false;
    this.video_output_started_ = true;
    this.video_discontinuity_pending_ = false;
    this.clearAudioTrack();
    this.resetAudioParserState();
    Log.v(this.TAG, `Video keyframe found ${reason} video output timeline`);
  }

  private handleTrackDiscontinuity(pid: number, reason: string): void {
    delete this.pes_slice_queues_[pid];

    if (this.isVideoPid(pid)) {
      this.flushMediaBeforeTrackDiscontinuity();
      this.clearVideoTrack();
      this.drop_video_until_keyframe_ = true;
      this.video_output_started_ = false;
      this.video_discontinuity_pending_ = true;
      this.clearAudioTrack();
      this.clearAudioPESQueues();
      this.resetAudioParserState();
      Log.w(this.TAG, `Video TS discontinuity on pid ${pid}: ${reason}; dropping until keyframe`);
      this.onTrackDiscontinuity?.("video");
      return;
    }

    if (this.isAudioPid(pid)) {
      this.flushMediaBeforeTrackDiscontinuity();
      this.resetAudioParserState();
      Log.w(this.TAG, `Audio TS discontinuity on pid ${pid}: ${reason}; resetting audio parser state`);
      this.onTrackDiscontinuity?.("audio");
    }
  }

  private shouldProcessPayload(pid: number, continuityCounter: number, discontinuityIndicator?: number): boolean {
    if (discontinuityIndicator === 1) {
      this.continuity_counters_[pid] = continuityCounter;
      this.handleTrackDiscontinuity(pid, "discontinuity indicator");
      return true;
    }

    const lastCounter = this.continuity_counters_[pid];
    if (lastCounter === undefined) {
      this.continuity_counters_[pid] = continuityCounter;
      return true;
    }

    if (continuityCounter === lastCounter) {
      Log.w(this.TAG, `Duplicate TS packet on pid ${pid} with continuity counter ${continuityCounter}; skipping`);
      return false;
    }

    const expected = (lastCounter + 1) & 0x0f;
    if (continuityCounter !== expected) {
      this.handleTrackDiscontinuity(pid, `expected continuity counter ${expected}, got ${continuityCounter}`);
    }

    this.continuity_counters_[pid] = continuityCounter;
    return true;
  }

  public parseChunks(chunk: Uint8Array, byte_start: number): number {
    if (!this.onError || !this.onTrackMetadata || !this.onDataAvailable) {
      throw new IllegalStateException("onError & onTrackMetadata & onDataAvailable callback must be specified");
    }

    let offset = 0;

    if (this.first_parse_) {
      this.first_parse_ = false;
      offset = this.sync_offset_;
    }

    while (offset + this.ts_packet_size_ <= chunk.byteLength) {
      const file_position = byte_start + offset;

      if (this.ts_packet_size_ === 192) {
        // skip ATS field (2-bits copy-control + 30-bits timestamp) for m2ts
        offset += 4;
      }

      const data = chunk.subarray(offset, offset + 188);

      const sync_byte = data[0];
      if (sync_byte !== 0x47) {
        Log.e(this.TAG, `sync_byte = ${sync_byte}, not 0x47`);
        break;
      }

      const payload_unit_start_indicator = (data[1] & 0x40) >>> 6;
      const pid = ((data[1] & 0x1f) << 8) | data[2];
      const adaptation_field_control = (data[3] & 0x30) >>> 4;
      const continuity_conunter = data[3] & 0x0f;

      const is_pcr_pid: boolean = !!(this.pmt_ && this.pmt_.pcr_pid === pid);
      const adaptation_field_info: AdaptationFieldInfo = {};
      let ts_payload_start_index = 4;

      if (adaptation_field_control === 0x02 || adaptation_field_control === 0x03) {
        // Adaptation field exists along with / without payload
        const adaptation_field_length = data[4];
        if (adaptation_field_length > 0 && (is_pcr_pid || adaptation_field_control === 0x03)) {
          // Parse adaptation field
          adaptation_field_info.discontinuity_indicator = (data[5] & 0x80) >>> 7;
          adaptation_field_info.random_access_indicator = (data[5] & 0x40) >>> 6;
          adaptation_field_info.elementary_stream_priority_indicator = (data[5] & 0x20) >>> 5;

          const PCR_flag = (data[5] & 0x10) >>> 4;
          if (PCR_flag) {
            // track PCR base for pts/dts wraparound detection
            this.getPcrBase(data);
          }
        }
        if (adaptation_field_control === 0x02 || 5 + adaptation_field_length === 188) {
          // TS packet only has adaption field, jump to next
          offset += 188;
          if (this.ts_packet_size_ === 204) {
            // skip parity word (16 bytes) for RS encoded TS
            offset += 16;
          }
          continue;
        } else {
          // Point ts_payload_start_index to the start of payload
          ts_payload_start_index = 4 + 1 + adaptation_field_length;
        }
      }

      if (adaptation_field_control === 0x01 || adaptation_field_control === 0x03) {
        if (
          pid === 0 || // PAT (pid === 0)
          pid === this.current_pmt_pid_ // PMT
        ) {
          const ts_payload_length = 188 - ts_payload_start_index;

          this.handleSectionSlice(chunk, offset + ts_payload_start_index, ts_payload_length, {
            pid,
            file_position,
            payload_unit_start_indicator,
            continuity_conunter,
            random_access_indicator: adaptation_field_info.random_access_indicator,
          });
        } else if (this.pmt_ !== undefined && this.pmt_.pid_stream_type[pid] !== undefined) {
          // PES
          const ts_payload_length = 188 - ts_payload_start_index;
          const stream_type = this.pmt_.pid_stream_type[pid];

          // process PES only for known common_pids
          if (this.isMediaPid(pid)) {
            if (!this.shouldProcessPayload(pid, continuity_conunter, adaptation_field_info.discontinuity_indicator)) {
              offset += 188;
              if (this.ts_packet_size_ === 204) {
                offset += 16;
              }
              continue;
            }
            this.handlePESSlice(chunk, offset + ts_payload_start_index, ts_payload_length, {
              pid,
              stream_type,
              file_position,
              payload_unit_start_indicator,
              continuity_conunter,
              random_access_indicator: adaptation_field_info.random_access_indicator,
            });
          }
        }
      }

      offset += 188;

      if (this.ts_packet_size_ === 204) {
        // skip parity word (16 bytes) for RS encoded TS
        offset += 16;
      }
    }

    // dispatch parsed frames to the remuxer (consumer)
    this.dispatchAudioVideoMediaSegment();

    return offset; // consumed bytes
  }

  private handleSectionSlice(buffer: Uint8Array, offset: number, length: number, misc: TSSliceMisc): void {
    const data = buffer.subarray(offset, offset + length);
    let slice_queue = this.section_slice_queues_[misc.pid];

    if (misc.payload_unit_start_indicator) {
      const pointer_field = data[0];

      if (slice_queue !== undefined && slice_queue.total_length !== 0) {
        const remain_section = buffer.subarray(offset + 1, offset + 1 + Math.min(length, pointer_field));
        slice_queue.slices.push(remain_section);
        slice_queue.total_length += remain_section.byteLength;

        if (slice_queue.total_length === slice_queue.expected_length) {
          this.emitSectionSlices(slice_queue, misc);
        } else {
          this.clearSlices(slice_queue);
        }
      }

      for (let i = 1 + pointer_field; i < data.byteLength; ) {
        const table_id = data[i + 0];
        if (table_id === 0xff) {
          break;
        }

        const section_length = ((data[i + 1] & 0x0f) << 8) | data[i + 2];

        this.section_slice_queues_[misc.pid] = new SliceQueue();
        slice_queue = this.section_slice_queues_[misc.pid];

        slice_queue.expected_length = section_length + 3;
        slice_queue.file_position = misc.file_position;
        slice_queue.random_access_indicator = misc.random_access_indicator ?? 0;

        const remain_length = Math.min(length - i, slice_queue.expected_length - slice_queue.total_length);
        const remain_section = buffer.subarray(offset + i, offset + i + remain_length);
        slice_queue.slices.push(remain_section);
        slice_queue.total_length += remain_section.byteLength;

        if (slice_queue.total_length === slice_queue.expected_length) {
          this.emitSectionSlices(slice_queue, misc);
        } else if (slice_queue.total_length >= slice_queue.expected_length) {
          this.clearSlices(slice_queue);
        }

        i += remain_section.byteLength;
      }
    } else if (slice_queue !== undefined && slice_queue.total_length !== 0) {
      const remain_length = Math.min(length, slice_queue.expected_length - slice_queue.total_length);
      const remain_section = buffer.subarray(offset, offset + remain_length);
      slice_queue.slices.push(remain_section);
      slice_queue.total_length += remain_section.byteLength;

      if (slice_queue.total_length === slice_queue.expected_length) {
        this.emitSectionSlices(slice_queue, misc);
      } else if (slice_queue.total_length >= slice_queue.expected_length) {
        this.clearSlices(slice_queue);
      }
    }
  }

  private handlePESSlice(buffer: Uint8Array, offset: number, length: number, misc: TSSliceMisc): void {
    const data = buffer.subarray(offset, offset + length);

    const packet_start_code_prefix = (data[0] << 16) | (data[1] << 8) | data[2];
    const PES_packet_length = (data[4] << 8) | data[5];

    if (misc.payload_unit_start_indicator) {
      if (packet_start_code_prefix !== 1) {
        Log.e(
          this.TAG,
          `handlePESSlice: packet_start_code_prefix should be 1 but with value ${packet_start_code_prefix}`,
        );
        return;
      }

      // handle queued PES slices:
      // Merge into a big Uint8Array then call parsePES()
      const slice_queue = this.pes_slice_queues_[misc.pid];
      if (slice_queue) {
        if (slice_queue.expected_length === 0 || slice_queue.expected_length === slice_queue.total_length) {
          this.emitPESSlices(slice_queue, misc);
        } else {
          this.clearSlices(slice_queue);
        }
      }

      // Make a new PES queue for new PES slices
      this.pes_slice_queues_[misc.pid] = new SliceQueue();
      this.pes_slice_queues_[misc.pid].file_position = misc.file_position;
      this.pes_slice_queues_[misc.pid].random_access_indicator = misc.random_access_indicator ?? 0;
    }

    if (this.pes_slice_queues_[misc.pid] === undefined) {
      // ignore PES slices without [PES slice that has payload_unit_start_indicator]
      return;
    }

    // push subsequent PES slices into pes_queue
    const slice_queue = this.pes_slice_queues_[misc.pid];
    slice_queue.slices.push(data);
    if (misc.payload_unit_start_indicator) {
      slice_queue.expected_length = PES_packet_length === 0 ? 0 : PES_packet_length + 6;
    }
    slice_queue.total_length += data.byteLength;

    if (slice_queue.expected_length > 0 && slice_queue.expected_length === slice_queue.total_length) {
      this.emitPESSlices(slice_queue, misc);
    } else if (slice_queue.expected_length > 0 && slice_queue.expected_length < slice_queue.total_length) {
      this.clearSlices(slice_queue);
    }
  }

  private emitSectionSlices(slice_queue: SliceQueue, misc: TSSliceMisc): void {
    const data = new Uint8Array(slice_queue.total_length);
    for (let i = 0, offset = 0; i < slice_queue.slices.length; i++) {
      const slice = slice_queue.slices[i];
      data.set(slice, offset);
      offset += slice.byteLength;
    }
    slice_queue.slices = [];
    slice_queue.expected_length = -1;
    slice_queue.total_length = 0;

    const section_data = new SectionData();
    section_data.pid = misc.pid;
    section_data.data = data;
    section_data.file_position = slice_queue.file_position;
    section_data.random_access_indicator = slice_queue.random_access_indicator;
    this.parseSection(section_data);
  }

  private emitPESSlices(slice_queue: SliceQueue, misc: TSSliceMisc): void {
    const data = new Uint8Array(slice_queue.total_length);
    for (let i = 0, offset = 0; i < slice_queue.slices.length; i++) {
      const slice = slice_queue.slices[i];
      data.set(slice, offset);
      offset += slice.byteLength;
    }
    slice_queue.slices = [];
    slice_queue.expected_length = -1;
    slice_queue.total_length = 0;

    const pes_data = new PESData();
    pes_data.pid = misc.pid;
    pes_data.data = data;
    pes_data.stream_type = misc.stream_type as StreamType;
    pes_data.file_position = slice_queue.file_position;
    pes_data.random_access_indicator = slice_queue.random_access_indicator;
    this.parsePES(pes_data);
  }

  private clearSlices(slice_queue: SliceQueue): void {
    slice_queue.slices = [];
    slice_queue.expected_length = -1;
    slice_queue.total_length = 0;
  }

  private parseSection(section_data: SectionData): void {
    const data = section_data.data;
    const pid = section_data.pid;

    if (pid === 0x00) {
      this.parsePAT(data);
    } else if (pid === this.current_pmt_pid_) {
      this.parsePMT(data);
    }
  }

  private parsePES(pes_data: PESData): void {
    const data = pes_data.data;
    const packet_start_code_prefix = (data[0] << 16) | (data[1] << 8) | data[2];
    const stream_id = data[3];
    const PES_packet_length = (data[4] << 8) | data[5];

    if (packet_start_code_prefix !== 1) {
      Log.e(this.TAG, `parsePES: packet_start_code_prefix should be 1 but with value ${packet_start_code_prefix}`);
      return;
    }

    if (
      stream_id === 0xbc || // program_stream_map
      stream_id === 0xbe || // padding_stream
      stream_id === 0xbf || // private_stream_2
      stream_id === 0xf0 || // ECM
      stream_id === 0xf1 || // EMM
      stream_id === 0xff || // program_stream_directory
      stream_id === 0xf2 || // DSMCC
      stream_id === 0xf8
    ) {
      return;
    }

    const PTS_DTS_flags = (data[7] & 0xc0) >>> 6;
    const PES_header_data_length = data[8];

    let pts: number | undefined;
    let dts: number | undefined;

    if (PTS_DTS_flags === 0x02 || PTS_DTS_flags === 0x03) {
      pts = this.getTimestamp(data, 9);
      dts = PTS_DTS_flags === 0x03 ? this.getTimestamp(data, 14) : pts;
    }

    const payload_start_index = 6 + 3 + PES_header_data_length;
    let payload_length: number;

    if (PES_packet_length !== 0) {
      if (PES_packet_length < 3 + PES_header_data_length) {
        Log.v(this.TAG, `Malformed PES: PES_packet_length < 3 + PES_header_data_length`);
        return;
      }
      payload_length = PES_packet_length - 3 - PES_header_data_length;
    } else {
      // PES_packet_length === 0
      payload_length = data.byteLength - payload_start_index;
    }

    const payload = data.subarray(payload_start_index, payload_start_index + payload_length);

    switch (pes_data.stream_type) {
      case StreamType.kMPEG1Audio:
      case StreamType.kMPEG2Audio:
        this.parseMP3Payload(payload, pts);
        break;
      case StreamType.kPESPrivateData:
        if (this.pmt_.common_pids.ac3 === pes_data.pid) {
          this.parseAC3Payload(payload, pts);
        } else if (this.pmt_.common_pids.eac3 === pes_data.pid) {
          this.parseEAC3Payload(payload, pts);
        }
        break;
      case StreamType.kADTSAAC:
        this.parseADTSAACPayload(payload, pts);
        break;
      case StreamType.kLOASAAC:
        this.parseLOASAACPayload(payload, pts);
        break;
      case StreamType.kAC3:
        this.parseAC3Payload(payload, pts);
        break;
      case StreamType.kEAC3:
        this.parseEAC3Payload(payload, pts);
        break;
      case StreamType.kH264:
        this.parseH264Payload(payload, pts, dts, pes_data.file_position, pes_data.random_access_indicator);
        break;
      case StreamType.kH265:
        this.parseH265Payload(payload, pts, dts, pes_data.file_position, pes_data.random_access_indicator);
        break;
      default:
        break;
    }
  }

  private parsePAT(data: Uint8Array): void {
    const table_id = data[0];
    if (table_id !== 0x00) {
      Log.e(this.TAG, `parsePAT: table_id ${table_id} is not corresponded to PAT!`);
      return;
    }

    const section_length = ((data[1] & 0x0f) << 8) | data[2];

    const version_number = (data[5] & 0x3e) >>> 1;
    const current_next_indicator = data[5] & 0x01;
    const section_number = data[6];

    let pat: PAT | null = null;

    if (current_next_indicator === 1 && section_number === 0) {
      pat = new PAT();
      pat.version_number = version_number;
    } else {
      pat = this.pat_;
      if (pat === undefined) {
        return;
      }
    }

    const program_start_index = 8;
    const program_bytes = section_length - 5 - 4; // section_length - (headers + crc)
    let first_program_number = -1;
    let first_pmt_pid = -1;

    for (let i = program_start_index; i < program_start_index + program_bytes; i += 4) {
      const program_number = (data[i] << 8) | data[i + 1];
      const pid = ((data[i + 2] & 0x1f) << 8) | data[i + 3];

      if (program_number === 0) {
        // network_PID
        pat.network_pid = pid;
      } else {
        // program_map_PID
        pat.program_pmt_pid[program_number] = pid;

        if (first_program_number === -1) {
          first_program_number = program_number;
        }

        if (first_pmt_pid === -1) {
          first_pmt_pid = pid;
        }
      }
    }

    // Currently we only deal with first appeared PMT pid
    if (current_next_indicator === 1 && section_number === 0) {
      if (this.pat_ === undefined) {
        Log.v(this.TAG, `Parsed first PAT: ${JSON.stringify(pat)}`);
      }
      this.pat_ = pat;
      this.current_program_ = first_program_number;
      this.current_pmt_pid_ = first_pmt_pid;
    }
  }

  private parsePMT(data: Uint8Array): void {
    const table_id = data[0];
    if (table_id !== 0x02) {
      Log.e(this.TAG, `parsePMT: table_id ${table_id} is not corresponded to PMT!`);
      return;
    }

    const section_length = ((data[1] & 0x0f) << 8) | data[2];

    const program_number = (data[3] << 8) | data[4];
    const version_number = (data[5] & 0x3e) >>> 1;
    const current_next_indicator = data[5] & 0x01;
    const section_number = data[6];

    let pmt: PMT | null = null;

    if (current_next_indicator === 1 && section_number === 0) {
      pmt = new PMT();
      pmt.program_number = program_number;
      pmt.version_number = version_number;
      this.program_pmt_map_[program_number] = pmt;
    } else {
      pmt = this.program_pmt_map_[program_number];
      if (pmt === undefined) {
        return;
      }
    }

    pmt.pcr_pid = ((data[8] & 0x1f) << 8) | data[9];
    const program_info_length = ((data[10] & 0x0f) << 8) | data[11];

    const info_start_index = 12 + program_info_length;
    const info_bytes = section_length - 9 - program_info_length - 4;

    for (let i = info_start_index; i < info_start_index + info_bytes; ) {
      const stream_type = data[i] as StreamType;
      const elementary_PID = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
      const ES_info_length = ((data[i + 3] & 0x0f) << 8) | data[i + 4];

      pmt.pid_stream_type[elementary_PID] = stream_type;

      const already_has_video = pmt.common_pids.h264 || pmt.common_pids.h265;
      const already_has_audio =
        pmt.common_pids.adts_aac ||
        pmt.common_pids.loas_aac ||
        pmt.common_pids.ac3 ||
        pmt.common_pids.eac3 ||
        pmt.common_pids.mp3;

      if (stream_type === StreamType.kH264 && !already_has_video) {
        pmt.common_pids.h264 = elementary_PID;
      } else if (stream_type === StreamType.kH265 && !already_has_video) {
        pmt.common_pids.h265 = elementary_PID;
      } else if (stream_type === StreamType.kADTSAAC && !already_has_audio) {
        pmt.common_pids.adts_aac = elementary_PID;
      } else if (stream_type === StreamType.kLOASAAC && !already_has_audio) {
        pmt.common_pids.loas_aac = elementary_PID;
      } else if (stream_type === StreamType.kAC3 && !already_has_audio) {
        pmt.common_pids.ac3 = elementary_PID; // ATSC AC-3
      } else if (stream_type === StreamType.kEAC3 && !already_has_audio) {
        pmt.common_pids.eac3 = elementary_PID; // ATSC EAC-3
      } else if (
        (stream_type === StreamType.kMPEG1Audio || stream_type === StreamType.kMPEG2Audio) &&
        !already_has_audio
      ) {
        pmt.common_pids.mp3 = elementary_PID;
      } else if (stream_type === StreamType.kPESPrivateData && ES_info_length > 0) {
        // parse descriptors to detect DVB AC-3 / E-AC-3 in private PES
        for (let offset = i + 5; offset < i + 5 + ES_info_length; ) {
          const tag = data[offset + 0];
          const length = data[offset + 1];
          if (tag === 0x05) {
            // Registration Descriptor
            const registration = String.fromCharCode(...Array.from(data.subarray(offset + 2, offset + 2 + length)));
            if (registration === "AC-3" && !already_has_audio) {
              pmt.common_pids.ac3 = elementary_PID; // DVB AC-3
            } else if (registration === "EC-3" && !already_has_audio) {
              pmt.common_pids.eac3 = elementary_PID; // DVB EAC-3
            }
          } else if (tag === 0x82) {
            pmt.common_pids.ac3 = elementary_PID;
          } else if (tag === 0x7a) {
            pmt.common_pids.eac3 = elementary_PID;
          }
          offset += 2 + length;
        }
      }

      i += 5 + ES_info_length;
    }

    if (program_number === this.current_program_) {
      if (this.pmt_ === undefined) {
        Log.v(this.TAG, `Parsed first PMT: ${JSON.stringify(pmt)}`);
      }
      this.pmt_ = pmt;
      if (pmt.common_pids.h264 || pmt.common_pids.h265) {
        this.has_video_ = true;
      }
      if (
        pmt.common_pids.adts_aac ||
        pmt.common_pids.loas_aac ||
        pmt.common_pids.ac3 ||
        pmt.common_pids.eac3 ||
        pmt.common_pids.mp3
      ) {
        this.has_audio_ = true;
      }
    }
  }

  private parseH264Payload(
    data: Uint8Array,
    pts: number | undefined,
    dts: number | undefined,
    file_position: number,
    random_access_indicator: number,
  ) {
    const annexb_parser = new H264AnnexBParser(data);
    let nalu_payload: H264NaluPayload | null = null;
    const units: { type: H264NaluType; data: Uint8Array; lengthPrefixed: false }[] = [];
    let length = 0;
    let keyframe = false;

    nalu_payload = annexb_parser.readNextNaluPayload();
    while (nalu_payload != null) {
      if (nalu_payload.type === H264NaluType.kSliceSPS) {
        const nalu_avc1 = new H264NaluAVC1(nalu_payload);
        // Notice: parseSPS requires Nalu without startcode or length-header
        const details = SPSParser.parseSPS(nalu_payload.data) as unknown as Record<string, unknown>;
        if (!this.video_init_segment_dispatched_) {
          this.video_metadata_.sps = nalu_avc1;
          this.video_metadata_.details = details;
        } else if (this.detectVideoMetadataChange(details) === true) {
          Log.v(this.TAG, `H264: Critical h264 metadata has been changed, attempt to re-generate InitSegment`);
          this.video_metadata_changed_ = true;
          this.video_metadata_ = {
            vps: undefined,
            sps: nalu_avc1,
            pps: undefined,
            details: details,
          };
        }
      } else if (nalu_payload.type === H264NaluType.kSlicePPS) {
        const nalu_avc1 = new H264NaluAVC1(nalu_payload);
        if (!this.video_init_segment_dispatched_ || this.video_metadata_changed_) {
          this.video_metadata_.pps = nalu_avc1;
          if (this.video_metadata_.sps && this.video_metadata_.pps) {
            if (this.video_metadata_changed_) {
              // flush stashed frames before changing codec metadata
              this.dispatchVideoMediaSegment();
            }
            // notify new codec metadata (maybe changed)
            this.dispatchVideoInitSegment();
          }
        }
      } else if (nalu_payload.type === H264NaluType.kSliceIDR) {
        keyframe = true;
      } else if (nalu_payload.type === H264NaluType.kSliceNonIDR && random_access_indicator === 1) {
        // For open-gop stream, use random_access_indicator to identify keyframe
        keyframe = true;
      }

      // Push samples to remuxer only if initialization metadata has been dispatched
      if (this.video_init_segment_dispatched_) {
        units.push({ type: nalu_payload.type, data: nalu_payload.data, lengthPrefixed: false });
        length += 4 + nalu_payload.data.byteLength;
      }

      nalu_payload = annexb_parser.readNextNaluPayload();
    }

    if (pts == null || dts == null) {
      return;
    }
    const pts_ms = Math.floor(pts / this.timescale_);
    const dts_ms = Math.floor(dts / this.timescale_);

    if (this.drop_video_until_keyframe_ || !this.video_output_started_) {
      if (!keyframe || units.length === 0) {
        return;
      }
      this.resumeVideoOutputFromKeyframe();
    }

    if (units.length) {
      const track = this.video_track_;
      const avc_sample = {
        units,
        length,
        isKeyframe: keyframe,
        dts: dts_ms,
        pts: pts_ms,
        cts: pts_ms - dts_ms,
        file_position,
      };
      track.samples.push(avc_sample);
      track.length += length;
    }
  }

  private parseH265Payload(
    data: Uint8Array,
    pts: number | undefined,
    dts: number | undefined,
    file_position: number,
    random_access_indicator?: number,
  ) {
    const annexb_parser = new H265AnnexBParser(data);
    let nalu_payload: H265NaluPayload | null = null;
    const units: { type: H265NaluType; data: Uint8Array }[] = [];
    let length = 0;
    let keyframe = false;

    nalu_payload = annexb_parser.readNextNaluPayload();
    while (nalu_payload != null) {
      const nalu_hvc1 = new H265NaluHVC1(nalu_payload);

      if (nalu_hvc1.type === H265NaluType.kSliceVPS) {
        if (!this.video_init_segment_dispatched_) {
          const details = H265Parser.parseVPS(nalu_payload.data);
          this.video_metadata_.vps = nalu_hvc1;
          this.video_metadata_.details = {
            ...this.video_metadata_.details,
            ...details,
          };
        }
      } else if (nalu_hvc1.type === H265NaluType.kSliceSPS) {
        const details = H265Parser.parseSPS(nalu_payload.data) as unknown as Record<string, unknown>;
        if (!this.video_init_segment_dispatched_) {
          this.video_metadata_.sps = nalu_hvc1;
          this.video_metadata_.details = {
            ...this.video_metadata_.details,
            ...details,
          };
        } else if (this.detectVideoMetadataChange(details) === true) {
          Log.v(this.TAG, `H265: Critical h265 metadata has been changed, attempt to re-generate InitSegment`);
          this.video_metadata_changed_ = true;
          this.video_metadata_ = {
            vps: undefined,
            sps: nalu_hvc1,
            pps: undefined,
            details: details,
          };
        }
      } else if (nalu_hvc1.type === H265NaluType.kSlicePPS) {
        if (!this.video_init_segment_dispatched_ || this.video_metadata_changed_) {
          const details = H265Parser.parsePPS(nalu_payload.data);
          this.video_metadata_.pps = nalu_hvc1;
          this.video_metadata_.details = {
            ...this.video_metadata_.details,
            ...details,
          };

          if (this.video_metadata_.vps && this.video_metadata_.sps && this.video_metadata_.pps) {
            if (this.video_metadata_changed_) {
              // flush stashed frames before changing codec metadata
              this.dispatchVideoMediaSegment();
            }
            // notify new codec metadata (maybe changed)
            this.dispatchVideoInitSegment();
          }
        }
      } else if (
        nalu_hvc1.type === H265NaluType.kSliceIDR_W_RADL ||
        nalu_hvc1.type === H265NaluType.kSliceIDR_N_LP ||
        nalu_hvc1.type === H265NaluType.kSliceCRA_NUT
      ) {
        keyframe = true;
      } else if (random_access_indicator === 1) {
        keyframe = true;
      }

      // Push samples to remuxer only if initialization metadata has been dispatched
      if (this.video_init_segment_dispatched_) {
        units.push(nalu_hvc1);
        length += nalu_hvc1.data.byteLength;
      }

      nalu_payload = annexb_parser.readNextNaluPayload();
    }

    if (pts == null || dts == null) {
      return;
    }
    const pts_ms = Math.floor(pts / this.timescale_);
    const dts_ms = Math.floor(dts / this.timescale_);

    if (this.drop_video_until_keyframe_ || !this.video_output_started_) {
      if (!keyframe || units.length === 0) {
        return;
      }
      this.resumeVideoOutputFromKeyframe();
    }

    if (units.length) {
      const track = this.video_track_;
      const hvc_sample = {
        units,
        length,
        isKeyframe: keyframe,
        dts: dts_ms,
        pts: pts_ms,
        cts: pts_ms - dts_ms,
        file_position,
      };
      track.samples.push(hvc_sample);
      track.length += length;
    }
  }

  private detectVideoMetadataChange(new_details: Record<string, unknown>): boolean {
    const old_details = this.video_metadata_.details;
    if (new_details.codec_mimetype !== old_details.codec_mimetype) {
      Log.v(
        this.TAG,
        `Video: Codec mimeType changed from ${old_details.codec_mimetype} to ${new_details.codec_mimetype}`,
      );
      return true;
    }

    const new_codec_size = new_details.codec_size as Record<string, number>;
    const old_codec_size = old_details.codec_size as Record<string, number>;
    if (new_codec_size.width !== old_codec_size.width || new_codec_size.height !== old_codec_size.height) {
      Log.v(
        this.TAG,
        `Video: Coded Resolution changed from ` +
          `${old_codec_size.width}x${old_codec_size.height} to ${new_codec_size.width}x${new_codec_size.height}`,
      );
      return true;
    }

    const new_present_size = new_details.present_size as Record<string, number>;
    const old_present_size = old_details.present_size as Record<string, number>;
    if (new_present_size.width !== old_present_size.width) {
      Log.v(
        this.TAG,
        `Video: Present resolution width changed from ${old_present_size.width} to ${new_present_size.width}`,
      );
      return true;
    }

    return false;
  }

  private isInitSegmentDispatched(): boolean {
    if (this.has_video_ && this.has_audio_) {
      // both video & audio
      return this.video_init_segment_dispatched_ && this.audio_init_segment_dispatched_;
    }
    if (this.has_video_ && !this.has_audio_) {
      // video only
      return this.video_init_segment_dispatched_;
    }
    if (!this.has_video_ && this.has_audio_) {
      // audio only
      return this.audio_init_segment_dispatched_;
    }
    return false;
  }

  private dispatchVideoInitSegment() {
    const details = this.video_metadata_.details as Record<string, Record<string, unknown> & unknown>;
    const meta: Record<string, unknown> = {};

    meta.type = "video";
    meta.id = this.video_track_.id;
    meta.timescale = 1000;
    meta.duration = 0;

    const codec_size = details.codec_size as Record<string, number>;
    const present_size = details.present_size as Record<string, number>;
    const frame_rate = details.frame_rate as Record<string, unknown>;
    const sar_ratio = details.sar_ratio as Record<string, number>;

    meta.codecWidth = codec_size.width;
    meta.codecHeight = codec_size.height;
    meta.presentWidth = present_size.width;
    meta.presentHeight = present_size.height;

    meta.profile = details.profile_string;
    meta.level = details.level_string;
    meta.bitDepth = details.bit_depth;
    meta.chromaFormat = details.chroma_format;
    meta.sarRatio = sar_ratio;
    meta.frameRate = frame_rate;
    meta.colourPrimaries = details.colour_primaries;
    meta.transferCharacteristics = details.transfer_characteristics;
    meta.matrixCoefficients = details.matrix_coefficients;
    meta.videoFullRange = details.video_full_range_flag;

    const fps_den = frame_rate.fps_den as number;
    const fps_num = frame_rate.fps_num as number;
    meta.refSampleDuration = 1000 * (fps_den / fps_num);

    meta.codec = details.codec_mimetype;

    // Interlace hint from codec metadata: H.264 frame_mbs_only_flag == 0 or
    // H.265 field_seq/interlaced_source. Only a hint — many progressive
    // streams still set these — the render side verifies heuristically.
    meta.mayBeInterlaced =
      (details.frame_mbs_only_flag as unknown) === 0 || (details.interlaced_source as unknown) === true;

    if (this.video_metadata_.vps) {
      const vps_without_header = this.video_metadata_.vps.data.subarray(4);
      const sps_without_header = this.video_metadata_.sps?.data.subarray(4);
      const pps_without_header = this.video_metadata_.pps?.data.subarray(4);
      if (sps_without_header == null || pps_without_header == null) {
        return;
      }
      const hvcc = new HEVCDecoderConfigurationRecord(
        vps_without_header,
        sps_without_header,
        pps_without_header,
        details as unknown as import("./h265").HEVCDecoderConfigurationRecordType,
      );
      meta.hvcc = hvcc.getData();

      if (this.video_init_segment_dispatched_ === false) {
        Log.v(this.TAG, `Generated first HEVCDecoderConfigurationRecord for mimeType: ${meta.codec}`);
      }
    } else {
      const sps_without_header = this.video_metadata_.sps?.data.subarray(4);
      const pps_without_header = this.video_metadata_.pps?.data.subarray(4);
      if (sps_without_header == null || pps_without_header == null) {
        return;
      }
      const avcc = new AVCDecoderConfigurationRecord(sps_without_header, pps_without_header, details);
      meta.avcc = avcc.getData();

      if (this.video_init_segment_dispatched_ === false) {
        Log.v(this.TAG, `Generated first AVCDecoderConfigurationRecord for mimeType: ${meta.codec}`);
      }
    }
    this.onTrackMetadata?.("video", meta);
    this.video_init_segment_dispatched_ = true;
    this.video_metadata_changed_ = false;
  }

  private dispatchVideoMediaSegment() {
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }
    if (this.isInitSegmentDispatched()) {
      if (this.video_track_.length) {
        this.onDataAvailable?.(null, this.video_track_, true);
      }
    }
  }

  private dispatchAudioMediaSegment() {
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }
    if (this.isInitSegmentDispatched()) {
      if (this.audio_track_.length) {
        this.onDataAvailable?.(this.audio_track_, null, true);
      }
    }
  }

  private dispatchAudioVideoMediaSegment() {
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }
    if (this.isInitSegmentDispatched()) {
      if (this.audio_track_.length || this.video_track_.length) {
        this.onDataAvailable?.(this.audio_track_, this.video_track_);
      }
    }
  }

  private parseADTSAACPayload(data: Uint8Array, pts: number | undefined) {
    if (this.has_video_ && !this.video_init_segment_dispatched_) {
      // If first video IDR frame hasn't been detected,
      // Wait for first IDR frame and video init segment being dispatched
      return;
    }
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }

    if (this.aac_last_incomplete_data_) {
      const buf = new Uint8Array(data.byteLength + this.aac_last_incomplete_data_.byteLength);
      buf.set(this.aac_last_incomplete_data_, 0);
      buf.set(data, this.aac_last_incomplete_data_.byteLength);
      data = buf;
    }

    let ref_sample_duration: number;
    let base_pts_ms!: number;

    if (pts !== undefined) {
      base_pts_ms = pts / this.timescale_;
    }
    if (this.audio_metadata_.codec === "aac") {
      if (pts === undefined && this.audio_last_sample_pts_ !== undefined) {
        ref_sample_duration = (1024 / this.audio_metadata_.sampling_frequency) * 1000;
        base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
      } else if (pts === undefined) {
        Log.w(this.TAG, `AAC: Unknown pts`);
        return;
      }

      if (this.aac_last_incomplete_data_ && this.audio_last_sample_pts_) {
        ref_sample_duration = (1024 / this.audio_metadata_.sampling_frequency) * 1000;
        const new_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;

        if (Math.abs(new_pts_ms - base_pts_ms) > 1) {
          Log.w(this.TAG, `AAC: Detected pts overlapped, expected: ${new_pts_ms}ms, PES pts: ${base_pts_ms}ms`);
          base_pts_ms = new_pts_ms;
        }
      }
    }

    const adts_parser = new AACADTSParser(data);
    let aac_frame: AACFrame | null = null;
    let sample_pts_ms = base_pts_ms;
    let last_sample_pts_ms: number | undefined;

    aac_frame = adts_parser.readNextAACFrame();
    if (aac_frame != null) {
      this.audio_drop_until_sync_ = false;
    }
    while (aac_frame != null) {
      ref_sample_duration = (1024 / aac_frame.sampling_frequency) * 1000;
      const audio_sample = {
        codec: "aac",
        data: aac_frame,
      } as const;

      if (this.audio_init_segment_dispatched_ === false) {
        this.audio_metadata_ = {
          codec: "aac",
          audio_object_type: aac_frame.audio_object_type,
          sampling_freq_index: aac_frame.sampling_freq_index,
          sampling_frequency: aac_frame.sampling_frequency,
          channel_config: aac_frame.channel_config,
        };
        this.dispatchAudioInitSegment(audio_sample);
      } else if (this.detectAudioMetadataChange(audio_sample)) {
        // flush stashed frames before notify new AudioSpecificConfig
        this.dispatchAudioMediaSegment();
        // notify new AAC AudioSpecificConfig
        this.dispatchAudioInitSegment(audio_sample);
      }

      last_sample_pts_ms = sample_pts_ms;
      const sample_pts_ms_int = Math.floor(sample_pts_ms);

      const aac_sample = {
        unit: aac_frame.data,
        length: aac_frame.data.byteLength,
        pts: sample_pts_ms_int,
        dts: sample_pts_ms_int,
      };
      this.audio_track_.samples.push(aac_sample);
      this.audio_track_.length += aac_frame.data.byteLength;

      sample_pts_ms += ref_sample_duration;

      aac_frame = adts_parser.readNextAACFrame();
    }

    // getIncompleteData() returns null when fully consumed — always assign so a stale
    // buffer from a previous payload is not prepended again on the next call
    this.aac_last_incomplete_data_ = adts_parser.getIncompleteData();

    if (last_sample_pts_ms) {
      this.audio_last_sample_pts_ = last_sample_pts_ms;
    }
  }

  private parseLOASAACPayload(data: Uint8Array, pts: number | undefined) {
    if (this.has_video_ && !this.video_init_segment_dispatched_) {
      // If first video IDR frame hasn't been detected,
      // Wait for first IDR frame and video init segment being dispatched
      return;
    }
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }

    if (this.aac_last_incomplete_data_) {
      const buf = new Uint8Array(data.byteLength + this.aac_last_incomplete_data_.byteLength);
      buf.set(this.aac_last_incomplete_data_, 0);
      buf.set(data, this.aac_last_incomplete_data_.byteLength);
      data = buf;
    }

    let ref_sample_duration: number;
    let base_pts_ms!: number;

    if (pts !== undefined) {
      base_pts_ms = pts / this.timescale_;
    }
    if (this.audio_metadata_.codec === "aac") {
      if (pts === undefined && this.audio_last_sample_pts_ !== undefined) {
        ref_sample_duration = (1024 / this.audio_metadata_.sampling_frequency) * 1000;
        base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
      } else if (pts === undefined) {
        Log.w(this.TAG, `AAC: Unknown pts`);
        return;
      }

      if (this.aac_last_incomplete_data_ && this.audio_last_sample_pts_) {
        ref_sample_duration = (1024 / this.audio_metadata_.sampling_frequency) * 1000;
        const new_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;

        if (Math.abs(new_pts_ms - base_pts_ms) > 1) {
          Log.w(this.TAG, `AAC: Detected pts overlapped, expected: ${new_pts_ms}ms, PES pts: ${base_pts_ms}ms`);
          base_pts_ms = new_pts_ms;
        }
      }
    }

    const loas_parser = new AACLOASParser(data);
    let aac_frame: LOASAACFrame | null = null;
    let sample_pts_ms = base_pts_ms;
    let last_sample_pts_ms: number | undefined;

    aac_frame = loas_parser.readNextAACFrame(this.loas_previous_frame ?? undefined);
    if (aac_frame != null) {
      this.audio_drop_until_sync_ = false;
    }
    while (aac_frame != null) {
      this.loas_previous_frame = aac_frame;
      ref_sample_duration = (1024 / aac_frame.sampling_frequency) * 1000;
      const audio_sample = {
        codec: "aac",
        data: aac_frame,
      } as const;

      if (this.audio_init_segment_dispatched_ === false) {
        this.audio_metadata_ = {
          codec: "aac",
          audio_object_type: aac_frame.audio_object_type,
          sampling_freq_index: aac_frame.sampling_freq_index,
          sampling_frequency: aac_frame.sampling_frequency,
          channel_config: aac_frame.channel_config,
        };
        this.dispatchAudioInitSegment(audio_sample);
      } else if (this.detectAudioMetadataChange(audio_sample)) {
        // flush stashed frames before notify new AudioSpecificConfig
        this.dispatchAudioMediaSegment();
        // notify new AAC AudioSpecificConfig
        this.dispatchAudioInitSegment(audio_sample);
      }

      last_sample_pts_ms = sample_pts_ms;
      const sample_pts_ms_int = Math.floor(sample_pts_ms);

      const aac_sample = {
        unit: aac_frame.data,
        length: aac_frame.data.byteLength,
        pts: sample_pts_ms_int,
        dts: sample_pts_ms_int,
      };
      this.audio_track_.samples.push(aac_sample);
      this.audio_track_.length += aac_frame.data.byteLength;

      sample_pts_ms += ref_sample_duration;

      aac_frame = loas_parser.readNextAACFrame(this.loas_previous_frame ?? undefined);
    }

    // getIncompleteData() returns null when fully consumed — always assign so a stale
    // buffer from a previous payload is not prepended again on the next call
    this.aac_last_incomplete_data_ = loas_parser.getIncompleteData();

    if (last_sample_pts_ms) {
      this.audio_last_sample_pts_ = last_sample_pts_ms;
    }
  }

  private setAC3AudioMetadata(frame: AC3Frame): void {
    this.audio_metadata_ = {
      codec: "ac-3",
      sampling_frequency: frame.sampling_frequency,
      bit_stream_identification: frame.bit_stream_identification,
      bit_stream_mode: frame.bit_stream_mode,
      low_frequency_effects_channel_on: frame.low_frequency_effects_channel_on,
      channel_mode: frame.channel_mode,
    };
  }

  private setEAC3AudioMetadata(frame: EAC3Frame): void {
    this.audio_metadata_ = {
      codec: "ec-3",
      sampling_frequency: frame.sampling_frequency,
      bit_stream_identification: frame.bit_stream_identification,
      low_frequency_effects_channel_on: frame.low_frequency_effects_channel_on,
      num_blks: frame.num_blks,
      channel_mode: frame.channel_mode,
    };
  }

  private parseAC3Payload(data: Uint8Array, pts: number | undefined) {
    if (this.has_video_ && !this.video_init_segment_dispatched_) {
      // If first video IDR frame hasn't been detected,
      // Wait for first IDR frame and video init segment being dispatched
      return;
    }
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }

    const had_incomplete_data = this.ac3_last_incomplete_data_ !== null;
    if (this.ac3_last_incomplete_data_) {
      const buf = new Uint8Array(data.byteLength + this.ac3_last_incomplete_data_.byteLength);
      buf.set(this.ac3_last_incomplete_data_, 0);
      buf.set(data, this.ac3_last_incomplete_data_.byteLength);
      data = buf;
    }

    let ref_sample_duration: number;
    let base_pts_ms!: number;

    if (pts !== undefined) {
      base_pts_ms = pts / this.timescale_;
    }

    if (this.audio_metadata_.codec === "ac-3") {
      if (pts === undefined && this.audio_last_sample_pts_ !== undefined) {
        ref_sample_duration = (1536 / this.audio_metadata_.sampling_frequency) * 1000;
        base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
      } else if (pts === undefined) {
        Log.w(this.TAG, `AC3: Unknown pts`);
        return;
      }

      if (had_incomplete_data && this.audio_last_sample_pts_ !== undefined) {
        ref_sample_duration = (1536 / this.audio_metadata_.sampling_frequency) * 1000;
        const new_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;

        if (Math.abs(new_pts_ms - base_pts_ms) > 1) {
          Log.w(this.TAG, `AC3: Detected pts overlapped, expected: ${new_pts_ms}ms, PES pts: ${base_pts_ms}ms`);
          base_pts_ms = new_pts_ms;
        }
      }
    } else if (pts === undefined) {
      Log.w(this.TAG, `AC3: Unknown pts`);
      return;
    }

    const adts_parser = new AC3Parser(data);
    let ac3_frame: AC3Frame | null = null;
    let sample_pts_ms = base_pts_ms;
    let last_sample_pts_ms: number | undefined;

    ac3_frame = adts_parser.readNextAC3Frame();
    if (ac3_frame != null) {
      this.audio_drop_until_sync_ = false;
    }
    while (ac3_frame != null) {
      ref_sample_duration = (1536 / ac3_frame.sampling_frequency) * 1000;
      const audio_sample = {
        codec: "ac-3",
        data: ac3_frame,
      } as const;

      if (this.audio_init_segment_dispatched_ === false) {
        this.setAC3AudioMetadata(ac3_frame);
        this.dispatchAudioInitSegment(audio_sample);
      } else if (this.detectAudioMetadataChange(audio_sample)) {
        // flush stashed frames before notify new config
        this.dispatchAudioMediaSegment();
        this.setAC3AudioMetadata(ac3_frame);
        this.dispatchAudioInitSegment(audio_sample);
      }

      last_sample_pts_ms = sample_pts_ms;
      const sample_pts_ms_int = Math.floor(sample_pts_ms);

      const ac3_sample = {
        unit: ac3_frame.data,
        length: ac3_frame.data.byteLength,
        pts: sample_pts_ms_int,
        dts: sample_pts_ms_int,
      };

      this.audio_track_.samples.push(ac3_sample);
      this.audio_track_.length += ac3_frame.data.byteLength;

      sample_pts_ms += ref_sample_duration;

      ac3_frame = adts_parser.readNextAC3Frame();
    }

    // getIncompleteData() returns null when fully consumed — always assign so a stale
    // buffer from a previous payload is not prepended again on the next call
    this.ac3_last_incomplete_data_ = adts_parser.getIncompleteData();

    if (last_sample_pts_ms !== undefined) {
      this.audio_last_sample_pts_ = last_sample_pts_ms;
    }
  }

  private parseEAC3Payload(data: Uint8Array, pts: number | undefined) {
    if (this.has_video_ && !this.video_init_segment_dispatched_) {
      // If first video IDR frame hasn't been detected,
      // Wait for first IDR frame and video init segment being dispatched
      return;
    }
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }

    const had_incomplete_data = this.eac3_last_incomplete_data_ !== null;
    if (this.eac3_last_incomplete_data_) {
      const buf = new Uint8Array(data.byteLength + this.eac3_last_incomplete_data_.byteLength);
      buf.set(this.eac3_last_incomplete_data_, 0);
      buf.set(data, this.eac3_last_incomplete_data_.byteLength);
      data = buf;
    }

    let ref_sample_duration: number;
    let base_pts_ms!: number;

    if (pts !== undefined) {
      base_pts_ms = pts / this.timescale_;
    }

    if (this.audio_metadata_.codec === "ec-3") {
      if (pts === undefined && this.audio_last_sample_pts_ !== undefined) {
        ref_sample_duration = ((256 * this.audio_metadata_.num_blks) / this.audio_metadata_.sampling_frequency) * 1000;
        base_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;
      } else if (pts === undefined) {
        Log.w(this.TAG, `EAC3: Unknown pts`);
        return;
      }

      if (had_incomplete_data && this.audio_last_sample_pts_ !== undefined) {
        ref_sample_duration = ((256 * this.audio_metadata_.num_blks) / this.audio_metadata_.sampling_frequency) * 1000;
        const new_pts_ms = this.audio_last_sample_pts_ + ref_sample_duration;

        if (Math.abs(new_pts_ms - base_pts_ms) > 1) {
          Log.w(this.TAG, `EAC3: Detected pts overlapped, expected: ${new_pts_ms}ms, PES pts: ${base_pts_ms}ms`);
          base_pts_ms = new_pts_ms;
        }
      }
    } else if (pts === undefined) {
      Log.w(this.TAG, `EAC3: Unknown pts`);
      return;
    }

    const adts_parser = new EAC3Parser(data);
    let eac3_frame: EAC3Frame | null = null;
    let sample_pts_ms = base_pts_ms;
    let last_sample_pts_ms: number | undefined;

    eac3_frame = adts_parser.readNextEAC3Frame();
    if (eac3_frame != null) {
      this.audio_drop_until_sync_ = false;
    }
    while (eac3_frame != null) {
      ref_sample_duration = ((256 * eac3_frame.num_blks) / eac3_frame.sampling_frequency) * 1000;
      const audio_sample = {
        codec: "ec-3",
        data: eac3_frame,
      } as const;

      if (this.audio_init_segment_dispatched_ === false) {
        this.setEAC3AudioMetadata(eac3_frame);
        this.dispatchAudioInitSegment(audio_sample);
      } else if (this.detectAudioMetadataChange(audio_sample)) {
        // flush stashed frames before notify new config
        this.dispatchAudioMediaSegment();
        this.setEAC3AudioMetadata(eac3_frame);
        this.dispatchAudioInitSegment(audio_sample);
      }

      last_sample_pts_ms = sample_pts_ms;
      const sample_pts_ms_int = Math.floor(sample_pts_ms);

      const ac3_sample = {
        unit: eac3_frame.data,
        length: eac3_frame.data.byteLength,
        pts: sample_pts_ms_int,
        dts: sample_pts_ms_int,
      };

      this.audio_track_.samples.push(ac3_sample);
      this.audio_track_.length += eac3_frame.data.byteLength;

      sample_pts_ms += ref_sample_duration;

      eac3_frame = adts_parser.readNextEAC3Frame();
    }

    // getIncompleteData() returns null when fully consumed — always assign so a stale
    // buffer from a previous payload is not prepended again on the next call
    this.eac3_last_incomplete_data_ = adts_parser.getIncompleteData();

    if (last_sample_pts_ms !== undefined) {
      this.audio_last_sample_pts_ = last_sample_pts_ms;
    }
  }

  private parseMP3Payload(data: Uint8Array, pts: number | undefined) {
    if (this.has_video_ && !this.video_init_segment_dispatched_) {
      // If first video IDR frame hasn't been detected,
      // Wait for first IDR frame and video init segment being dispatched
      return;
    }
    if (this.shouldWaitForVideoKeyframe()) {
      return;
    }

    const _mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0];
    const _mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0];
    const _mpegAudioV25SampleRateTable = [11025, 12000, 8000, 0];

    const ver = (data[1] >>> 3) & 0x03;
    const layer = (data[1] & 0x06) >> 1;
    const sampling_freq_index = (data[2] & 0x0c) >>> 2;
    const channel_mode = (data[3] >>> 6) & 0x03;
    const channel_count = channel_mode !== 3 ? 2 : 1;

    let sample_rate = 0;
    let object_type = 34; // Layer-3, listed in MPEG-4 Audio Object Types

    switch (ver) {
      case 0: // MPEG 2.5
        sample_rate = _mpegAudioV25SampleRateTable[sampling_freq_index];
        break;
      case 2: // MPEG 2
        sample_rate = _mpegAudioV20SampleRateTable[sampling_freq_index];
        break;
      case 3: // MPEG 1
        sample_rate = _mpegAudioV10SampleRateTable[sampling_freq_index];
        break;
    }

    switch (layer) {
      case 1: // Layer 3
        object_type = 34;
        break;
      case 2: // Layer 2
        object_type = 33;
        break;
      case 3: // Layer 1
        object_type = 32;
        break;
    }

    // MP2 software decode: divert raw payload via callback
    // Silent AAC frames are generated by the remuxer synced to video DTS
    const soft_decode_active = this.soft_decode_audio_codec_ === "mp2";
    // A payload may start mid-frame (frame straddling a PES boundary); header
    // fields parsed from such payloads are garbage and must not drive metadata.
    const sync_at_start = data.length >= 4 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
    if (this.audio_drop_until_sync_) {
      if (!sync_at_start) {
        return;
      }
      this.audio_drop_until_sync_ = false;
    }
    if (this.onRawAudioData && !soft_decode_active && !sync_at_start) {
      // Can't classify a payload that starts mid-frame; wait for an aligned one
      return;
    }
    if ((object_type === 33 || soft_decode_active) && this.onRawAudioData) {
      if (!this.soft_decode_audio_codec_) {
        this.soft_decode_audio_codec_ = "mp2";
        Log.i(this.TAG, `MP2 audio detected, enabling software decode`);
      }

      if (sync_at_start) {
        // Dispatch audio init segment (as MP3) for track metadata
        const mp3sample = new MP3Data();
        mp3sample.object_type = object_type;
        mp3sample.sample_rate = sample_rate;
        mp3sample.channel_count = channel_count;
        mp3sample.data = data;
        const audio_sample = { codec: "mp3", data: mp3sample } as const;

        if (this.audio_init_segment_dispatched_ === false) {
          this.audio_metadata_ = {
            codec: "mp3",
            object_type,
            sample_rate,
            channel_count,
          };
          this.dispatchAudioInitSegment(audio_sample);
        } else if (this.detectAudioMetadataChange(audio_sample)) {
          this.dispatchAudioMediaSegment();
          this.audio_metadata_ = {
            codec: "mp3",
            object_type,
            sample_rate,
            channel_count,
          };
          this.dispatchAudioInitSegment(audio_sample);
        }
      }

      // Dispatch the raw payload for software decoding (the WASM decoder
      // splits it into frames and carries partial frames across payloads)
      const pts_ms = (pts ?? 0) / this.timescale_;
      this.onRawAudioData({ codec: "mp2", data, pts: pts_ms });

      // Don't push samples to audio track — the remuxer generates
      // silent AAC frames synced to video DTS instead
      return;
    }

    const sample = new MP3Data();
    sample.object_type = object_type;
    sample.sample_rate = sample_rate;
    sample.channel_count = channel_count;
    sample.data = data;
    const audio_sample = {
      codec: "mp3",
      data: sample,
    } as const;

    if (this.audio_init_segment_dispatched_ === false) {
      this.audio_metadata_ = {
        codec: "mp3",
        object_type,
        sample_rate,
        channel_count,
      };
      this.dispatchAudioInitSegment(audio_sample);
    } else if (this.detectAudioMetadataChange(audio_sample)) {
      // flush stashed frames before notify new config
      this.dispatchAudioMediaSegment();
      this.dispatchAudioInitSegment(audio_sample);
    }

    const mp3_sample = {
      unit: data,
      length: data.byteLength,
      pts: (pts ?? 0) / this.timescale_,
      dts: (pts ?? 0) / this.timescale_,
    };
    this.audio_track_.samples.push(mp3_sample);
    this.audio_track_.length += data.byteLength;
  }

  private detectAudioMetadataChange(sample: AudioData): boolean {
    if (sample.codec !== this.audio_metadata_.codec) {
      Log.v(this.TAG, `Audio: Audio Codecs changed from ${this.audio_metadata_.codec} to ${sample.codec}`);
      return true;
    }

    if (sample.codec === "aac" && this.audio_metadata_.codec === "aac") {
      const frame = sample.data;
      if (frame.audio_object_type !== this.audio_metadata_.audio_object_type) {
        Log.v(
          this.TAG,
          `AAC: AudioObjectType changed from ` +
            `${this.audio_metadata_.audio_object_type} to ${frame.audio_object_type}`,
        );
        return true;
      }

      if (frame.sampling_freq_index !== this.audio_metadata_.sampling_freq_index) {
        Log.v(
          this.TAG,
          `AAC: SamplingFrequencyIndex changed from ` +
            `${this.audio_metadata_.sampling_freq_index} to ${frame.sampling_freq_index}`,
        );
        return true;
      }

      if (frame.channel_config !== this.audio_metadata_.channel_config) {
        Log.v(
          this.TAG,
          `AAC: Channel configuration changed from ` +
            `${this.audio_metadata_.channel_config} to ${frame.channel_config}`,
        );
        return true;
      }
    } else if (sample.codec === "ac-3" && this.audio_metadata_.codec === "ac-3") {
      const frame = sample.data;
      if (frame.sampling_frequency !== this.audio_metadata_.sampling_frequency) {
        Log.v(
          this.TAG,
          `AC3: Sampling Frequency changed from ` +
            `${this.audio_metadata_.sampling_frequency} to ${frame.sampling_frequency}`,
        );
        return true;
      }

      if (frame.bit_stream_identification !== this.audio_metadata_.bit_stream_identification) {
        Log.v(
          this.TAG,
          `AC3: Bit Stream Identification changed from ` +
            `${this.audio_metadata_.bit_stream_identification} to ${frame.bit_stream_identification}`,
        );
        return true;
      }

      if (frame.bit_stream_mode !== this.audio_metadata_.bit_stream_mode) {
        Log.v(
          this.TAG,
          `AC3: BitStream Mode changed from ${this.audio_metadata_.bit_stream_mode} to ${frame.bit_stream_mode}`,
        );
        return true;
      }

      if (frame.channel_mode !== this.audio_metadata_.channel_mode) {
        Log.v(this.TAG, `AC3: Channel Mode changed from ${this.audio_metadata_.channel_mode} to ${frame.channel_mode}`);
        return true;
      }

      if (frame.low_frequency_effects_channel_on !== this.audio_metadata_.low_frequency_effects_channel_on) {
        Log.v(
          this.TAG,
          `AC3: Low Frequency Effects Channel On changed from ` +
            `${this.audio_metadata_.low_frequency_effects_channel_on} to ${frame.low_frequency_effects_channel_on}`,
        );
        return true;
      }
    } else if (sample.codec === "ec-3" && this.audio_metadata_.codec === "ec-3") {
      const frame = sample.data;
      if (frame.sampling_frequency !== this.audio_metadata_.sampling_frequency) {
        Log.v(
          this.TAG,
          `EAC3: Sampling Frequency changed from ` +
            `${this.audio_metadata_.sampling_frequency} to ${frame.sampling_frequency}`,
        );
        return true;
      }

      if (frame.bit_stream_identification !== this.audio_metadata_.bit_stream_identification) {
        Log.v(
          this.TAG,
          `EAC3: Bit Stream Identification changed from ` +
            `${this.audio_metadata_.bit_stream_identification} to ${frame.bit_stream_identification}`,
        );
        return true;
      }

      if (frame.num_blks !== this.audio_metadata_.num_blks) {
        Log.v(this.TAG, `EAC3: Audio blocks changed from ${this.audio_metadata_.num_blks} to ${frame.num_blks}`);
        return true;
      }

      if (frame.channel_mode !== this.audio_metadata_.channel_mode) {
        Log.v(
          this.TAG,
          `EAC3: Channel Mode changed from ${this.audio_metadata_.channel_mode} to ${frame.channel_mode}`,
        );
        return true;
      }

      if (frame.low_frequency_effects_channel_on !== this.audio_metadata_.low_frequency_effects_channel_on) {
        Log.v(
          this.TAG,
          `EAC3: Low Frequency Effects Channel On changed from ` +
            `${this.audio_metadata_.low_frequency_effects_channel_on} to ${frame.low_frequency_effects_channel_on}`,
        );
        return true;
      }
    } else if (sample.codec === "mp3" && this.audio_metadata_.codec === "mp3") {
      const data = sample.data;
      if (data.object_type !== this.audio_metadata_.object_type) {
        Log.v(this.TAG, `MP3: AudioObjectType changed from ${this.audio_metadata_.object_type} to ${data.object_type}`);
        return true;
      }

      if (data.sample_rate !== this.audio_metadata_.sample_rate) {
        Log.v(
          this.TAG,
          `MP3: SamplingFrequencyIndex changed from ${this.audio_metadata_.sample_rate} to ${data.sample_rate}`,
        );
        return true;
      }

      if (data.channel_count !== this.audio_metadata_.channel_count) {
        Log.v(
          this.TAG,
          `MP3: Channel count changed from ${this.audio_metadata_.channel_count} to ${data.channel_count}`,
        );
        return true;
      }
    }

    return false;
  }

  private dispatchAudioInitSegment(sample: AudioData) {
    const meta: Record<string, unknown> = {};
    meta.type = "audio";
    meta.id = this.audio_track_.id;
    meta.timescale = 1000;
    meta.duration = 0;

    if (this.audio_metadata_.codec === "aac") {
      if (sample.codec !== "aac") {
        return;
      }

      const audio_specific_config = new AudioSpecificConfig(sample.data);
      meta.audioSampleRate = audio_specific_config.sampling_rate;
      meta.channelCount = audio_specific_config.channel_count;
      meta.codec = audio_specific_config.codec_mimetype;
      meta.originalCodec = audio_specific_config.original_codec_mimetype;
      meta.config = audio_specific_config.config;
      meta.refSampleDuration = (1024 / (meta.audioSampleRate as number)) * (meta.timescale as number);
    } else if (this.audio_metadata_.codec === "ac-3") {
      if (sample.codec !== "ac-3") {
        return;
      }
      const ac3_config = new AC3Config(sample.data);
      meta.audioSampleRate = ac3_config.sampling_rate;
      meta.channelCount = ac3_config.channel_count;
      meta.codec = ac3_config.codec_mimetype;
      meta.originalCodec = ac3_config.original_codec_mimetype;
      meta.config = ac3_config.config;
      meta.bitrate = ac3_config.bitrate;
      meta.refSampleDuration = (1536 / (meta.audioSampleRate as number)) * (meta.timescale as number);
    } else if (this.audio_metadata_.codec === "ec-3") {
      if (sample.codec !== "ec-3") {
        return;
      }
      const ec3_config = new EAC3Config(sample.data);
      meta.audioSampleRate = ec3_config.sampling_rate;
      meta.channelCount = ec3_config.channel_count;
      meta.codec = ec3_config.codec_mimetype;
      meta.originalCodec = ec3_config.original_codec_mimetype;
      meta.config = ec3_config.config;
      meta.bitrate = ec3_config.bitrate;
      meta.refSampleDuration =
        ((256 * ec3_config.num_blks) / (meta.audioSampleRate as number)) * (meta.timescale as number);
    } else if (this.audio_metadata_.codec === "mp3") {
      meta.audioSampleRate = this.audio_metadata_.sample_rate;
      meta.channelCount = this.audio_metadata_.channel_count;
      meta.codec = "mp3";
      meta.originalCodec = "mp3";
      meta.config = undefined;
    }

    if (this.audio_init_segment_dispatched_ === false) {
      Log.v(this.TAG, `Generated first AudioSpecificConfig for mimeType: ${meta.codec}`);
    }

    // When software decoding, send a fake AAC-LC metadata with silentAudioMode
    // so the remuxer creates an AAC SourceBuffer and generates silent frames
    if (this.soft_decode_audio_codec_) {
      const sampleRate = (meta.audioSampleRate as number) || 48000;
      const channelCount = (meta.channelCount as number) || 2;
      // Find sampling frequency index for AAC config
      const si = MPEG4SamplingFrequencies.indexOf(sampleRate);
      const freqIdx = si !== -1 ? si : 3; // default 48kHz
      const silentMeta: Record<string, unknown> = {
        type: "audio",
        id: this.audio_track_.id,
        timescale: 1000,
        duration: 0,
        audioSampleRate: sampleRate,
        channelCount: channelCount,
        codec: "mp4a.40.2",
        originalCodec: "mp4a.40.2",
        sourceCodec: this.soft_decode_audio_codec_,
        config: [(2 << 3) | ((freqIdx & 0x0f) >>> 1), ((freqIdx & 0x01) << 7) | ((channelCount & 0x0f) << 3)],
        refSampleDuration: (1024 / sampleRate) * 1000,
        silentAudioMode: true,
      };
      this.onTrackMetadata?.("audio", silentMeta);
    } else {
      this.onTrackMetadata?.("audio", meta);
    }
    this.audio_init_segment_dispatched_ = true;
    this.video_metadata_changed_ = false;
  }

  private getPcrBase(data: Uint8Array): number {
    let pcr_base =
      data[6] * 33554432 + // 1 << 25
      data[7] * 131072 + // 1 << 17
      data[8] * 512 + // 1 << 9
      data[9] * 2 + // 1 << 1
      (data[10] & 0x80) / 128 + // 1 >> 7
      this.timestamp_offset_;
    if (pcr_base + 0x100000000 < this.last_pcr_base_) {
      pcr_base += 0x200000000; // pcr_base wraparound
      this.timestamp_offset_ += 0x200000000;
    }
    this.last_pcr_base_ = pcr_base;
    return pcr_base;
  }

  private getTimestamp(data: Uint8Array, pos: number): number {
    let timestamp =
      (data[pos] & 0x0e) * 536870912 + // 1 << 29
      (data[pos + 1] & 0xff) * 4194304 + // 1 << 22
      (data[pos + 2] & 0xfe) * 16384 + // 1 << 14
      (data[pos + 3] & 0xff) * 128 + // 1 << 7
      (data[pos + 4] & 0xfe) / 2 +
      this.timestamp_offset_;
    if (timestamp + 0x100000000 < this.last_pcr_base_) {
      timestamp += 0x200000000; // pts/dts wraparound
    }
    return timestamp;
  }
}

export default TSDemuxer;

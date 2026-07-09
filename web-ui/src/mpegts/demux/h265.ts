import Log from "../utils/logger";
import { findAnnexBStartCodeOffset } from "./annexb";

export enum H265NaluType {
  kSliceIDR_W_RADL = 19,
  kSliceIDR_N_LP = 20,
  kSliceCRA_NUT = 21,
  kSliceVPS = 32,
  kSliceSPS = 33,
  kSlicePPS = 34,
  kSliceAUD = 35,
}

export class H265NaluPayload {
  type!: H265NaluType;
  data!: Uint8Array;
}

export class H265NaluHVC1 {
  type: H265NaluType;
  data: Uint8Array;

  constructor(nalu: H265NaluPayload) {
    const nalu_size = nalu.data.byteLength;

    this.type = nalu.type;
    this.data = new Uint8Array(4 + nalu_size); // 4 byte length-header + nalu payload

    const v = new DataView(this.data.buffer);
    // Fill 4 byte length-header
    v.setUint32(0, nalu_size);
    // Copy payload
    this.data.set(nalu.data, 4);
  }
}

export class H265AnnexBParser {
  private readonly TAG: string = "H265AnnexBParser";

  private data_: Uint8Array;
  private current_startcode_offset_: number = 0;
  private eof_flag_: boolean = false;

  public constructor(data: Uint8Array) {
    this.data_ = data;
    this.current_startcode_offset_ = this.findNextStartCodeOffset(0);
    if (this.eof_flag_) {
      Log.e(this.TAG, "Could not find H265 startcode until payload end!");
    }
  }

  private findNextStartCodeOffset(start_offset: number) {
    const offset = findAnnexBStartCodeOffset(this.data_, start_offset);
    if (offset === this.data_.byteLength) {
      this.eof_flag_ = true;
    }
    return offset;
  }

  public readNextNaluPayload(): H265NaluPayload | null {
    const data = this.data_;
    let nalu_payload: H265NaluPayload | null = null;

    while (nalu_payload == null) {
      if (this.eof_flag_) {
        break;
      }
      // offset pointed to start code
      const startcode_offset = this.current_startcode_offset_;

      // nalu payload start offset
      let offset = startcode_offset;
      const u32 = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
      if (u32 === 0x00000001) {
        offset += 4;
      } else {
        offset += 3;
      }

      const nalu_type: H265NaluType = (data[offset] >> 1) & 0x3f;
      const forbidden_bit = (data[offset] & 0x80) >>> 7;

      const next_startcode_offset = this.findNextStartCodeOffset(offset);
      this.current_startcode_offset_ = next_startcode_offset;

      if (forbidden_bit !== 0) {
        // Log.e(this.TAG, `forbidden_bit near offset ${offset} should be 0 but has value ${forbidden_bit}`);
        continue;
      }

      const payload_data = data.subarray(offset, next_startcode_offset);

      nalu_payload = new H265NaluPayload();
      nalu_payload.type = nalu_type;
      nalu_payload.data = payload_data;
    }

    return nalu_payload;
  }
}

export type HEVCDecoderConfigurationRecordType = {
  configurationVersion: 1;
} & VPSHEVCDecoderConfigurationRecordType &
  SPSHEVCDecoderConfigurationRecordType &
  PPSHEVCDecoderConfigurationRecordType;

export type VPSHEVCDecoderConfigurationRecordType = {
  num_temporal_layers: number;
  temporal_id_nested: boolean;
};

export type SPSHEVCDecoderConfigurationRecordType = {
  general_profile_space: number;
  general_tier_flag: number;
  general_level_idc: number;
  general_profile_idc: number;
  general_profile_compatibility_flags_1: number;
  general_profile_compatibility_flags_2: number;
  general_profile_compatibility_flags_3: number;
  general_profile_compatibility_flags_4: number;
  general_constraint_indicator_flags_1: number;
  general_constraint_indicator_flags_2: number;
  general_constraint_indicator_flags_3: number;
  general_constraint_indicator_flags_4: number;
  general_constraint_indicator_flags_5: number;
  general_constraint_indicator_flags_6: number;
  constant_frame_rate: number;
  min_spatial_segmentation_idc: number;
  chroma_format_idc: number;
  bit_depth_luma_minus8: number;
  bit_depth_chroma_minus8: number;
};

export type PPSHEVCDecoderConfigurationRecordType = {
  parallelismType: number;
};

export class HEVCDecoderConfigurationRecord {
  private data: Uint8Array;

  // sps, pps: require Nalu without 4 byte length-header
  public constructor(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array, detail: HEVCDecoderConfigurationRecordType) {
    const length = 23 + (3 + 2 + vps.byteLength) + (3 + 2 + sps.byteLength) + (3 + 2 + pps.byteLength);
    this.data = new Uint8Array(length);
    const data = this.data;

    data[0] = 0x01; // configurationVersion
    data[1] =
      ((detail.general_profile_space & 0x03) << 6) |
      ((detail.general_tier_flag ? 1 : 0) << 5) |
      (detail.general_profile_idc & 0x1f);
    data[2] = detail.general_profile_compatibility_flags_1;
    data[3] = detail.general_profile_compatibility_flags_2;
    data[4] = detail.general_profile_compatibility_flags_3;
    data[5] = detail.general_profile_compatibility_flags_4;
    data[6] = detail.general_constraint_indicator_flags_1;
    data[7] = detail.general_constraint_indicator_flags_2;
    data[8] = detail.general_constraint_indicator_flags_3;
    data[9] = detail.general_constraint_indicator_flags_4;
    data[10] = detail.general_constraint_indicator_flags_5;
    data[11] = detail.general_constraint_indicator_flags_6;
    data[12] = detail.general_level_idc;
    data[13] = 0xf0 | ((detail.min_spatial_segmentation_idc & 0x0f00) >> 8);
    data[14] = detail.min_spatial_segmentation_idc & 0xff;
    data[15] = 0xfc | (detail.parallelismType & 0x03);
    data[16] = 0xfc | (detail.chroma_format_idc & 0x03);
    data[17] = 0xf8 | (detail.bit_depth_luma_minus8 & 0x07);
    data[18] = 0xf8 | (detail.bit_depth_chroma_minus8 & 0x07);
    data[19] = 0;
    data[20] = 0;
    data[21] =
      ((detail.constant_frame_rate & 0x03) << 6) |
      ((detail.num_temporal_layers & 0x07) << 3) |
      ((detail.temporal_id_nested ? 1 : 0) << 2) |
      3;
    data[22] = 3;
    data[23 + 0 + 0] = 0x80 | H265NaluType.kSliceVPS;
    data[23 + 0 + 1] = 0;
    data[23 + 0 + 2] = 1;
    data[23 + 0 + 3] = (vps.byteLength & 0xff00) >> 8;
    data[23 + 0 + 4] = (vps.byteLength & 0x00ff) >> 0;
    data.set(vps, 23 + 0 + 5);
    data[23 + (5 + vps.byteLength) + 0] = 0x80 | H265NaluType.kSliceSPS;
    data[23 + (5 + vps.byteLength) + 1] = 0;
    data[23 + (5 + vps.byteLength) + 2] = 1;
    data[23 + (5 + vps.byteLength) + 3] = (sps.byteLength & 0xff00) >> 8;
    data[23 + (5 + vps.byteLength) + 4] = (sps.byteLength & 0x00ff) >> 0;
    data.set(sps, 23 + (5 + vps.byteLength) + 5);
    data[23 + (5 + vps.byteLength + 5 + sps.byteLength) + 0] = 0x80 | H265NaluType.kSlicePPS;
    data[23 + (5 + vps.byteLength + 5 + sps.byteLength) + 1] = 0;
    data[23 + (5 + vps.byteLength + 5 + sps.byteLength) + 2] = 1;
    data[23 + (5 + vps.byteLength + 5 + sps.byteLength) + 3] = (pps.byteLength & 0xff00) >> 8;
    data[23 + (5 + vps.byteLength + 5 + sps.byteLength) + 4] = (pps.byteLength & 0x00ff) >> 0;
    data.set(pps, 23 + (5 + vps.byteLength + 5 + sps.byteLength) + 5);
  }

  public getData() {
    return this.data;
  }
}

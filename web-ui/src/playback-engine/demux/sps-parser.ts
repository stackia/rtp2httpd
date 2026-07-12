import ExpGolomb from "./exp-golomb";

export interface SPSInfo {
  codec_mimetype: string;
  profile_idc: number;
  level_idc: number;
  profile_string: string;
  level_string: string;
  chroma_format_idc: number;
  bit_depth: number;
  bit_depth_luma: number;
  bit_depth_chroma: number;
  ref_frames: number;
  chroma_format: number;
  chroma_format_string: string;
  /** 0 → the stream may contain field-coded (interlaced) pictures. */
  frame_mbs_only_flag: number;
  colour_primaries?: number;
  transfer_characteristics?: number;
  matrix_coefficients?: number;
  video_full_range_flag?: boolean;
  frame_rate: {
    fixed: boolean;
    fps: number;
    fps_den: number;
    fps_num: number;
  };
  sar_ratio: {
    width: number;
    height: number;
  };
  codec_size: {
    width: number;
    height: number;
  };
  present_size: {
    width: number;
    height: number;
  };
}

const SPSParser = {
  _ebsp2rbsp(uint8array: Uint8Array): Uint8Array {
    const src: Uint8Array = uint8array;
    const src_length: number = src.byteLength;
    const dst: Uint8Array = new Uint8Array(src_length);
    let dst_idx: number = 0;

    for (let i = 0; i < src_length; i++) {
      if (i >= 2) {
        // Unescape: Skip 0x03 after 00 00
        if (src[i] === 0x03 && src[i - 1] === 0x00 && src[i - 2] === 0x00) {
          continue;
        }
      }
      dst[dst_idx] = src[i];
      dst_idx++;
    }

    return new Uint8Array(dst.buffer, 0, dst_idx);
  },

  parseSPS(uint8array: Uint8Array): SPSInfo {
    const codec_array: Uint8Array = uint8array.subarray(1, 4);
    let codec_mimetype: string = "avc1.";
    for (let j = 0; j < 3; j++) {
      let h: string = codec_array[j].toString(16);
      if (h.length < 2) {
        h = `0${h}`;
      }
      codec_mimetype += h;
    }

    const rbsp: Uint8Array = SPSParser._ebsp2rbsp(uint8array);
    const gb: ExpGolomb = new ExpGolomb(rbsp);

    gb.readByte();
    const profile_idc: number = gb.readByte(); // profile_idc
    gb.readByte(); // constraint_set_flags[5] + reserved_zero[3]
    const level_idc: number = gb.readByte(); // level_idc
    gb.readUEG(); // seq_parameter_set_id

    const profile_string: string = SPSParser.getProfileString(profile_idc);
    const level_string: string = SPSParser.getLevelString(level_idc);
    let chroma_format_idc: number = 1;
    let chroma_format: number = 420;
    const chroma_format_table: number[] = [0, 420, 422, 444];
    let bit_depth_luma: number = 8;
    let bit_depth_chroma: number = 8;

    if (
      profile_idc === 100 ||
      profile_idc === 110 ||
      profile_idc === 122 ||
      profile_idc === 244 ||
      profile_idc === 44 ||
      profile_idc === 83 ||
      profile_idc === 86 ||
      profile_idc === 118 ||
      profile_idc === 128 ||
      profile_idc === 138 ||
      profile_idc === 144
    ) {
      chroma_format_idc = gb.readUEG();
      if (chroma_format_idc === 3) {
        gb.readBits(1); // separate_colour_plane_flag
      }
      if (chroma_format_idc <= 3) {
        chroma_format = chroma_format_table[chroma_format_idc];
      }

      bit_depth_luma = gb.readUEG() + 8; // bit_depth_luma_minus8
      bit_depth_chroma = gb.readUEG() + 8; // bit_depth_chroma_minus8
      gb.readBits(1); // qpprime_y_zero_transform_bypass_flag
      if (gb.readBool()) {
        // seq_scaling_matrix_present_flag
        const scaling_list_count: number = chroma_format_idc !== 3 ? 8 : 12;
        for (let i = 0; i < scaling_list_count; i++) {
          if (gb.readBool()) {
            // seq_scaling_list_present_flag
            if (i < 6) {
              SPSParser._skipScalingList(gb, 16);
            } else {
              SPSParser._skipScalingList(gb, 64);
            }
          }
        }
      }
    }
    gb.readUEG(); // log2_max_frame_num_minus4
    const pic_order_cnt_type: number = gb.readUEG();
    if (pic_order_cnt_type === 0) {
      gb.readUEG(); // log2_max_pic_order_cnt_lsb_minus_4
    } else if (pic_order_cnt_type === 1) {
      gb.readBits(1); // delta_pic_order_always_zero_flag
      gb.readSEG(); // offset_for_non_ref_pic
      gb.readSEG(); // offset_for_top_to_bottom_field
      const num_ref_frames_in_pic_order_cnt_cycle: number = gb.readUEG();
      for (let i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; i++) {
        gb.readSEG(); // offset_for_ref_frame
      }
    }
    const ref_frames: number = gb.readUEG(); // max_num_ref_frames
    gb.readBits(1); // gaps_in_frame_num_value_allowed_flag

    const pic_width_in_mbs_minus1: number = gb.readUEG();
    const pic_height_in_map_units_minus1: number = gb.readUEG();

    const frame_mbs_only_flag: number = gb.readBits(1);
    if (frame_mbs_only_flag === 0) {
      gb.readBits(1); // mb_adaptive_frame_field_flag
    }
    gb.readBits(1); // direct_8x8_inference_flag

    let frame_crop_left_offset: number = 0;
    let frame_crop_right_offset: number = 0;
    let frame_crop_top_offset: number = 0;
    let frame_crop_bottom_offset: number = 0;

    const frame_cropping_flag: boolean = gb.readBool();
    if (frame_cropping_flag) {
      frame_crop_left_offset = gb.readUEG();
      frame_crop_right_offset = gb.readUEG();
      frame_crop_top_offset = gb.readUEG();
      frame_crop_bottom_offset = gb.readUEG();
    }

    let sar_width: number = 1,
      sar_height: number = 1;
    let fps: number = 0,
      fps_fixed: boolean = true,
      fps_num: number = 0,
      fps_den: number = 0;
    let colour_primaries: number | undefined;
    let transfer_characteristics: number | undefined;
    let matrix_coefficients: number | undefined;
    let video_full_range_flag: boolean | undefined;

    const vui_parameters_present_flag: boolean = gb.readBool();
    if (vui_parameters_present_flag) {
      if (gb.readBool()) {
        // aspect_ratio_info_present_flag
        const aspect_ratio_idc: number = gb.readByte();
        const sar_w_table: number[] = [1, 12, 10, 16, 40, 24, 20, 32, 80, 18, 15, 64, 160, 4, 3, 2];
        const sar_h_table: number[] = [1, 11, 11, 11, 33, 11, 11, 11, 33, 11, 11, 33, 99, 3, 2, 1];

        if (aspect_ratio_idc > 0 && aspect_ratio_idc < 16) {
          sar_width = sar_w_table[aspect_ratio_idc - 1];
          sar_height = sar_h_table[aspect_ratio_idc - 1];
        } else if (aspect_ratio_idc === 255) {
          sar_width = (gb.readByte() << 8) | gb.readByte();
          sar_height = (gb.readByte() << 8) | gb.readByte();
        }
      }

      if (gb.readBool()) {
        // overscan_info_present_flag
        gb.readBool(); // overscan_appropriate_flag
      }
      if (gb.readBool()) {
        // video_signal_type_present_flag
        gb.readBits(3); // video_format
        video_full_range_flag = gb.readBool();
        if (gb.readBool()) {
          // colour_description_present_flag
          colour_primaries = gb.readByte();
          transfer_characteristics = gb.readByte();
          matrix_coefficients = gb.readByte();
        }
      }
      if (gb.readBool()) {
        // chroma_loc_info_present_flag
        gb.readUEG(); // chroma_sample_loc_type_top_field
        gb.readUEG(); // chroma_sample_loc_type_bottom_field
      }
      if (gb.readBool()) {
        // timing_info_present_flag
        const num_units_in_tick: number = gb.readBits(32);
        const time_scale: number = gb.readBits(32);
        fps_fixed = gb.readBool(); // fixed_frame_rate_flag

        fps_num = time_scale;
        fps_den = num_units_in_tick * 2;
        fps = fps_num / fps_den;
      }
    }

    let sarScale: number = 1;
    if (sar_width !== 1 || sar_height !== 1) {
      sarScale = sar_width / sar_height;
    }

    let crop_unit_x: number = 0,
      crop_unit_y: number = 0;
    if (chroma_format_idc === 0) {
      crop_unit_x = 1;
      crop_unit_y = 2 - frame_mbs_only_flag;
    } else {
      const sub_wc: number = chroma_format_idc === 3 ? 1 : 2;
      const sub_hc: number = chroma_format_idc === 1 ? 2 : 1;
      crop_unit_x = sub_wc;
      crop_unit_y = sub_hc * (2 - frame_mbs_only_flag);
    }

    let codec_width: number = (pic_width_in_mbs_minus1 + 1) * 16;
    let codec_height: number = (2 - frame_mbs_only_flag) * ((pic_height_in_map_units_minus1 + 1) * 16);

    codec_width -= (frame_crop_left_offset + frame_crop_right_offset) * crop_unit_x;
    codec_height -= (frame_crop_top_offset + frame_crop_bottom_offset) * crop_unit_y;

    const present_width: number = Math.ceil(codec_width * sarScale);

    gb.destroy();

    return {
      codec_mimetype,
      profile_idc,
      level_idc,
      profile_string, // baseline, high, high10, ...
      level_string, // 3, 3.1, 4, 4.1, 5, 5.1, ...
      chroma_format_idc,
      bit_depth: bit_depth_luma, // 8bit, 10bit, ...
      bit_depth_luma,
      bit_depth_chroma,
      ref_frames,
      chroma_format, // 4:2:0, 4:2:2, ...
      chroma_format_string: SPSParser.getChromaFormatString(chroma_format),
      // 0 → the stream may contain field-coded (interlaced) pictures
      frame_mbs_only_flag,
      colour_primaries,
      transfer_characteristics,
      matrix_coefficients,
      video_full_range_flag,

      frame_rate: {
        fixed: fps_fixed,
        fps: fps,
        fps_den: fps_den,
        fps_num: fps_num,
      },

      sar_ratio: {
        width: sar_width,
        height: sar_height,
      },

      codec_size: {
        width: codec_width,
        height: codec_height,
      },

      present_size: {
        width: present_width,
        height: codec_height,
      },
    };
  },

  _skipScalingList(gb: ExpGolomb, count: number): void {
    let last_scale: number = 8,
      next_scale: number = 8;
    let delta_scale: number = 0;
    for (let i = 0; i < count; i++) {
      if (next_scale !== 0) {
        delta_scale = gb.readSEG();
        next_scale = (last_scale + delta_scale + 256) % 256;
      }
      last_scale = next_scale === 0 ? last_scale : next_scale;
    }
  },

  getProfileString(profile_idc: number): string {
    switch (profile_idc) {
      case 66:
        return "Baseline";
      case 77:
        return "Main";
      case 88:
        return "Extended";
      case 100:
        return "High";
      case 110:
        return "High10";
      case 122:
        return "High422";
      case 244:
        return "High444";
      default:
        return "Unknown";
    }
  },

  getLevelString(level_idc: number): string {
    return (level_idc / 10).toFixed(1);
  },

  getChromaFormatString(chroma: number): string {
    switch (chroma) {
      case 420:
        return "4:2:0";
      case 422:
        return "4:2:2";
      case 444:
        return "4:4:4";
      default:
        return "Unknown";
    }
  },
};

export default SPSParser;

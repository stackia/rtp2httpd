import ExpGolomb from "./exp-golomb";

export interface H265VPSInfo {
  num_temporal_layers: number;
  temporal_id_nested: boolean;
}

export interface H265SPSInfo {
  codec_mimetype: string;
  profile_string: string;
  level_string: string;
  profile_idc: number;
  bit_depth: number;
  ref_frames: number;
  chroma_format: number;
  chroma_format_string: string;
  general_level_idc: number;
  general_profile_space: number;
  general_tier_flag: boolean;
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
  min_spatial_segmentation_idc: number;
  constant_frame_rate: number;
  chroma_format_idc: number;
  bit_depth_luma_minus8: number;
  bit_depth_chroma_minus8: number;
  interlaced_source: boolean;
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

export interface H265PPSInfo {
  parallelismType: number;
}

const H265NaluParser = {
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

  parseVPS(uint8array: Uint8Array): H265VPSInfo {
    const rbsp: Uint8Array = H265NaluParser._ebsp2rbsp(uint8array);
    const gb: ExpGolomb = new ExpGolomb(rbsp);

    /* remove NALu Header */
    gb.readByte();
    gb.readByte();

    // VPS
    const _video_parameter_set_id: number = gb.readBits(4);
    gb.readBits(2);
    const _max_layers_minus1: number = gb.readBits(6);
    const max_sub_layers_minus1: number = gb.readBits(3);
    const temporal_id_nesting_flag: boolean = gb.readBool();
    // and more ...

    return {
      num_temporal_layers: max_sub_layers_minus1 + 1,
      temporal_id_nested: temporal_id_nesting_flag,
    };
  },

  parseSPS(uint8array: Uint8Array): H265SPSInfo {
    const rbsp: Uint8Array = H265NaluParser._ebsp2rbsp(uint8array);
    const gb: ExpGolomb = new ExpGolomb(rbsp);

    /* remove NALu Header */
    gb.readByte();
    gb.readByte();

    let left_offset: number = 0,
      right_offset: number = 0,
      top_offset: number = 0,
      bottom_offset: number = 0;

    // SPS
    const _video_paramter_set_id: number = gb.readBits(4);
    const max_sub_layers_minus1: number = gb.readBits(3);
    const _temporal_id_nesting_flag: boolean = gb.readBool();

    // profile_tier_level begin
    const general_profile_space: number = gb.readBits(2);
    const general_tier_flag: boolean = gb.readBool();
    const general_profile_idc: number = gb.readBits(5);
    const general_profile_compatibility_flags_1: number = gb.readByte();
    const general_profile_compatibility_flags_2: number = gb.readByte();
    const general_profile_compatibility_flags_3: number = gb.readByte();
    const general_profile_compatibility_flags_4: number = gb.readByte();
    const general_constraint_indicator_flags_1: number = gb.readByte();
    const general_constraint_indicator_flags_2: number = gb.readByte();
    const general_constraint_indicator_flags_3: number = gb.readByte();
    const general_constraint_indicator_flags_4: number = gb.readByte();
    const general_constraint_indicator_flags_5: number = gb.readByte();
    const general_constraint_indicator_flags_6: number = gb.readByte();
    const general_level_idc: number = gb.readByte();
    const sub_layer_profile_present_flag: boolean[] = [];
    const sub_layer_level_present_flag: boolean[] = [];
    for (let i = 0; i < max_sub_layers_minus1; i++) {
      sub_layer_profile_present_flag.push(gb.readBool());
      sub_layer_level_present_flag.push(gb.readBool());
    }
    if (max_sub_layers_minus1 > 0) {
      for (let i = max_sub_layers_minus1; i < 8; i++) {
        gb.readBits(2);
      }
    }
    for (let i = 0; i < max_sub_layers_minus1; i++) {
      if (sub_layer_profile_present_flag[i]) {
        gb.readByte(); // sub_layer_profile_space, sub_layer_tier_flag, sub_layer_profile_idc
        gb.readByte();
        gb.readByte();
        gb.readByte();
        gb.readByte(); // sub_layer_profile_compatibility_flag
        gb.readByte();
        gb.readByte();
        gb.readByte();
        gb.readByte();
        gb.readByte();
        gb.readByte();
      }
      if (sub_layer_level_present_flag[i]) {
        gb.readByte();
      }
    }
    // profile_tier_level end

    const _seq_parameter_set_id: number = gb.readUEG();
    const chroma_format_idc: number = gb.readUEG();
    if (chroma_format_idc === 3) {
      gb.readBits(1); // separate_colour_plane_flag
    }
    const pic_width_in_luma_samples: number = gb.readUEG();
    const pic_height_in_luma_samples: number = gb.readUEG();
    const conformance_window_flag: boolean = gb.readBool();
    if (conformance_window_flag) {
      left_offset += gb.readUEG();
      right_offset += gb.readUEG();
      top_offset += gb.readUEG();
      bottom_offset += gb.readUEG();
    }
    const bit_depth_luma_minus8: number = gb.readUEG();
    const bit_depth_chroma_minus8: number = gb.readUEG();
    const log2_max_pic_order_cnt_lsb_minus4: number = gb.readUEG();
    const sub_layer_ordering_info_present_flag: boolean = gb.readBool();
    for (let i = sub_layer_ordering_info_present_flag ? 0 : max_sub_layers_minus1; i <= max_sub_layers_minus1; i++) {
      gb.readUEG(); // max_dec_pic_buffering_minus1[i]
      gb.readUEG(); // max_num_reorder_pics[i]
      gb.readUEG(); // max_latency_increase_plus1[i]
    }
    const _log2_min_luma_coding_block_size_minus3: number = gb.readUEG();
    const _log2_diff_max_min_luma_coding_block_size: number = gb.readUEG();
    const _log2_min_transform_block_size_minus2: number = gb.readUEG();
    const _log2_diff_max_min_transform_block_size: number = gb.readUEG();
    const _max_transform_hierarchy_depth_inter: number = gb.readUEG();
    const _max_transform_hierarchy_depth_intra: number = gb.readUEG();
    const scaling_list_enabled_flag: boolean = gb.readBool();
    if (scaling_list_enabled_flag) {
      const sps_scaling_list_data_present_flag: boolean = gb.readBool();
      if (sps_scaling_list_data_present_flag) {
        for (let sizeId = 0; sizeId < 4; sizeId++) {
          for (let matrixId = 0; matrixId < (sizeId === 3 ? 2 : 6); matrixId++) {
            const scaling_list_pred_mode_flag: boolean = gb.readBool();
            if (!scaling_list_pred_mode_flag) {
              gb.readUEG(); // scaling_list_pred_matrix_id_delta
            } else {
              const coefNum: number = Math.min(64, 1 << (4 + (sizeId << 1)));
              if (sizeId > 1) {
                gb.readSEG();
              }
              for (let i = 0; i < coefNum; i++) {
                gb.readSEG();
              }
            }
          }
        }
      }
    }
    const _amp_enabled_flag: boolean = gb.readBool();
    const _sample_adaptive_offset_enabled_flag: boolean = gb.readBool();
    const pcm_enabled_flag: boolean = gb.readBool();
    if (pcm_enabled_flag) {
      gb.readByte();
      gb.readUEG();
      gb.readUEG();
      gb.readBool();
    }
    const num_short_term_ref_pic_sets: number = gb.readUEG();
    let num_delta_pocs: number = 0;
    for (let i = 0; i < num_short_term_ref_pic_sets; i++) {
      let inter_ref_pic_set_prediction_flag: boolean = false;
      if (i !== 0) {
        inter_ref_pic_set_prediction_flag = gb.readBool();
      }
      if (inter_ref_pic_set_prediction_flag) {
        if (i === num_short_term_ref_pic_sets) {
          gb.readUEG();
        }
        gb.readBool();
        gb.readUEG();
        let next_num_delta_pocs: number = 0;
        for (let j = 0; j <= num_delta_pocs; j++) {
          const used_by_curr_pic_flag: boolean = gb.readBool();
          let use_delta_flag: boolean = false;
          if (!used_by_curr_pic_flag) {
            use_delta_flag = gb.readBool();
          }
          if (used_by_curr_pic_flag || use_delta_flag) {
            next_num_delta_pocs++;
          }
        }
        num_delta_pocs = next_num_delta_pocs;
      } else {
        const num_negative_pics: number = gb.readUEG();
        const num_positive_pics: number = gb.readUEG();
        num_delta_pocs = num_negative_pics + num_positive_pics;
        for (let j = 0; j < num_negative_pics; j++) {
          gb.readUEG();
          gb.readBool();
        }
        for (let j = 0; j < num_positive_pics; j++) {
          gb.readUEG();
          gb.readBool();
        }
      }
    }
    const long_term_ref_pics_present_flag: boolean = gb.readBool();
    if (long_term_ref_pics_present_flag) {
      const num_long_term_ref_pics_sps: number = gb.readUEG();
      for (let i = 0; i < num_long_term_ref_pics_sps; i++) {
        for (let j = 0; j < log2_max_pic_order_cnt_lsb_minus4 + 4; j++) {
          gb.readBits(1);
        }
        gb.readBits(1);
      }
    }
    //*
    let default_display_window_flag: boolean = false; // for calc offset
    let min_spatial_segmentation_idc: number = 0; // for hvcC
    let sar_width: number = 1,
      sar_height: number = 1;
    let fps_fixed: boolean = false,
      fps_den: number = 1,
      fps_num: number = 1;
    let field_seq_flag: boolean = false;
    //*/
    const _sps_temporal_mvp_enabled_flag: boolean = gb.readBool();
    const _strong_intra_smoothing_enabled_flag: boolean = gb.readBool();
    const vui_parameters_present_flag: boolean = gb.readBool();
    if (vui_parameters_present_flag) {
      const aspect_ratio_info_present_flag: boolean = gb.readBool();
      if (aspect_ratio_info_present_flag) {
        const aspect_ratio_idc: number = gb.readByte();

        const sar_w_table: number[] = [1, 12, 10, 16, 40, 24, 20, 32, 80, 18, 15, 64, 160, 4, 3, 2];
        const sar_h_table: number[] = [1, 11, 11, 11, 33, 11, 11, 11, 33, 11, 11, 33, 99, 3, 2, 1];

        if (aspect_ratio_idc > 0 && aspect_ratio_idc <= 16) {
          sar_width = sar_w_table[aspect_ratio_idc - 1];
          sar_height = sar_h_table[aspect_ratio_idc - 1];
        } else if (aspect_ratio_idc === 255) {
          sar_width = gb.readBits(16);
          sar_height = gb.readBits(16);
        }
      }
      const overscan_info_present_flag: boolean = gb.readBool();
      if (overscan_info_present_flag) {
        gb.readBool();
      }
      const video_signal_type_present_flag: boolean = gb.readBool();
      if (video_signal_type_present_flag) {
        gb.readBits(3);
        gb.readBool();
        const colour_description_present_flag: boolean = gb.readBool();
        if (colour_description_present_flag) {
          gb.readByte();
          gb.readByte();
          gb.readByte();
        }
      }
      const chroma_loc_info_present_flag: boolean = gb.readBool();
      if (chroma_loc_info_present_flag) {
        gb.readUEG();
        gb.readUEG();
      }
      const _neutral_chroma_indication_flag: boolean = gb.readBool();
      field_seq_flag = gb.readBool();
      const _frame_field_info_present_flag: boolean = gb.readBool();
      default_display_window_flag = gb.readBool();
      if (default_display_window_flag) {
        gb.readUEG();
        gb.readUEG();
        gb.readUEG();
        gb.readUEG();
      }
      const vui_timing_info_present_flag: boolean = gb.readBool();
      if (vui_timing_info_present_flag) {
        fps_den = gb.readBits(32);
        fps_num = gb.readBits(32);
        const vui_poc_proportional_to_timing_flag: boolean = gb.readBool();
        if (vui_poc_proportional_to_timing_flag) {
          gb.readUEG();
        }
        const vui_hrd_parameters_present_flag: boolean = gb.readBool();
        if (vui_hrd_parameters_present_flag) {
          const commonInfPresentFlag: number = 1;
          let nal_hrd_parameters_present_flag: boolean = false;
          let vcl_hrd_parameters_present_flag: boolean = false;
          let sub_pic_hrd_params_present_flag: boolean = false;
          if (commonInfPresentFlag) {
            nal_hrd_parameters_present_flag = gb.readBool();
            vcl_hrd_parameters_present_flag = gb.readBool();
            if (nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag) {
              sub_pic_hrd_params_present_flag = gb.readBool();
              if (sub_pic_hrd_params_present_flag) {
                gb.readByte();
                gb.readBits(5);
                gb.readBool();
                gb.readBits(5);
              }
              const _bit_rate_scale: number = gb.readBits(4);
              const _cpb_size_scale: number = gb.readBits(4);
              if (sub_pic_hrd_params_present_flag) {
                gb.readBits(4);
              }
              gb.readBits(5);
              gb.readBits(5);
              gb.readBits(5);
            }
          }
          for (let i = 0; i <= max_sub_layers_minus1; i++) {
            const fixed_pic_rate_general_flag: boolean = gb.readBool();
            fps_fixed = fixed_pic_rate_general_flag;
            let fixed_pic_rate_within_cvs_flag: boolean = true;
            let cpbCnt: number = 1;
            if (!fixed_pic_rate_general_flag) {
              fixed_pic_rate_within_cvs_flag = gb.readBool();
            }
            let low_delay_hrd_flag: boolean = false;
            if (fixed_pic_rate_within_cvs_flag) {
              gb.readUEG();
            } else {
              low_delay_hrd_flag = gb.readBool();
            }
            if (!low_delay_hrd_flag) {
              cpbCnt = gb.readUEG() + 1;
            }
            if (nal_hrd_parameters_present_flag) {
              for (let j = 0; j < cpbCnt; j++) {
                gb.readUEG();
                gb.readUEG();
                if (sub_pic_hrd_params_present_flag) {
                  gb.readUEG();
                  gb.readUEG();
                }
              }
              gb.readBool();
            }
            if (vcl_hrd_parameters_present_flag) {
              for (let j = 0; j < cpbCnt; j++) {
                gb.readUEG();
                gb.readUEG();
                if (sub_pic_hrd_params_present_flag) {
                  gb.readUEG();
                  gb.readUEG();
                }
              }
              gb.readBool();
            }
          }
        }
      }
      const bitstream_restriction_flag: boolean = gb.readBool();
      if (bitstream_restriction_flag) {
        const _tiles_fixed_structure_flag: boolean = gb.readBool();
        const _motion_vectors_over_pic_boundaries_flag: boolean = gb.readBool();
        const _restricted_ref_pic_lists_flag: boolean = gb.readBool();
        min_spatial_segmentation_idc = gb.readUEG();
        const _max_bytes_per_pic_denom: number = gb.readUEG();
        const _max_bits_per_min_cu_denom: number = gb.readUEG();
        const _log2_max_mv_length_horizontal: number = gb.readUEG();
        const _log2_max_mv_length_vertical: number = gb.readUEG();
      }
    }
    const _sps_extension_flag: boolean = gb.readBool(); // ignore...

    // for meta data
    const codec_mimetype: string = `hvc1.${general_profile_idc}.1.L${general_level_idc}.B0`;

    const sub_wc: number = chroma_format_idc === 1 || chroma_format_idc === 2 ? 2 : 1;
    const sub_hc: number = chroma_format_idc === 1 ? 2 : 1;
    const codec_width: number = pic_width_in_luma_samples - (left_offset + right_offset) * sub_wc;
    const codec_height: number = pic_height_in_luma_samples - (top_offset + bottom_offset) * sub_hc;
    let sar_scale: number = 1;
    if (sar_width !== 1 && sar_height !== 1) {
      sar_scale = sar_width / sar_height;
    }

    gb.destroy();

    return {
      codec_mimetype,
      profile_string: H265NaluParser.getProfileString(general_profile_idc),
      level_string: H265NaluParser.getLevelString(general_level_idc),
      profile_idc: general_profile_idc,
      bit_depth: bit_depth_luma_minus8 + 8,
      ref_frames: 1, // FIXME!!!
      chroma_format: chroma_format_idc,
      chroma_format_string: H265NaluParser.getChromaFormatString(chroma_format_idc),

      general_level_idc,
      general_profile_space,
      general_tier_flag,
      general_profile_idc,
      general_profile_compatibility_flags_1,
      general_profile_compatibility_flags_2,
      general_profile_compatibility_flags_3,
      general_profile_compatibility_flags_4,
      general_constraint_indicator_flags_1,
      general_constraint_indicator_flags_2,
      general_constraint_indicator_flags_3,
      general_constraint_indicator_flags_4,
      general_constraint_indicator_flags_5,
      general_constraint_indicator_flags_6,
      min_spatial_segmentation_idc,
      constant_frame_rate: 0 /* FIXME!! fps_fixed ? 1 : 0? */,
      chroma_format_idc,
      bit_depth_luma_minus8,
      bit_depth_chroma_minus8,
      // VUI field_seq_flag OR PTL general_interlaced_source_flag (bit 6 of the
      // first constraint byte) — either signals interlaced-capable content
      interlaced_source: field_seq_flag || (general_constraint_indicator_flags_1 & 0x40) !== 0,

      frame_rate: {
        fixed: fps_fixed,
        fps: fps_num / fps_den,
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
        width: codec_width * sar_scale,
        height: codec_height,
      },
    };
  },

  parsePPS(uint8array: Uint8Array): H265PPSInfo {
    const rbsp: Uint8Array = H265NaluParser._ebsp2rbsp(uint8array);
    const gb: ExpGolomb = new ExpGolomb(rbsp);

    /* remove NALu Header */
    gb.readByte();
    gb.readByte();

    const _pic_parameter_set_id: number = gb.readUEG();
    const _seq_parameter_set_id: number = gb.readUEG();
    const _dependent_slice_segments_enabled_flag: boolean = gb.readBool();
    const _output_flag_present_flag: boolean = gb.readBool();
    const _num_extra_slice_header_bits: number = gb.readBits(3);
    const _sign_data_hiding_enabled_flag: boolean = gb.readBool();
    const _cabac_init_present_flag: boolean = gb.readBool();
    const _num_ref_idx_l0_default_active_minus1: number = gb.readUEG();
    const _num_ref_idx_l1_default_active_minus1: number = gb.readUEG();
    const _init_qp_minus26: number = gb.readSEG();
    const _constrained_intra_pred_flag: boolean = gb.readBool();
    const _transform_skip_enabled_flag: boolean = gb.readBool();
    const cu_qp_delta_enabled_flag: boolean = gb.readBool();
    if (cu_qp_delta_enabled_flag) {
      const _diff_cu_qp_delta_depth: number = gb.readUEG();
    }
    const _cb_qp_offset: number = gb.readSEG();
    const _cr_qp_offset: number = gb.readSEG();
    const _pps_slice_chroma_qp_offsets_present_flag: boolean = gb.readBool();
    const _weighted_pred_flag: boolean = gb.readBool();
    const _weighted_bipred_flag: boolean = gb.readBool();
    const _transquant_bypass_enabled_flag: boolean = gb.readBool();
    const tiles_enabled_flag: boolean = gb.readBool();
    const entropy_coding_sync_enabled_flag: boolean = gb.readBool();
    // and more ...

    // needs hvcC
    let parallelismType: number = 1; // slice-based parallel decoding
    if (entropy_coding_sync_enabled_flag && tiles_enabled_flag) {
      parallelismType = 0; // mixed-type parallel decoding
    } else if (entropy_coding_sync_enabled_flag) {
      parallelismType = 3; // wavefront-based parallel decoding
    } else if (tiles_enabled_flag) {
      parallelismType = 2; // tile-based parallel decoding
    }

    return {
      parallelismType,
    };
  },

  getChromaFormatString(chroma_idc: number): string {
    switch (chroma_idc) {
      case 0:
        return "4:0:0";
      case 1:
        return "4:2:0";
      case 2:
        return "4:2:2";
      case 3:
        return "4:4:4";
      default:
        return "Unknown";
    }
  },

  getProfileString(profile_idc: number): string {
    switch (profile_idc) {
      case 1:
        return "Main";
      case 2:
        return "Main10";
      case 3:
        return "MainSP";
      case 4:
        return "Rext";
      case 9:
        return "SCC";
      default:
        return "Unknown";
    }
  },

  getLevelString(level_idc: number): string {
    return (level_idc / 30).toFixed(1);
  },
};

export default H265NaluParser;

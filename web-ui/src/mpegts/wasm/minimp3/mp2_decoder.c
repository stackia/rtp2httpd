/*
 * MP2 Audio Decoder - WebAssembly Wrapper
 *
 * Decodes MPEG Audio Layer 2 only (Layer 3 code stripped to reduce WASM size).
 *
 * Decoding operates on whole PES payloads: a payload may contain multiple
 * MP2 frames, and a frame may straddle a PES boundary. The decoder loops
 * over all complete frames in the input and keeps the trailing partial
 * frame in an internal carry buffer that is prepended to the next payload.
 */

#define MINIMP3_ONLY_L12
#define MINIMP3_FLOAT_OUTPUT
#define MINIMP3_IMPLEMENTATION
#include "minimp3.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#include <stdlib.h>
#include <string.h>

/* Largest valid Layer I/II frame is ~1729 bytes (MPEG1 L2 384kbps @ 32kHz).
 * The carry buffer only ever needs to hold one partial frame. */
#define CARRY_MAX 2048
#define AUDIO_PROCESSOR_CODEC_MP2 1
#define AUDIO_PROCESSOR_GAP_SNAP_MS 5.0
#define AUDIO_PROCESSOR_MAX_SILENCE_GAP_MS 2000.0
#define AUDIO_PROCESSOR_PTS_DISCONTINUITY_MS 100.0
#define AUDIO_PROCESSOR_NEUTRAL_RATIO_EPSILON 0.001f

typedef struct WsolaOpaque Wsola;
extern Wsola* wsola_create(int sample_rate, int channels);
extern void wsola_destroy(Wsola* w);
extern void wsola_reset(Wsola* w);
extern void wsola_set_ratio(Wsola* w, float ratio);
extern double wsola_position(Wsola* w);
extern int wsola_has_tail(Wsola* w);
extern int wsola_process(Wsola* w, const float* input, int in_frames, float* output, int out_capacity);

typedef struct {
    mp3dec_t mp3d;
    unsigned char carry[CARRY_MAX];
    int carry_size;
    unsigned char* work;
    int work_capacity;
    int initialized;
    /* Set after a successful decode: the next frame is expected back-to-back,
     * so it can be decoded without re-verifying sync via the next header. */
    int synced;
} MpegAudioDecoder;

typedef struct {
    MpegAudioDecoder* decoder;
    Wsola* stretcher;
    int stretcher_sample_rate;
    int stretcher_channels;
    float ratio;

    float* decoded;
    int decoded_capacity_floats;
    float* continuous;
    int continuous_capacity_floats;
    float* stretched;
    int stretched_capacity_floats;

    int anchor_valid;
    double anchor_pts_ms;
    int samples_since_anchor;
    int anchor_sample_rate;

    int cursor_valid;
    double input_cursor_ms;
    double stretcher_base_ms;
    double output_stream_cursor_ms;
} SoftwareAudioProcessor;

/*
 * Create a new decoder instance
 * Returns: pointer to decoder state
 */
EXPORT
MpegAudioDecoder* mpeg_audio_decoder_create(void) {
    MpegAudioDecoder* decoder = (MpegAudioDecoder*)calloc(1, sizeof(MpegAudioDecoder));
    if (decoder) {
        mp3dec_init(&decoder->mp3d);
        decoder->initialized = 1;
    }
    return decoder;
}

/*
 * Destroy decoder instance and free memory
 */
EXPORT
void mpeg_audio_decoder_destroy(MpegAudioDecoder* decoder) {
    if (decoder) {
        free(decoder->work);
        free(decoder);
    }
}

/*
 * Decode all complete MPEG audio frames contained in (carry + input).
 *
 * Parameters:
 *   decoder         - decoder instance
 *   input           - input buffer containing MPEG audio data (PES payload)
 *   input_size      - size of input buffer in bytes
 *   output          - output buffer for interleaved float32 PCM
 *   output_capacity - capacity of output buffer in floats (all channels)
 *   out_info        - output array:
 *                     [0] total samples decoded per channel
 *                     [1] sample rate (Hz)
 *                     [2] channels
 *                     [3] frames decoded
 *                     [4] bytes kept in carry buffer
 *                     [5] input bytes consumed (incl. previous carry)
 *
 * Returns: total samples decoded per channel (0 if no complete frame found)
 */
EXPORT
int mpeg_audio_decode_payload(
    MpegAudioDecoder* decoder,
    const unsigned char* input,
    int input_size,
    float* output,
    int output_capacity,
    int* out_info
) {
    if (!decoder || !decoder->initialized || !input || !output || !out_info || input_size < 0) {
        return 0;
    }

    int total_in = decoder->carry_size + input_size;
    const unsigned char* stream = input;
    if (decoder->carry_size > 0) {
        if (total_in > decoder->work_capacity) {
            int new_cap = total_in < 8192 ? 8192 : total_in;
            unsigned char* grown = (unsigned char*)realloc(decoder->work, new_cap);
            if (!grown) {
                return 0;
            }
            decoder->work = grown;
            decoder->work_capacity = new_cap;
        }
        memcpy(decoder->work, decoder->carry, decoder->carry_size);
        memcpy(decoder->work + decoder->carry_size, input, input_size);
        stream = decoder->work;
    }

    int offset = 0;
    int total_samples = 0; /* per channel */
    int sample_rate = 0;
    int channels = 0;
    int frames = 0;

    /*
     * Frame boundaries are determined here (using minimp3's header helpers)
     * and each frame is passed to mp3dec_decode_frame with its exact length.
     * Passing larger buffers would make minimp3 require the *next* frame
     * header for sync verification, silently discarding the last complete
     * frame of every payload whose tail holds a partial frame.
     */
    while (total_in - offset >= HDR_SIZE) {
        const unsigned char* hdr = stream + offset;

        if (!hdr_valid(hdr)) {
            decoder->synced = 0;
            offset++;
            continue;
        }

        int frame_len = hdr_frame_bytes(hdr, 0) + hdr_padding(hdr);
        if (frame_len <= 0) {
            /* Free-format frames are not supported (never used for MP2 broadcast) */
            decoder->synced = 0;
            offset++;
            continue;
        }

        if (offset + frame_len > total_in) {
            /* Trailing partial frame: keep as carry */
            break;
        }

        if (!decoder->synced) {
            /* Unverified sync position: require the next header to line up.
             * If the payload ends before the next header, wait for more data. */
            if (offset + frame_len + HDR_SIZE > total_in) {
                break;
            }
            if (!hdr_compare(hdr, hdr + frame_len)) {
                offset++;
                continue;
            }
        }

        /* Stop if the next frame might not fit in the output buffer */
        if ((total_samples * (channels ? channels : 2)) + MINIMP3_MAX_SAMPLES_PER_FRAME > output_capacity) {
            break;
        }

        mp3dec_frame_info_t info;
        int samples = mp3dec_decode_frame(
            &decoder->mp3d,
            hdr,
            frame_len,
            output + (size_t)total_samples * (channels ? channels : 1),
            &info
        );

        if (samples > 0) {
            if (channels == 0) {
                channels = info.channels;
                sample_rate = info.hz;
            } else if (info.channels != channels || info.hz != sample_rate) {
                /* Stream parameters changed mid-payload: stop here, the
                 * remainder stays in carry and is decoded on the next call. */
                decoder->synced = 0;
                break;
            }
            total_samples += samples;
            frames++;
            decoder->synced = 1;
        } else {
            decoder->synced = 0;
        }

        offset += frame_len;
    }

    int remaining = total_in - offset;
    if (remaining > CARRY_MAX) {
        /* Undecodable blob larger than any valid frame: keep only the tail */
        offset += remaining - CARRY_MAX;
        remaining = CARRY_MAX;
    }
    if (remaining > 0) {
        memmove(decoder->carry, stream + offset, remaining);
    }
    decoder->carry_size = remaining;

    out_info[0] = total_samples;
    out_info[1] = sample_rate;
    out_info[2] = channels;
    out_info[3] = frames;
    out_info[4] = remaining;
    out_info[5] = offset;

    return total_samples;
}

/*
 * Get the maximum number of samples per frame
 * This is useful for allocating output buffers
 */
EXPORT
int mpeg_audio_max_samples_per_frame(void) {
    return MINIMP3_MAX_SAMPLES_PER_FRAME;
}

/*
 * Reset decoder state (incl. carry buffer)
 * Call this when seeking or switching streams
 */
EXPORT
void mpeg_audio_decoder_reset(MpegAudioDecoder* decoder) {
    if (decoder) {
        mp3dec_init(&decoder->mp3d);
        decoder->carry_size = 0;
        decoder->synced = 0;
    }
}

static int ensure_float_capacity(float** buffer, int* capacity, int needed) {
    if (needed <= *capacity) {
        return 1;
    }
    int new_cap = *capacity ? *capacity : 4096;
    while (new_cap < needed) {
        new_cap *= 2;
    }
    float* grown = (float*)realloc(*buffer, sizeof(float) * (size_t)new_cap);
    if (!grown) {
        return 0;
    }
    *buffer = grown;
    *capacity = new_cap;
    return 1;
}

static void processor_reset_timing(SoftwareAudioProcessor* processor) {
    processor->anchor_valid = 0;
    processor->anchor_pts_ms = 0.0;
    processor->samples_since_anchor = 0;
    processor->anchor_sample_rate = 0;
    processor->cursor_valid = 0;
    processor->input_cursor_ms = 0.0;
    processor->stretcher_base_ms = 0.0;
    processor->output_stream_cursor_ms = 0.0;
    if (processor->stretcher) {
        wsola_reset(processor->stretcher);
    }
}

static int processor_ensure_stretcher(SoftwareAudioProcessor* processor, int sample_rate, int channels) {
    if (sample_rate <= 0 || channels <= 0) {
        return 0;
    }
    if (processor->stretcher &&
        processor->stretcher_sample_rate == sample_rate &&
        processor->stretcher_channels == channels) {
        return 1;
    }
    if (processor->stretcher) {
        wsola_destroy(processor->stretcher);
        processor->stretcher = NULL;
    }
    processor->stretcher = wsola_create(sample_rate, channels);
    if (!processor->stretcher) {
        processor->stretcher_sample_rate = 0;
        processor->stretcher_channels = 0;
        return 0;
    }
    processor->stretcher_sample_rate = sample_rate;
    processor->stretcher_channels = channels;
    wsola_set_ratio(processor->stretcher, processor->ratio);
    return 1;
}

static void planarize(const float* interleaved, int frames, int channels, float* planes) {
    if (channels == 1) {
        memcpy(planes, interleaved, sizeof(float) * (size_t)frames);
        return;
    }
    if (channels == 2) {
        float* left = planes;
        float* right = planes + frames;
        for (int i = 0; i < frames; i++) {
            left[i] = interleaved[i * 2];
            right[i] = interleaved[i * 2 + 1];
        }
        return;
    }
    for (int ch = 0; ch < channels; ch++) {
        float* plane = planes + (size_t)ch * frames;
        for (int i = 0; i < frames; i++) {
            plane[i] = interleaved[(size_t)i * channels + ch];
        }
    }
}

EXPORT
SoftwareAudioProcessor* software_audio_processor_create(int codec) {
    if (codec != AUDIO_PROCESSOR_CODEC_MP2) {
        return NULL;
    }
    SoftwareAudioProcessor* processor = (SoftwareAudioProcessor*)calloc(1, sizeof(SoftwareAudioProcessor));
    if (!processor) {
        return NULL;
    }
    processor->decoder = mpeg_audio_decoder_create();
    if (!processor->decoder) {
        free(processor);
        return NULL;
    }
    processor->ratio = 1.0f;
    return processor;
}

EXPORT
void software_audio_processor_destroy(SoftwareAudioProcessor* processor) {
    if (!processor) {
        return;
    }
    if (processor->decoder) {
        mpeg_audio_decoder_destroy(processor->decoder);
    }
    if (processor->stretcher) {
        wsola_destroy(processor->stretcher);
    }
    free(processor->decoded);
    free(processor->continuous);
    free(processor->stretched);
    free(processor);
}

EXPORT
void software_audio_processor_reset(SoftwareAudioProcessor* processor) {
    if (!processor) {
        return;
    }
    if (processor->decoder) {
        mpeg_audio_decoder_reset(processor->decoder);
    }
    processor_reset_timing(processor);
}

EXPORT
void software_audio_processor_set_ratio(SoftwareAudioProcessor* processor, float ratio) {
    if (!processor) {
        return;
    }
    if (ratio < 0.5f) {
        ratio = 0.5f;
    } else if (ratio > 2.0f) {
        ratio = 2.0f;
    }
    processor->ratio = ratio;
    if (processor->stretcher) {
        wsola_set_ratio(processor->stretcher, ratio);
    }
}

/*
 * Output info layout (Float64Array, 6 entries):
 * [0] output frames per channel
 * [1] sample rate
 * [2] channels
 * [3] input stream start (ms)
 * [4] input stream end (ms)
 * [5] decoded frames before stretch/planarization
 */
EXPORT
int software_audio_processor_process(
    SoftwareAudioProcessor* processor,
    const unsigned char* input,
    int input_size,
    double pts_ms,
    float* output_planes,
    int output_capacity_frames,
    double* out_info
) {
    if (!processor || !processor->decoder || !input || !output_planes || !out_info || input_size < 0 ||
        output_capacity_frames <= 0) {
        return 0;
    }
    for (int i = 0; i < 6; i++) {
        out_info[i] = 0.0;
    }

    int max_frames = ((CARRY_MAX + input_size) / 96 + 2) * 1152;
    int decoded_capacity_floats = max_frames * 2;
    if (!ensure_float_capacity(&processor->decoded, &processor->decoded_capacity_floats, decoded_capacity_floats)) {
        return 0;
    }

    int decode_info[6] = {0};
    int decoded_samples = mpeg_audio_decode_payload(
        processor->decoder,
        input,
        input_size,
        processor->decoded,
        processor->decoded_capacity_floats,
        decode_info
    );
    if (decoded_samples <= 0) {
        return 0;
    }

    int sample_rate = decode_info[1];
    int channels = decode_info[2];
    if (sample_rate <= 0 || channels <= 0) {
        return 0;
    }

    if (!processor->anchor_valid || processor->anchor_sample_rate != sample_rate) {
        processor->anchor_valid = 1;
        processor->anchor_pts_ms = pts_ms;
        processor->samples_since_anchor = 0;
        processor->anchor_sample_rate = sample_rate;
    } else {
        double extrapolated_ms =
            processor->anchor_pts_ms + ((double)processor->samples_since_anchor / (double)sample_rate) * 1000.0;
        double delta_ms = pts_ms - extrapolated_ms;
        if (delta_ms < 0.0) {
            delta_ms = -delta_ms;
        }
        if (delta_ms > AUDIO_PROCESSOR_PTS_DISCONTINUITY_MS) {
            processor->anchor_pts_ms = pts_ms;
            processor->samples_since_anchor = 0;
        }
    }

    double chunk_start_ms =
        processor->anchor_pts_ms + ((double)processor->samples_since_anchor / (double)sample_rate) * 1000.0;
    processor->samples_since_anchor += decoded_samples;

    const float* input_pcm = processor->decoded;
    int input_frames = decoded_samples;
    double emit_start_ms = chunk_start_ms;

    if (!processor->cursor_valid) {
        processor->cursor_valid = 1;
        processor->input_cursor_ms = chunk_start_ms;
        processor->stretcher_base_ms = chunk_start_ms;
        processor->output_stream_cursor_ms = chunk_start_ms;
    }

    double delta_ms = chunk_start_ms - processor->input_cursor_ms;
    if (delta_ms > AUDIO_PROCESSOR_MAX_SILENCE_GAP_MS) {
        if (processor->stretcher) {
            wsola_reset(processor->stretcher);
        }
        processor->input_cursor_ms = chunk_start_ms;
        processor->stretcher_base_ms = chunk_start_ms;
        processor->output_stream_cursor_ms = chunk_start_ms;
        delta_ms = 0.0;
    }

    if (delta_ms < -AUDIO_PROCESSOR_GAP_SNAP_MS) {
        int cut_frames = (int)(((-delta_ms / 1000.0) * (double)sample_rate) + 0.5);
        if (cut_frames >= input_frames) {
            return 0;
        }
        input_pcm += (size_t)cut_frames * channels;
        input_frames -= cut_frames;
        emit_start_ms = chunk_start_ms + ((double)cut_frames / (double)sample_rate) * 1000.0;
    }

    int gap_frames = 0;
    if (delta_ms > AUDIO_PROCESSOR_GAP_SNAP_MS) {
        gap_frames = (int)(((delta_ms / 1000.0) * (double)sample_rate) + 0.5);
        emit_start_ms = processor->input_cursor_ms;
    }

    const float* continuous_pcm = input_pcm;
    int continuous_frames = input_frames;
    if (gap_frames > 0) {
        continuous_frames = gap_frames + input_frames;
        int needed_floats = continuous_frames * channels;
        if (!ensure_float_capacity(&processor->continuous, &processor->continuous_capacity_floats, needed_floats)) {
            return 0;
        }
        memset(processor->continuous, 0, sizeof(float) * (size_t)gap_frames * channels);
        memcpy(
            processor->continuous + (size_t)gap_frames * channels,
            input_pcm,
            sizeof(float) * (size_t)input_frames * channels
        );
        continuous_pcm = processor->continuous;
    }

    double input_end_ms = emit_start_ms + ((double)continuous_frames / (double)sample_rate) * 1000.0;
    processor->input_cursor_ms = input_end_ms;

    int use_stretcher =
        ((processor->ratio < 1.0f - AUDIO_PROCESSOR_NEUTRAL_RATIO_EPSILON) ||
         (processor->ratio > 1.0f + AUDIO_PROCESSOR_NEUTRAL_RATIO_EPSILON));
    if (!use_stretcher && processor->stretcher && wsola_has_tail(processor->stretcher)) {
        use_stretcher = 1;
    }

    const float* output_interleaved = continuous_pcm;
    int output_frames = continuous_frames;
    double stream_start_ms = emit_start_ms;
    double stream_end_ms = input_end_ms;

    if (use_stretcher) {
        if (!processor_ensure_stretcher(processor, sample_rate, channels)) {
            return 0;
        }
        wsola_set_ratio(processor->stretcher, processor->ratio);
        int needed_frames = continuous_frames * 2 + 8192;
        int needed_floats = needed_frames * channels;
        if (!ensure_float_capacity(&processor->stretched, &processor->stretched_capacity_floats, needed_floats)) {
            return 0;
        }
        output_frames = wsola_process(
            processor->stretcher,
            continuous_pcm,
            continuous_frames,
            processor->stretched,
            needed_frames
        );
        if (output_frames <= 0) {
            out_info[0] = 0.0;
            out_info[1] = (double)sample_rate;
            out_info[2] = (double)channels;
            out_info[3] = processor->output_stream_cursor_ms;
            out_info[4] = processor->output_stream_cursor_ms;
            out_info[5] = (double)continuous_frames;
            return 0;
        }
        output_interleaved = processor->stretched;
        stream_start_ms = processor->output_stream_cursor_ms;
        stream_end_ms = processor->stretcher_base_ms +
                        (wsola_position(processor->stretcher) / (double)sample_rate) * 1000.0;
        processor->output_stream_cursor_ms = stream_end_ms;
    } else {
        processor->stretcher_base_ms = input_end_ms;
        processor->output_stream_cursor_ms = input_end_ms;
    }

    if (output_frames > output_capacity_frames) {
        return 0;
    }
    planarize(output_interleaved, output_frames, channels, output_planes);

    out_info[0] = (double)output_frames;
    out_info[1] = (double)sample_rate;
    out_info[2] = (double)channels;
    out_info[3] = stream_start_ms;
    out_info[4] = stream_end_ms;
    out_info[5] = (double)continuous_frames;

    return output_frames;
}

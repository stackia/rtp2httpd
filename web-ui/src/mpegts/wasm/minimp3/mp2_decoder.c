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
 *                     [6] samples/ch decoded from frames that began before this input
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

    int carry_at_start = decoder->carry_size;
    int total_in = carry_at_start + input_size;
    if (total_in > decoder->work_capacity) {
        int new_cap = total_in < 8192 ? 8192 : total_in;
        unsigned char* grown = (unsigned char*)realloc(decoder->work, new_cap);
        if (!grown) {
            return 0;
        }
        decoder->work = grown;
        decoder->work_capacity = new_cap;
    }
    if (decoder->carry_size > 0) {
        memcpy(decoder->work, decoder->carry, decoder->carry_size);
    }
    memcpy(decoder->work + decoder->carry_size, input, input_size);

    int offset = 0;
    int total_samples = 0; /* per channel */
    int sample_rate = 0;
    int channels = 0;
    int frames = 0;
    int samples_before_input = 0;

    /*
     * Frame boundaries are determined here (using minimp3's header helpers)
     * and each frame is passed to mp3dec_decode_frame with its exact length.
     * Passing larger buffers would make minimp3 require the *next* frame
     * header for sync verification, silently discarding the last complete
     * frame of every payload whose tail holds a partial frame.
     */
    while (total_in - offset >= HDR_SIZE) {
        const unsigned char* hdr = decoder->work + offset;

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
            if (offset < carry_at_start) {
                samples_before_input += samples;
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
        memmove(decoder->carry, decoder->work + offset, remaining);
    }
    decoder->carry_size = remaining;

    out_info[0] = total_samples;
    out_info[1] = sample_rate;
    out_info[2] = channels;
    out_info[3] = frames;
    out_info[4] = remaining;
    out_info[5] = offset;
    out_info[6] = samples_before_input;

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

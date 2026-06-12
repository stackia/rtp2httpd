/*
 * MP2 Audio Decoder - WebAssembly Wrapper
 *
 * Decodes MPEG Audio Layer 2 only (Layer 3 code stripped to reduce WASM size).
 */

#define MINIMP3_ONLY_L12
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

/* Decoder state structure */
typedef struct {
    mp3dec_t mp3d;
    int initialized;
} MpegAudioDecoder;

/*
 * Create a new decoder instance
 * Returns: pointer to decoder state
 */
EXPORT
MpegAudioDecoder* mpeg_audio_decoder_create(void) {
    MpegAudioDecoder* decoder = (MpegAudioDecoder*)malloc(sizeof(MpegAudioDecoder));
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
        free(decoder);
    }
}

/*
 * Decode a single frame of MPEG audio
 *
 * Parameters:
 *   decoder     - decoder instance
 *   input       - input buffer containing MPEG audio data
 *   input_size  - size of input buffer in bytes
 *   output      - output buffer for PCM samples (must be at least MINIMP3_MAX_SAMPLES_PER_FRAME * sizeof(int16_t))
 *   out_info    - output array for frame info: [samples_decoded, sample_rate, channels, layer, bitrate_kbps, frame_bytes]
 *
 * Returns: number of samples decoded per channel (0 if no frame found)
 */
EXPORT
int mpeg_audio_decode_frame(
    MpegAudioDecoder* decoder,
    const unsigned char* input,
    int input_size,
    short* output,
    int* out_info
) {
    if (!decoder || !decoder->initialized || !input || !output || !out_info) {
        return 0;
    }

    mp3dec_frame_info_t info;
    int samples = mp3dec_decode_frame(&decoder->mp3d, input, input_size, output, &info);

    /* Fill output info array */
    out_info[0] = samples;           /* samples per channel */
    out_info[1] = info.hz;           /* sample rate */
    out_info[2] = info.channels;     /* number of channels */
    out_info[3] = info.layer;        /* MPEG layer (1, 2, or 3) */
    out_info[4] = info.bitrate_kbps; /* bitrate in kbps */
    out_info[5] = info.frame_bytes;  /* size of the frame in bytes */

    return samples;
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
 * Reset decoder state
 * Call this when seeking or switching streams
 */
EXPORT
void mpeg_audio_decoder_reset(MpegAudioDecoder* decoder) {
    if (decoder) {
        mp3dec_init(&decoder->mp3d);
    }
}

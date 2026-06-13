/*
 * WSOLA (Waveform Similarity Overlap-Add) time stretcher
 *
 * Pitch-preserving tempo change for interleaved float32 PCM. Used by the
 * web player to keep software-decoded audio in sync with the video clock
 * (live-sync playbackRate catch-up plus small drift corrections).
 *
 * Streaming design:
 *  - input is appended to an internal FIFO measured in frames (1 frame =
 *    one sample per channel);
 *  - `pos` is the ideal analysis position in absolute input frames. Each
 *    synthesis cycle emits `seq` output frames and advances `pos` by
 *    `seq * ratio`, so output duration = input duration / ratio;
 *  - each cycle searches ±seek frames around `pos` for the candidate
 *    segment best matching the continuation of the previous output (the
 *    `tail`), then crossfades over `overlap` frames;
 *  - ratio == 1 bypasses the synthesis loop entirely (bit-exact passthrough,
 *    with a single crossfade when transitioning out of stretching).
 *
 * wsola_position() exposes `pos`: the absolute input frame corresponding to
 * the end of all output emitted so far. The JS layer uses it to map output
 * back to stream time exactly, regardless of ratio changes.
 */

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define SEQ_MS 30
#define OVERLAP_MS 12
#define SEEK_MS 10
#define MAX_CHANNELS 2

typedef struct {
    int sample_rate;
    int channels;
    float ratio;

    int seq;     /* output frames per synthesis cycle */
    int overlap; /* crossfade length in frames */
    int seek;    /* max search offset in frames */

    float* inbuf; /* interleaved FIFO */
    int in_capacity; /* frames */
    int in_len;      /* frames */
    double in_base;  /* absolute frame index of inbuf[0] */

    double pos; /* ideal analysis position (absolute input frames) */

    float* tail; /* overlap*channels, unwindowed continuation reference */
    int has_tail;

    float* fade;      /* overlap, raised-cosine 0..1 */
    float* tail_mono; /* overlap, scratch */
    float* mix;       /* scratch mono mix of the search region */
    float* energy;    /* scratch prefix energy of mix */
    int scratch_capacity;
} Wsola;

EXPORT
Wsola* wsola_create(int sample_rate, int channels) {
    if (sample_rate <= 0 || channels <= 0 || channels > MAX_CHANNELS) {
        return NULL;
    }
    Wsola* w = (Wsola*)calloc(1, sizeof(Wsola));
    if (!w) {
        return NULL;
    }
    w->sample_rate = sample_rate;
    w->channels = channels;
    w->ratio = 1.0f;
    w->seq = sample_rate * SEQ_MS / 1000;
    w->overlap = sample_rate * OVERLAP_MS / 1000;
    w->seek = sample_rate * SEEK_MS / 1000;

    w->tail = (float*)calloc((size_t)w->overlap * channels, sizeof(float));
    w->fade = (float*)malloc(sizeof(float) * w->overlap);
    w->tail_mono = (float*)malloc(sizeof(float) * w->overlap);
    if (!w->tail || !w->fade || !w->tail_mono) {
        free(w->tail);
        free(w->fade);
        free(w->tail_mono);
        free(w);
        return NULL;
    }
    for (int i = 0; i < w->overlap; i++) {
        w->fade[i] = 0.5f - 0.5f * cosf((float)M_PI * ((float)i + 0.5f) / (float)w->overlap);
    }
    return w;
}

EXPORT
void wsola_destroy(Wsola* w) {
    if (!w) {
        return;
    }
    free(w->inbuf);
    free(w->tail);
    free(w->fade);
    free(w->tail_mono);
    free(w->mix);
    free(w->energy);
    free(w);
}

/* Clears buffered input and position; deliberately keeps the configured
 * ratio so a resync during rate-changed playback stays at the right tempo. */
EXPORT
void wsola_reset(Wsola* w) {
    if (!w) {
        return;
    }
    w->in_len = 0;
    w->in_base = 0;
    w->pos = 0;
    w->has_tail = 0;
}

EXPORT
void wsola_set_ratio(Wsola* w, float ratio) {
    if (!w) {
        return;
    }
    if (ratio < 0.5f) {
        ratio = 0.5f;
    } else if (ratio > 2.0f) {
        ratio = 2.0f;
    }
    w->ratio = ratio;
}

EXPORT
double wsola_position(Wsola* w) {
    return w ? w->pos : 0.0;
}

static int wsola_ensure_in_capacity(Wsola* w, int frames) {
    if (frames <= w->in_capacity) {
        return 1;
    }
    int new_cap = w->in_capacity ? w->in_capacity : 4096;
    while (new_cap < frames) {
        new_cap *= 2;
    }
    float* grown = (float*)realloc(w->inbuf, sizeof(float) * (size_t)new_cap * w->channels);
    if (!grown) {
        return 0;
    }
    w->inbuf = grown;
    w->in_capacity = new_cap;
    return 1;
}

static int wsola_ensure_scratch(Wsola* w, int frames) {
    if (frames <= w->scratch_capacity) {
        return 1;
    }
    float* mix = (float*)realloc(w->mix, sizeof(float) * frames);
    if (!mix) {
        return 0;
    }
    w->mix = mix;
    float* energy = (float*)realloc(w->energy, sizeof(float) * (frames + 1));
    if (!energy) {
        return 0;
    }
    w->energy = energy;
    w->scratch_capacity = frames;
    return 1;
}

/* Mono mix of `frames` frames starting at relative frame index `rel`. */
static void wsola_mono_mix(const Wsola* w, int rel, int frames, float* dst) {
    const int ch = w->channels;
    const float* src = w->inbuf + (size_t)rel * ch;
    if (ch == 1) {
        memcpy(dst, src, sizeof(float) * frames);
        return;
    }
    for (int i = 0; i < frames; i++) {
        dst[i] = src[i * 2] + src[i * 2 + 1];
    }
}

/* Drop input frames that are no longer reachable by the search window. */
static void wsola_discard(Wsola* w) {
    double keep_from = floor(w->pos) - (double)(w->seek + w->overlap);
    int drop = (int)(keep_from - w->in_base);
    if (drop <= 0) {
        return;
    }
    if (drop > w->in_len) {
        drop = w->in_len;
    }
    if (drop < w->in_len) {
        memmove(w->inbuf, w->inbuf + (size_t)drop * w->channels, sizeof(float) * (size_t)(w->in_len - drop) * w->channels);
    }
    w->in_len -= drop;
    w->in_base += drop;
}

/*
 * Feed `in_frames` frames of interleaved PCM, retrieve as many output frames
 * as can be produced. Returns the number of frames written to `output`
 * (at most `out_capacity` frames).
 */
EXPORT
int wsola_process(Wsola* w, const float* input, int in_frames, float* output, int out_capacity) {
    if (!w || in_frames < 0 || out_capacity < 0) {
        return 0;
    }
    const int ch = w->channels;

    if (in_frames > 0 && input) {
        if (!wsola_ensure_in_capacity(w, w->in_len + in_frames)) {
            return 0;
        }
        memcpy(w->inbuf + (size_t)w->in_len * ch, input, sizeof(float) * (size_t)in_frames * ch);
        w->in_len += in_frames;
    }

    int out_frames = 0;
    const int bypass = fabsf(w->ratio - 1.0f) < 0.001f;

    if (bypass) {
        int rel = (int)(w->pos - w->in_base);
        if (rel < 0) {
            /* pos behind buffer start (shouldn't happen): jump forward */
            w->pos = w->in_base;
            rel = 0;
        }
        int avail = w->in_len - rel;
        int n = avail < out_capacity ? avail : out_capacity;
        if (n > 0) {
            memcpy(output, w->inbuf + (size_t)rel * ch, sizeof(float) * (size_t)n * ch);
            if (w->has_tail) {
                /* Transition out of stretching: crossfade with the stored tail */
                int fl = w->overlap < n ? w->overlap : n;
                for (int i = 0; i < fl; i++) {
                    float a = w->fade[i + (w->overlap - fl)];
                    for (int c = 0; c < ch; c++) {
                        output[i * ch + c] = w->tail[i * ch + c] * (1.0f - a) + output[i * ch + c] * a;
                    }
                }
                w->has_tail = 0;
            }
            w->pos += n;
            out_frames = n;
        }
        wsola_discard(w);
        return out_frames;
    }

    /* Stretching: ensure we have a continuation reference */
    if (!w->has_tail) {
        int rel = (int)(w->pos - w->in_base) - w->overlap;
        if (rel >= 0 && rel + w->overlap <= w->in_len) {
            memcpy(w->tail, w->inbuf + (size_t)rel * ch, sizeof(float) * (size_t)w->overlap * ch);
        } else {
            memset(w->tail, 0, sizeof(float) * (size_t)w->overlap * ch);
        }
        w->has_tail = 1;
    }

    for (;;) {
        if (out_frames + w->seq > out_capacity) {
            break;
        }
        double need_end = w->pos + (double)(w->seek + w->seq + w->overlap);
        if (need_end > w->in_base + w->in_len) {
            break; /* not enough input buffered for a full cycle */
        }

        int p = (int)llround(w->pos - w->in_base);
        int lo = p - w->seek;
        if (lo < 0) {
            lo = 0;
        }
        int hi = p + w->seek;
        /* candidates q in [lo, hi]; each needs overlap frames for matching
         * and seq+overlap frames total — guaranteed by need_end check for
         * q <= hi; lo >= 0 guaranteed by clamp. */
        int region = (hi - lo) + w->overlap;
        if (!wsola_ensure_scratch(w, region)) {
            break;
        }
        wsola_mono_mix(w, lo, region, w->mix);
        w->energy[0] = 0.0f;
        for (int i = 0; i < region; i++) {
            w->energy[i + 1] = w->energy[i] + w->mix[i] * w->mix[i];
        }
        if (ch == 1) {
            memcpy(w->tail_mono, w->tail, sizeof(float) * w->overlap);
        } else {
            for (int i = 0; i < w->overlap; i++) {
                w->tail_mono[i] = w->tail[i * 2] + w->tail[i * 2 + 1];
            }
        }

        int best_q = p;
        float best_score = -1e30f;
        for (int q = lo; q <= hi; q++) {
            const float* cand = w->mix + (q - lo);
            float dot = 0.0f;
            for (int i = 0; i < w->overlap; i++) {
                dot += w->tail_mono[i] * cand[i];
            }
            float cand_energy = w->energy[q - lo + w->overlap] - w->energy[q - lo];
            float score = dot / sqrtf(cand_energy + 1e-9f);
            if (score > best_score) {
                best_score = score;
                best_q = q;
            }
        }

        const float* seg = w->inbuf + (size_t)best_q * ch;
        for (int i = 0; i < w->overlap; i++) {
            float a = w->fade[i];
            for (int c = 0; c < ch; c++) {
                output[(out_frames + i) * ch + c] = w->tail[i * ch + c] * (1.0f - a) + seg[i * ch + c] * a;
            }
        }
        memcpy(
            output + (size_t)(out_frames + w->overlap) * ch,
            seg + (size_t)w->overlap * ch,
            sizeof(float) * (size_t)(w->seq - w->overlap) * ch
        );
        memcpy(w->tail, seg + (size_t)w->seq * ch, sizeof(float) * (size_t)w->overlap * ch);

        out_frames += w->seq;
        w->pos += (double)w->seq * w->ratio;
    }

    wsola_discard(w);
    return out_frames;
}

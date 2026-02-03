/**
 * RTP Forward Error Correction (FEC) Module
 *
 * Handles FEC packet reception, group management, and packet recovery
 * for RTP streams that use Reed-Solomon FEC on a separate multicast port.
 */

#ifndef RTP_FEC_H
#define RTP_FEC_H

#include <stdint.h>

#include "buffer_pool.h"
#include "rs_fec.h"

/* Maximum number of FEC groups to track per stream */
#define FEC_MAX_GROUPS 32

/**
 * FEC packet header structure (12 bytes after RTP header stripping)
 * Matches FEC_DATA_STRUCT from rtpproto.c
 */
typedef struct fec_packet_header_s {
  uint16_t rtp_begin_seq; /* First RTP sequence this FEC covers */
  uint16_t rtp_end_seq;   /* Last RTP sequence this FEC covers */
  uint8_t redund_num;     /* Number of FEC packets (m) */
  uint8_t redund_idx;     /* This FEC packet's index (0-based) */
  uint16_t fec_len;       /* FEC parity data length */
  uint16_t rtp_len;       /* Original RTP payload length */
  uint16_t reserved;
} __attribute__((packed)) fec_packet_header_t;

/**
 * Stored FEC packet data
 */
typedef struct fec_packet_s {
  uint8_t *data;     /* FEC parity data (allocated) */
  uint16_t data_len; /* Length of parity data */
  uint8_t received;  /* 1 if this FEC slot is filled */
} fec_packet_t;

/**
 * FEC group - tracks one encoding block
 * RTP packets are stored in the reorder buffer, not here.
 */
typedef struct fec_group_s {
  uint16_t begin_seq;      /* First RTP sequence in this group */
  uint16_t end_seq;        /* Last RTP sequence in this group */
  int k;                   /* Number of data packets */
  int m;                   /* Number of FEC packets */
  uint16_t rtp_len;        /* Original RTP payload length */
  int fec_received;        /* Count of received FEC packets */
  fec_packet_t *fec_slots; /* Array of m FEC packet slots (NULL = inactive) */
} fec_group_t;

/* Forward declaration for rtp_reorder_t */
typedef struct rtp_reorder_s rtp_reorder_t;

/**
 * FEC context - per-stream FEC state
 */
typedef struct fec_context_s {
  int initialized;                    /* Flag: context has been initialized */
  int sock;                           /* FEC multicast socket (-1 if disabled) */
  uint16_t fec_port;                  /* FEC multicast port */
  uint8_t fec_active;                 /* 1 if FEC packets have been received */
  fec_group_t groups[FEC_MAX_GROUPS]; /* Active FEC groups */
  int group_count;                    /* Number of active groups */

  /* min_end_seq caching for efficient expired group detection */
  uint16_t min_end_seq;               /* Minimum end_seq among active groups */
  uint8_t min_end_seq_valid;          /* 1 if min_end_seq is valid */

  rtp_reorder_t *reorder;             /* Associated reorder buffer */

  rs_fec_t *rs_decoder;               /* Cached RS decoder (lazy init) */
  int rs_k;                           /* Current decoder k parameter */
  int rs_m;                           /* Current decoder m parameter */

  /* Statistics */
  uint64_t packets_lost;        /* Total packets lost (not recovered) */
  uint64_t recovery_successes;  /* Packets successfully recovered via FEC */
} fec_context_t;

/**
 * Initialize FEC context
 *
 * @param ctx FEC context to initialize
 * @param fec_port FEC multicast port (0 to disable FEC)
 * @param reorder Associated reorder buffer for RTP packet storage
 */
void fec_init(fec_context_t *ctx, uint16_t fec_port, rtp_reorder_t *reorder);

/**
 * Cleanup FEC context and free all resources
 *
 * @param ctx FEC context to cleanup
 * @param epoll_fd Epoll file descriptor for socket cleanup (-1 if not needed)
 */
void fec_cleanup(fec_context_t *ctx, int epoll_fd);

/**
 * Process a received FEC packet
 *
 * When creating a new FEC group requires evicting an old group,
 * the reorder buffer is used to release RTP buffers for the evicted group.
 *
 * @param ctx FEC context
 * @param data Packet data (including RTP header)
 * @param len Packet length
 * @return 0 on success, -1 on error
 */
int fec_process_packet(fec_context_t *ctx, const uint8_t *data, int len);

/**
 * Attempt to recover a lost RTP packet using FEC
 *
 * @param ctx FEC context
 * @param seq RTP sequence number of lost packet
 * @param recovered_data Output: pointer to recovered data (caller must free)
 * @param recovered_len Output: length of recovered data
 * @return 0 on success (data recovered), -1 on failure (cannot recover)
 */
int fec_attempt_recovery(fec_context_t *ctx, uint16_t seq,
                         uint8_t **recovered_data, int *recovered_len);

/**
 * Release expired FEC groups and their RTP buffers
 *
 * Called when base_seq advances past min_end_seq.
 * Scans all groups, releases those with end_seq < base_seq,
 * and recalculates min_end_seq.
 *
 * @param ctx FEC context
 * @param base_seq Current base sequence number from reorder buffer
 */
void fec_release_expired_groups(fec_context_t *ctx, uint16_t base_seq);

/**
 * Check if FEC is enabled for this context
 *
 * FEC is enabled when either:
 * - fec_port > 0: Separate FEC multicast port configured via ?fec=<port>
 * - fec_active: FEC packets detected on RTP socket (mixed-port mode)
 *
 * @param ctx FEC context
 * @return 1 if enabled, 0 if disabled
 */
static inline int fec_is_enabled(const fec_context_t *ctx) {
  return ctx && (ctx->fec_port > 0 || ctx->fec_active);
}

#endif /* RTP_FEC_H */

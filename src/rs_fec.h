/**
 * Reed-Solomon Forward Error Correction (FEC) Decoder
 *
 * Ported from multimedia-ffmpeg-vendor/libavformat/RS_fec.h
 */

#ifndef RS_FEC_H
#define RS_FEC_H

#include <stdint.h>

#define SWAP(a, b)        \
  {                       \
    int temp = (a);       \
    (a) = (b);            \
    (b) = temp;           \
  }

typedef struct rs_fec_s {
  int k, m;           /* parameters of the code */
  uint8_t **en_GM;    /* generator matrix */
  uint8_t *en_GM_buf; /* contiguous buffer for en_GM */
} rs_fec_t;

/**
 * Initialize RS FEC tables (called automatically by rs_fec_new)
 */
void rs_fec_init(void);

/**
 * Create a new RS FEC decoder
 * @param data_pkt_num Number of data packets (k)
 * @param fec_pkt_num Number of FEC packets (m)
 * @return RS FEC context, or NULL on failure
 */
rs_fec_t *rs_fec_new(int data_pkt_num, int fec_pkt_num);

/**
 * Free RS FEC decoder
 * @param p RS FEC context
 */
void rs_fec_free(rs_fec_t *p);

/**
 * Decode/recover lost data packets using RS erasure coding
 *
 * @param code RS FEC decoder context
 * @param data Array of k data packet buffers
 * @param fec_data Array of m FEC packet buffers
 * @param lost_map Array of k+m flags: 1=received, 0=lost
 * @param data_len Length of each packet's data
 * @return 0 on success, -1 on failure
 */
int rs_fec_decode(rs_fec_t *code, uint8_t **data, uint8_t **fec_data,
                  int lost_map[], int data_len);

#endif /* RS_FEC_H */

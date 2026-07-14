#ifndef __HTTP_CHUNKED_DECODER_H__
#define __HTTP_CHUNKED_DECODER_H__

#include <stddef.h>
#include <stdint.h>

#define HTTP_CHUNKED_MAX_SIZE_LINE 4096
#define HTTP_CHUNKED_MAX_TRAILER_SIZE 8192

typedef enum {
  HTTP_CHUNKED_STATE_SIZE = 0,
  HTTP_CHUNKED_STATE_EXTENSION,
  HTTP_CHUNKED_STATE_SIZE_LF,
  HTTP_CHUNKED_STATE_DATA,
  HTTP_CHUNKED_STATE_DATA_CR,
  HTTP_CHUNKED_STATE_DATA_LF,
  HTTP_CHUNKED_STATE_TRAILER_START,
  HTTP_CHUNKED_STATE_TRAILER,
  HTTP_CHUNKED_STATE_TRAILER_LF,
  HTTP_CHUNKED_STATE_TRAILER_END_LF,
  HTTP_CHUNKED_STATE_DONE,
  HTTP_CHUNKED_STATE_ERROR
} http_chunked_state_t;

typedef enum {
  HTTP_CHUNKED_DECODE_ERROR = -1,
  HTTP_CHUNKED_DECODE_NEED_MORE = 0,
  HTTP_CHUNKED_DECODE_DONE = 1
} http_chunked_decode_result_t;

typedef int (*http_chunked_emit_cb)(void *opaque, const uint8_t *data, size_t len);

typedef struct http_chunked_decoder_s {
  http_chunked_state_t state;
  uint64_t chunk_size;
  uint64_t chunk_remaining;
  size_t size_line_length;
  size_t trailer_size;
  int saw_size_digit;
} http_chunked_decoder_t;

void http_chunked_decoder_init(http_chunked_decoder_t *decoder);

http_chunked_decode_result_t http_chunked_decoder_feed(http_chunked_decoder_t *decoder, const uint8_t *input,
                                                       size_t input_len, http_chunked_emit_cb emit, void *opaque,
                                                       size_t *consumed);

http_chunked_decode_result_t http_chunked_decoder_finish(http_chunked_decoder_t *decoder);

#endif /* __HTTP_CHUNKED_DECODER_H__ */

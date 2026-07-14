#include "http_chunked_decoder.h"
#include <string.h>

static int http_chunked_hex_value(uint8_t ch) {
  if (ch >= '0' && ch <= '9')
    return ch - '0';
  if (ch >= 'a' && ch <= 'f')
    return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F')
    return ch - 'A' + 10;
  return -1;
}

static http_chunked_decode_result_t http_chunked_fail(http_chunked_decoder_t *decoder, size_t offset,
                                                      size_t *consumed) {
  decoder->state = HTTP_CHUNKED_STATE_ERROR;
  if (consumed)
    *consumed = offset;
  return HTTP_CHUNKED_DECODE_ERROR;
}

static int http_chunked_count_size_byte(http_chunked_decoder_t *decoder) {
  decoder->size_line_length++;
  return decoder->size_line_length <= HTTP_CHUNKED_MAX_SIZE_LINE ? 0 : -1;
}

static int http_chunked_count_trailer_byte(http_chunked_decoder_t *decoder) {
  decoder->trailer_size++;
  return decoder->trailer_size <= HTTP_CHUNKED_MAX_TRAILER_SIZE ? 0 : -1;
}

void http_chunked_decoder_init(http_chunked_decoder_t *decoder) {
  if (!decoder)
    return;
  memset(decoder, 0, sizeof(*decoder));
  decoder->state = HTTP_CHUNKED_STATE_SIZE;
}

http_chunked_decode_result_t http_chunked_decoder_feed(http_chunked_decoder_t *decoder, const uint8_t *input,
                                                       size_t input_len, http_chunked_emit_cb emit, void *opaque,
                                                       size_t *consumed) {
  size_t offset = 0;

  if (consumed)
    *consumed = 0;
  if (!decoder || (!input && input_len > 0))
    return HTTP_CHUNKED_DECODE_ERROR;
  if (decoder->state == HTTP_CHUNKED_STATE_ERROR)
    return HTTP_CHUNKED_DECODE_ERROR;
  if (decoder->state == HTTP_CHUNKED_STATE_DONE)
    return input_len == 0 ? HTTP_CHUNKED_DECODE_DONE : http_chunked_fail(decoder, 0, consumed);

  while (offset < input_len) {
    uint8_t ch = input[offset];

    switch (decoder->state) {
    case HTTP_CHUNKED_STATE_SIZE: {
      int digit;
      if (http_chunked_count_size_byte(decoder) < 0)
        return http_chunked_fail(decoder, offset, consumed);

      digit = http_chunked_hex_value(ch);
      if (digit >= 0) {
        if (decoder->chunk_size > (UINT64_MAX - (uint64_t)digit) / 16)
          return http_chunked_fail(decoder, offset, consumed);
        decoder->chunk_size = decoder->chunk_size * 16 + (uint64_t)digit;
        decoder->saw_size_digit = 1;
        offset++;
      } else if (ch == ';' && decoder->saw_size_digit) {
        decoder->state = HTTP_CHUNKED_STATE_EXTENSION;
        offset++;
      } else if (ch == '\r' && decoder->saw_size_digit) {
        decoder->state = HTTP_CHUNKED_STATE_SIZE_LF;
        offset++;
      } else {
        return http_chunked_fail(decoder, offset, consumed);
      }
      break;
    }

    case HTTP_CHUNKED_STATE_EXTENSION:
      if (http_chunked_count_size_byte(decoder) < 0)
        return http_chunked_fail(decoder, offset, consumed);
      if (ch == '\r') {
        decoder->state = HTTP_CHUNKED_STATE_SIZE_LF;
        offset++;
      } else if (ch == '\n' || (ch < 0x20 && ch != '\t') || ch == 0x7f) {
        return http_chunked_fail(decoder, offset, consumed);
      } else {
        offset++;
      }
      break;

    case HTTP_CHUNKED_STATE_SIZE_LF:
      if (ch != '\n')
        return http_chunked_fail(decoder, offset, consumed);
      offset++;
      decoder->chunk_remaining = decoder->chunk_size;
      decoder->state = decoder->chunk_size == 0 ? HTTP_CHUNKED_STATE_TRAILER_START : HTTP_CHUNKED_STATE_DATA;
      break;

    case HTTP_CHUNKED_STATE_DATA: {
      size_t available = input_len - offset;
      size_t emit_len = decoder->chunk_remaining < (uint64_t)available ? (size_t)decoder->chunk_remaining : available;
      if (emit_len > 0 && (!emit || emit(opaque, input + offset, emit_len) < 0))
        return http_chunked_fail(decoder, offset, consumed);
      offset += emit_len;
      decoder->chunk_remaining -= emit_len;
      if (decoder->chunk_remaining == 0)
        decoder->state = HTTP_CHUNKED_STATE_DATA_CR;
      break;
    }

    case HTTP_CHUNKED_STATE_DATA_CR:
      if (ch != '\r')
        return http_chunked_fail(decoder, offset, consumed);
      decoder->state = HTTP_CHUNKED_STATE_DATA_LF;
      offset++;
      break;

    case HTTP_CHUNKED_STATE_DATA_LF:
      if (ch != '\n')
        return http_chunked_fail(decoder, offset, consumed);
      decoder->state = HTTP_CHUNKED_STATE_SIZE;
      decoder->chunk_size = 0;
      decoder->size_line_length = 0;
      decoder->saw_size_digit = 0;
      offset++;
      break;

    case HTTP_CHUNKED_STATE_TRAILER_START:
      if (http_chunked_count_trailer_byte(decoder) < 0)
        return http_chunked_fail(decoder, offset, consumed);
      if (ch == '\r') {
        decoder->state = HTTP_CHUNKED_STATE_TRAILER_END_LF;
        offset++;
      } else if (ch == '\n') {
        return http_chunked_fail(decoder, offset, consumed);
      } else {
        decoder->state = HTTP_CHUNKED_STATE_TRAILER;
        offset++;
      }
      break;

    case HTTP_CHUNKED_STATE_TRAILER:
      if (http_chunked_count_trailer_byte(decoder) < 0)
        return http_chunked_fail(decoder, offset, consumed);
      if (ch == '\r') {
        decoder->state = HTTP_CHUNKED_STATE_TRAILER_LF;
        offset++;
      } else if (ch == '\n') {
        return http_chunked_fail(decoder, offset, consumed);
      } else {
        offset++;
      }
      break;

    case HTTP_CHUNKED_STATE_TRAILER_LF:
      if (http_chunked_count_trailer_byte(decoder) < 0 || ch != '\n')
        return http_chunked_fail(decoder, offset, consumed);
      decoder->state = HTTP_CHUNKED_STATE_TRAILER_START;
      offset++;
      break;

    case HTTP_CHUNKED_STATE_TRAILER_END_LF:
      if (http_chunked_count_trailer_byte(decoder) < 0 || ch != '\n')
        return http_chunked_fail(decoder, offset, consumed);
      decoder->state = HTTP_CHUNKED_STATE_DONE;
      offset++;
      if (offset != input_len)
        return http_chunked_fail(decoder, offset, consumed);
      if (consumed)
        *consumed = offset;
      return HTTP_CHUNKED_DECODE_DONE;

    case HTTP_CHUNKED_STATE_DONE:
    case HTTP_CHUNKED_STATE_ERROR:
      return http_chunked_fail(decoder, offset, consumed);
    }
  }

  if (consumed)
    *consumed = offset;
  return decoder->state == HTTP_CHUNKED_STATE_DONE ? HTTP_CHUNKED_DECODE_DONE : HTTP_CHUNKED_DECODE_NEED_MORE;
}

http_chunked_decode_result_t http_chunked_decoder_finish(http_chunked_decoder_t *decoder) {
  if (!decoder || decoder->state == HTTP_CHUNKED_STATE_ERROR)
    return HTTP_CHUNKED_DECODE_ERROR;
  if (decoder->state == HTTP_CHUNKED_STATE_DONE)
    return HTTP_CHUNKED_DECODE_DONE;
  decoder->state = HTTP_CHUNKED_STATE_ERROR;
  return HTTP_CHUNKED_DECODE_ERROR;
}

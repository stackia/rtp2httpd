#include "snapshot.h"
#include "connection.h"
#include "http.h"
#include "rtp.h"
#include "utils.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* MPEG2-TS constants */
#define TS_PACKET_SIZE 188
#define TS_SYNC_BYTE 0x47
#define TS_PAT_PID 0x0000

/* Reserve space for PAT + PMT at the beginning of idr_frame_mmap */
#define TS_HEADER_RESERVE (2 * TS_PACKET_SIZE) /* 376 bytes */

/* Default snapshot buffer capacity (1MB) */
#define SNAPSHOT_BUFFER_CAPACITY (1 * 1024 * 1024)

/**
 * Initialize snapshot context and allocate resources
 */
int snapshot_init(snapshot_context_t *ctx) {
  if (!ctx)
    return -1;

  memset(ctx, 0, sizeof(snapshot_context_t));

  /* Create tmp mmap file for IDR frame accumulation */
  char tmp_path[] = "/tmp/rtp2httpd_idr_frame_XXXXXX";
  ctx->idr_frame_fd = mkstemp(tmp_path);
  if (ctx->idr_frame_fd < 0) {
    logger(LOG_ERROR, "Snapshot: Failed to create tmp file: %s",
           strerror(errno));
    return -1;
  }

  /* Unlink immediately - file will be deleted when fd is closed */
  unlink(tmp_path);

  /* Set buffer capacity */
  ctx->idr_frame_capacity = SNAPSHOT_BUFFER_CAPACITY;

  /* Allocate mmap buffer */
  if (ftruncate(ctx->idr_frame_fd, ctx->idr_frame_capacity) < 0) {
    logger(LOG_ERROR, "Snapshot: Failed to truncate tmp file: %s",
           strerror(errno));
    close(ctx->idr_frame_fd);
    return -1;
  }

  ctx->idr_frame_mmap =
      mmap(NULL, ctx->idr_frame_capacity, PROT_READ | PROT_WRITE, MAP_SHARED,
           ctx->idr_frame_fd, 0);
  if (ctx->idr_frame_mmap == MAP_FAILED) {
    logger(LOG_ERROR, "Snapshot: Failed to mmap tmp file: %s", strerror(errno));
    close(ctx->idr_frame_fd);
    return -1;
  }

  ctx->enabled = 1;
  ctx->fallback_to_streaming = 0;
  ctx->idr_frame_size = 0;
  ctx->idr_frame_complete = 0;
  ctx->idr_frame_started = 0;
  ctx->video_pid = 0;
  ctx->start_time = get_time_ms();

  /* Initialize PAT/PMT caching state */
  ctx->has_pat = 0;
  ctx->has_pmt = 0;
  ctx->pmt_pid = 0;
  ctx->ts_header_size = 0;

  logger(LOG_DEBUG, "Snapshot: Initialized (%zu bytes buffer)",
         ctx->idr_frame_capacity);
  return 0;
}

/**
 * Free snapshot context and release resources
 */
void snapshot_free(snapshot_context_t *ctx) {
  if (!ctx)
    return;

  if (ctx->idr_frame_mmap && ctx->idr_frame_mmap != MAP_FAILED) {
    munmap(ctx->idr_frame_mmap, ctx->idr_frame_capacity);
    ctx->idr_frame_mmap = NULL;
  }

  if (ctx->idr_frame_fd >= 0) {
    close(ctx->idr_frame_fd);
    ctx->idr_frame_fd = -1;
  }

  ctx->enabled = 0;
}

/**
 * Extract PMT PID from PAT packet
 * @param pat_packet Pointer to PAT TS packet (188 bytes)
 * @return PMT PID, or 0 if not found
 */
static uint16_t extract_pmt_pid_from_pat(const uint8_t *pat_packet) {
  if (!pat_packet || pat_packet[0] != TS_SYNC_BYTE)
    return 0;

  /* Check if this is PAT (PID 0x0000) */
  uint16_t pid = ((pat_packet[1] & 0x1F) << 8) | pat_packet[2];
  if (pid != TS_PAT_PID)
    return 0;

  int has_adaptation = (pat_packet[3] & 0x20) != 0;
  int has_payload = (pat_packet[3] & 0x10) != 0;

  if (!has_payload)
    return 0;

  /* Calculate payload start */
  int payload_start = 4;
  if (has_adaptation) {
    int adaptation_length = pat_packet[4];
    payload_start += 1 + adaptation_length;
  }

  if (payload_start >= TS_PACKET_SIZE)
    return 0;

  const uint8_t *payload = pat_packet + payload_start;
  int payload_len = TS_PACKET_SIZE - payload_start;

  /* Skip pointer field if payload_unit_start is set */
  int payload_unit_start = (pat_packet[1] & 0x40) != 0;
  if (payload_unit_start && payload_len > 0) {
    int pointer = payload[0];
    payload += 1 + pointer;
    payload_len -= 1 + pointer;
  }

  /* Parse PAT table: table_id(8) + section_syntax_indicator(1) + ... */
  if (payload_len < 8)
    return 0;

  uint8_t table_id = payload[0];
  if (table_id != 0x00) /* PAT table_id must be 0 */
    return 0;

  /* Section length is in bits 12-23 of the second and third bytes */
  int section_length = ((payload[1] & 0x0F) << 8) | payload[2];
  if (section_length < 5 || payload_len < 3 + section_length)
    return 0;

  /* Skip to program loop: 8 bytes header (table_id to last_section_number) */
  const uint8_t *program_data = payload + 8;
  int program_data_len = section_length - 5 -
                         4; /* -5 for header after section_length, -4 for CRC */

  /* Parse program entries (4 bytes each: program_number(16) + PMT_PID(13)) */
  for (int i = 0; i + 4 <= program_data_len; i += 4) {
    uint16_t program_number = (program_data[i] << 8) | program_data[i + 1];
    uint16_t pmt_pid =
        ((program_data[i + 2] & 0x1F) << 8) | program_data[i + 3];

    /* Skip NIT (program_number 0) */
    if (program_number != 0 && pmt_pid != 0) {
      return pmt_pid; /* Return first valid PMT PID */
    }
  }

  return 0;
}

/**
 * Cache PAT or PMT packet in idr_frame_mmap header area
 * @param ctx Snapshot context
 * @param ts_packet TS packet to cache (188 bytes)
 * @param pid PID of the packet
 */
static void cache_ts_header_packet(snapshot_context_t *ctx,
                                   const uint8_t *ts_packet, uint16_t pid) {
  if (!ctx || !ts_packet)
    return;

  /* Cache PAT (PID 0x0000) */
  if (pid == TS_PAT_PID && !ctx->has_pat) {
    memcpy(ctx->idr_frame_mmap, ts_packet, TS_PACKET_SIZE);
    ctx->has_pat = 1;

    /* Extract PMT PID from PAT */
    ctx->pmt_pid = extract_pmt_pid_from_pat(ts_packet);

    logger(LOG_DEBUG, "Snapshot: Cached PAT packet (PMT PID: 0x%04x)",
           ctx->pmt_pid);
  }
  /* Cache PMT (if we know the PMT PID) */
  else if (ctx->pmt_pid != 0 && pid == ctx->pmt_pid && !ctx->has_pmt) {
    memcpy(ctx->idr_frame_mmap + TS_PACKET_SIZE, ts_packet, TS_PACKET_SIZE);
    ctx->has_pmt = 1;

    logger(LOG_DEBUG, "Snapshot: Cached PMT packet (PID: 0x%04x)", pid);
  }

  /* Update header size */
  ctx->ts_header_size = 0;
  if (ctx->has_pat)
    ctx->ts_header_size += TS_PACKET_SIZE;
  if (ctx->has_pmt)
    ctx->ts_header_size += TS_PACKET_SIZE;
}

/**
 * Convert IDR frame to JPEG using external ffmpeg
 * Uses existing tmpfs mmap fd for input (MPEG2-TS format) and returns new fd
 * for JPEG output
 * @param idr_frame_fd File descriptor containing MPEG2-TS data with IDR frame
 * (already in tmpfs)
 * @param idr_frame_size MPEG2-TS data size
 * @param jpeg_fd Output: file descriptor for JPEG file (caller must close)
 * @param jpeg_size Output: JPEG file size
 * @return 0 on success, -1 on error
 */
static int snapshot_convert_to_jpeg(int idr_frame_fd, size_t idr_frame_size,
                                    int *jpeg_fd, size_t *jpeg_size) {
  if (idr_frame_fd < 0 || idr_frame_size == 0 || !jpeg_fd || !jpeg_size)
    return -1;

  *jpeg_fd = -1;
  *jpeg_size = 0;

  /* Create output file in /tmp */
  char output_path[] = "/tmp/rtp2httpd_jpeg_XXXXXX";
  int output_fd = mkstemp(output_path);
  if (output_fd < 0) {
    logger(LOG_ERROR, "Snapshot: Failed to create JPEG output file: %s",
           strerror(errno));
    return -1;
  }

  /* Unlink immediately - file will be deleted when fd is closed */
  unlink(output_path);

  /* Build ffmpeg command using /proc/self/fd/ to access unlinked files
   * Input is always MPEG2-TS format (RTP-encapsulated or raw)
   * ffmpeg will demux the TS and extract the first video frame
   */
  const char *ffmpeg_path = config.ffmpeg_path ? config.ffmpeg_path : "ffmpeg";
  const char *ffmpeg_args =
      config.ffmpeg_args ? config.ffmpeg_args : "-hwaccel none";

  char command[1024];
  snprintf(command, sizeof(command),
           "%s %s -loglevel error -f mpegts -i /proc/self/fd/%d -frames:v 1 "
           "-q:v 8 -f image2 -y /proc/self/fd/%d 2>&1",
           ffmpeg_path, ffmpeg_args, idr_frame_fd, output_fd);

  logger(LOG_DEBUG, "Snapshot: Executing ffmpeg: %s", command);

  /* Execute ffmpeg */
  FILE *fp = popen(command, "r");
  if (!fp) {
    logger(LOG_ERROR, "Snapshot: Failed to execute ffmpeg: %s",
           strerror(errno));
    close(output_fd);
    return -1;
  }

  /* Read ffmpeg output (errors) */
  char error_buf[1024];
  size_t error_len = fread(error_buf, 1, sizeof(error_buf) - 1, fp);
  error_buf[error_len] = '\0';

  int status = pclose(fp);

  /* Always log ffmpeg output if there's any */
  if (error_len > 0) {
    logger(LOG_DEBUG, "Snapshot: ffmpeg output: %s", error_buf);
  }

  if (status != 0) {
    logger(LOG_ERROR, "Snapshot: ffmpeg failed (exit code %d)", status);
    close(output_fd);
    return -1;
  }

  /* Get JPEG file size */
  struct stat st;
  if (fstat(output_fd, &st) < 0) {
    logger(LOG_ERROR, "Snapshot: Failed to stat output file: %s",
           strerror(errno));
    close(output_fd);
    return -1;
  }

  if (st.st_size == 0) {
    logger(LOG_ERROR, "Snapshot: ffmpeg produced empty JPEG file");
    close(output_fd);
    return -1;
  }

  *jpeg_size = st.st_size;
  *jpeg_fd = output_fd;

  /* Reset file position for sendfile */
  lseek(output_fd, 0, SEEK_SET);

  logger(LOG_DEBUG, "Snapshot: JPEG conversion successful (%zu bytes)",
         *jpeg_size);
  return 0;
}

/**
 * Process RTP payload for snapshot mode
 * Detects and accumulates IDR frame TS packets, then converts to JPEG and sends
 * to client
 */
int snapshot_process_packet(snapshot_context_t *ctx, int recv_len, uint8_t *buf,
                            connection_t *conn) {
  if (!ctx || !ctx->enabled)
    return -1;

  if (ctx->idr_frame_complete)
    return 0;

  /* Extract RTP payload (or use entire packet if not RTP-encapsulated) */
  uint8_t *payload;
  int payload_size;
  int is_rtp = rtp_get_payload(buf, recv_len, &payload, &payload_size, NULL);

  if (is_rtp < 0)
    return 0; /* Malformed RTP, skip */

  if (payload_size <= 0)
    return 0; /* Empty payload */

  /* We only handle MPEG2-TS streams (RTP-encapsulated or raw) */
  int is_ts = payload_size >= TS_PACKET_SIZE && payload[0] == TS_SYNC_BYTE;

  if (!is_ts) {
    /* Not TS format, skip */
    return 0;
  }

  /* Process each TS packet in the payload */
  size_t offset = 0;
  while (offset + TS_PACKET_SIZE <= (size_t)payload_size) {
    const uint8_t *ts_packet = payload + offset;

    /* Verify sync byte */
    if (ts_packet[0] != TS_SYNC_BYTE) {
      offset++;
      continue;
    }

    /* Parse TS header */
    uint16_t pid = ((ts_packet[1] & 0x1F) << 8) | ts_packet[2];
    int payload_unit_start = (ts_packet[1] & 0x40) != 0;
    int has_adaptation = (ts_packet[3] & 0x20) != 0;
    int has_payload = (ts_packet[3] & 0x10) != 0;

    /* Cache PAT/PMT packets before IDR frame starts (stored in mmap header
     * area) */
    if (!ctx->idr_frame_started) {
      cache_ts_header_packet(ctx, ts_packet, pid);
    }

    /* If we haven't found IDR frame yet, check if this packet contains it */
    if (!ctx->idr_frame_started) {
      if (has_payload && payload_unit_start) {
        /* Calculate payload start */
        int ts_payload_start = 4;
        if (has_adaptation) {
          int adaptation_length = ts_packet[4];
          ts_payload_start += 1 + adaptation_length;
        }

        if (ts_payload_start < TS_PACKET_SIZE) {
          const uint8_t *ts_payload = ts_packet + ts_payload_start;
          int ts_payload_len = TS_PACKET_SIZE - ts_payload_start;

          /* Check for PES header with video stream */
          if (ts_payload_len >= 6 && ts_payload[0] == 0x00 &&
              ts_payload[1] == 0x00 && ts_payload[2] == 0x01) {
            uint8_t stream_id = ts_payload[3];
            if (stream_id >= 0xE0 && stream_id <= 0xEF) /* Video stream */
            {
              /* Check for I-frame NAL in PES payload */
              int pes_header_len = 9 + ts_payload[8];
              if (pes_header_len < ts_payload_len) {
                const uint8_t *es_data = ts_payload + pes_header_len;
                int es_len = ts_payload_len - pes_header_len;

                /* Scan for NAL start code */
                for (int i = 0; i < es_len - 4; i++) {
                  if (es_data[i] == 0 && es_data[i + 1] == 0 &&
                      (es_data[i + 2] == 1 ||
                       (es_data[i + 2] == 0 && es_data[i + 3] == 1))) {
                    int nal_start = (es_data[i + 2] == 1) ? i + 3 : i + 4;
                    if (nal_start < es_len) {
                      uint8_t nal_header = es_data[nal_start];
                      uint8_t h264_type = nal_header & 0x1F;
                      uint8_t hevc_type = (nal_header >> 1) & 0x3F;

                      /* Check if this is an IDR frame */
                      if (h264_type == 5 || /* H.264 IDR */
                          hevc_type == 19 || hevc_type == 20 ||
                          hevc_type == 21) /* HEVC IDR */
                      {
                        /* Found IDR frame! Start capturing from this packet */
                        ctx->idr_frame_started = 1;
                        ctx->video_pid = pid;

                        /* Initialize idr_frame_size to skip PAT/PMT header area
                         */
                        ctx->idr_frame_size = ctx->ts_header_size;

                        logger(LOG_DEBUG,
                               "Snapshot: IDR frame start detected (PID: "
                               "0x%04x, header size: %zu)",
                               pid, ctx->ts_header_size);
                        break;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      /* If still not started, skip this packet */
      if (!ctx->idr_frame_started) {
        offset += TS_PACKET_SIZE;
        continue;
      }

      /* IDR frame just started - fall through to save this packet */
    }

    /* If IDR frame started, check if this packet belongs to the IDR frame */
    if (ctx->idr_frame_started) {
      /* Check if this is the end of IDR frame (next PES start on same PID) */
      if (pid == ctx->video_pid && payload_unit_start &&
          ctx->idr_frame_size > ctx->ts_header_size) {
        /* IDR frame complete */
        ctx->idr_frame_complete = 1;

        size_t video_size = ctx->idr_frame_size - ctx->ts_header_size;
        logger(LOG_DEBUG,
               "Snapshot: Complete IDR frame captured (%zu bytes total, %zu "
               "header + %zu video, %zu video packets)",
               ctx->idr_frame_size, ctx->ts_header_size, video_size,
               video_size / TS_PACKET_SIZE);

        /* Warn if PAT/PMT not captured (ffmpeg may fail) */
        if (!ctx->has_pat || !ctx->has_pmt) {
          logger(LOG_WARN,
                 "Snapshot: Missing TS headers (PAT: %d, PMT: %d) - ffmpeg may "
                 "fail",
                 ctx->has_pat, ctx->has_pmt);
        }

        /* Truncate to actual size */
        if (ftruncate(ctx->idr_frame_fd, ctx->idr_frame_size) < 0) {
          logger(LOG_WARN, "Snapshot: Failed to truncate mmap file: %s",
                 strerror(errno));
        }

        /* Reset file position for ffmpeg to read from beginning */
        lseek(ctx->idr_frame_fd, 0, SEEK_SET);

        /* Convert to JPEG and send immediately */
        int jpeg_fd = -1;
        size_t jpeg_size = 0;

        if (snapshot_convert_to_jpeg(ctx->idr_frame_fd, ctx->idr_frame_size,
                                     &jpeg_fd, &jpeg_size) == 0) {
          /* Send HTTP headers with Content-Length */
          char content_length_header[64];
          snprintf(content_length_header, sizeof(content_length_header),
                   "Content-Length: %zu\r\n", jpeg_size);

          send_http_headers(conn, STATUS_200, "image/jpeg",
                            content_length_header);

          /* Queue JPEG file for non-blocking sendfile() */
          if (connection_queue_file(conn, jpeg_fd, 0, jpeg_size) < 0) {
            logger(LOG_ERROR, "Snapshot: Failed to queue JPEG file");
            close(jpeg_fd);
            return -1;
          }

          /* File descriptor ownership transferred to queue, don't close it here
           */
          logger(LOG_INFO, "Snapshot: Sent JPEG response (%zu bytes)",
                 jpeg_size);
        } else {
          /* Conversion failed */
          logger(LOG_ERROR, "Snapshot: JPEG conversion failed");
          snapshot_fallback_to_streaming(ctx, conn);
        }

        return 0; /* IDR frame captured and sent */
      }

      /* Only accumulate packets from the video PID */
      if (pid == ctx->video_pid) {
        /* Check buffer capacity */
        if (ctx->idr_frame_size + TS_PACKET_SIZE > ctx->idr_frame_capacity) {
          logger(LOG_WARN, "Snapshot: IDR frame too large, buffer full");
          return -1;
        }

        /* Copy this TS packet */
        memcpy(ctx->idr_frame_mmap + ctx->idr_frame_size, ts_packet,
               TS_PACKET_SIZE);
        ctx->idr_frame_size += TS_PACKET_SIZE;
      }
    }

    offset += TS_PACKET_SIZE;
  }

  return 0; /* Continue accumulating */
}

void snapshot_fallback_to_streaming(snapshot_context_t *ctx,
                                    connection_t *conn) {
  if (!ctx || !ctx->enabled || !conn)
    return;

  if (!ctx->fallback_to_streaming) {
    http_send_500(conn);
    return;
  }

  logger(LOG_INFO, "Snapshot: Falling back to normal streaming");

  /* Headers will be sent lazily when first stream data arrives */

  /* Free snapshot context */
  snapshot_free(ctx);

  zerocopy_register_stream_client();
  conn->stream_registered = 1;
}

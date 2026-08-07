#include "stream.h"
#include "configuration.h"
#include "connection.h"
#include "fcc.h"
#include "http.h"
#include "http_proxy.h"
#include "multicast.h"
#include "rtp.h"
#include "rtp_fec.h"
#include "rtsp.h"
#include "service.h"
#include "snapshot.h"
#include "status.h"
#include "utils.h"
#include <arpa/inet.h>
#include <math.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define STREAM_METADATA_HEADERS_SIZE 1024
#define TS_PACKET_SIZE 188
#define TS_SYNC_BYTE 0x47

/* Single source of truth for the R2H-* response header names.  The order here
 * is the order they appear in the response and in
 * Access-Control-Expose-Headers, so a new field only has to be added once. */
enum {
  STREAM_HDR_UPSTREAM_PROTOCOL = 0,
  STREAM_HDR_UPSTREAM_TRANSPORT,
  STREAM_HDR_UPSTREAM_PAYLOAD,
  STREAM_HDR_PLAYBACK_SCALE,
  STREAM_HDR_PLAYBACK_RANGE,
  STREAM_HDR_MEDIA_DURATION,
  STREAM_HDR_FCC_TYPE,
  STREAM_HDR_FCC_STATUS,
  STREAM_HDR_COUNT
};

static const char *const stream_metadata_header_names[STREAM_HDR_COUNT] = {
    "R2H-Upstream-Protocol", "R2H-Upstream-Transport", "R2H-Upstream-Payload", "R2H-Playback-Scale",
    "R2H-Playback-Range",    "R2H-Media-Duration",     "R2H-FCC-Type",         "R2H-FCC-Status",
};

/* Enum value -> header value.  A NULL entry means "not known", which omits the
 * header entirely. */
static const char *const stream_upstream_protocol_values[] = {NULL, "rtsp", "multicast"};
static const char *const stream_upstream_transport_values[] = {NULL, "tcp-interleaved", "udp"};
static const char *const stream_upstream_payload_values[] = {NULL, "mp2t-rtp", "mp2t-direct"};
static const char *const stream_fcc_type_values[] = {NULL, "telecom", "huawei"};
static const char *const stream_fcc_status_values[] = {NULL, "active", "fallback"};

static int stream_metadata_append_raw(char *buffer, size_t buffer_size, size_t *length, const char *value) {
  size_t value_len;

  if (!buffer || !length || !value || *length >= buffer_size)
    return -1;

  value_len = strlen(value);
  if (value_len >= buffer_size - *length)
    return -1;

  memcpy(buffer + *length, value, value_len + 1);
  *length += value_len;
  return 0;
}

static int stream_metadata_append_header(char *buffer, size_t buffer_size, size_t *length, const char *name,
                                         const char *value) {
  char line[512];
  int written;

  written = snprintf(line, sizeof(line), "%s: %s\r\n", name, value);
  if (written < 0 || (size_t)written >= sizeof(line))
    return -1;
  return stream_metadata_append_raw(buffer, buffer_size, length, line);
}

/* Append the header for an enum-valued field, or nothing when the value is
 * unknown or out of range. */
static int stream_metadata_append_enum(char *buffer, size_t buffer_size, size_t *length, int field,
                                       const char *const *values, size_t value_count, int value) {
  if (value < 0 || (size_t)value >= value_count || !values[value])
    return 0;
  return stream_metadata_append_header(buffer, buffer_size, length, stream_metadata_header_names[field], values[value]);
}

static int stream_metadata_append_expose_headers(char *buffer, size_t buffer_size, size_t *length) {
  char list[512];
  size_t used = 0;

  for (int i = 0; i < STREAM_HDR_COUNT; i++) {
    int written = snprintf(list + used, sizeof(list) - used, "%s%s", used ? ", " : "", stream_metadata_header_names[i]);
    if (written < 0 || (size_t)written >= sizeof(list) - used)
      return -1;
    used += (size_t)written;
  }

  return stream_metadata_append_header(buffer, buffer_size, length, "Access-Control-Expose-Headers", list);
}

/**
 * Render a double as the shortest exact decimal that round-trips for our
 * purposes, without a trailing '.' or redundant zeros.
 * @return 0 on success, -1 if the value does not fit (the caller must then omit
 *         the field: stripping trailing zeros off a truncated number would
 *         silently report a wildly different value).
 */
static int stream_metadata_format_number(double value, char *buffer, size_t buffer_size) {
  char *end;
  int written;

  if (!buffer || buffer_size == 0)
    return -1;

  written = snprintf(buffer, buffer_size, "%.6f", value);
  if (written < 0 || (size_t)written >= buffer_size)
    return -1;

  end = buffer + strlen(buffer);
  while (end > buffer && end[-1] == '0')
    *--end = '\0';
  if (end > buffer && end[-1] == '.')
    *--end = '\0';
  if (strcmp(buffer, "-0") == 0)
    snprintf(buffer, buffer_size, "0");
  return 0;
}

static int stream_payload_is_mpegts(const uint8_t *payload, int payload_len) {
  int checked = 0;

  if (!payload || payload_len < TS_PACKET_SIZE || payload[0] != TS_SYNC_BYTE)
    return 0;

  for (int offset = 0; offset + TS_PACKET_SIZE <= payload_len && checked < 3; offset += TS_PACKET_SIZE) {
    if (payload[offset] != TS_SYNC_BYTE)
      return 0;
    checked++;
  }

  return checked > 0;
}

void stream_metadata_init(stream_metadata_t *metadata, const service_t *service) {
  if (!metadata)
    return;

  memset(metadata, 0, sizeof(*metadata));
  if (!service)
    return;

  if (service->service_type == SERVICE_RTSP) {
    metadata->upstream_protocol = STREAM_UPSTREAM_RTSP;
  } else if (service->service_type == SERVICE_MRTP) {
    metadata->upstream_protocol = STREAM_UPSTREAM_MULTICAST;
    if (service->fcc_addr) {
      metadata->fcc_type = service->fcc_type == FCC_TYPE_HUAWEI ? STREAM_FCC_TYPE_HUAWEI : STREAM_FCC_TYPE_TELECOM;
    }
  }
}

void stream_metadata_forget(stream_metadata_t *metadata, unsigned stages) {
  if (!metadata || metadata->frozen)
    return;

  if (stages & STREAM_METADATA_STAGE_DESCRIBE) {
    metadata->upstream_payload = STREAM_PAYLOAD_UNKNOWN;
    metadata->media_duration_known = 0;
  }
  if (stages & STREAM_METADATA_STAGE_SETUP)
    metadata->upstream_transport = STREAM_TRANSPORT_UNKNOWN;
  if (stages & STREAM_METADATA_STAGE_PLAY) {
    metadata->playback_scale_known = 0;
    metadata->playback_range[0] = '\0';
  }
}

static void stream_metadata_note_media(stream_context_t *ctx, int packet_type, const uint8_t *payload, int payload_len,
                                       stream_media_origin_t origin) {
  stream_metadata_t *metadata;

  if (!ctx || ctx->metadata.frozen || !stream_payload_is_mpegts(payload, payload_len))
    return;

  metadata = &ctx->metadata;
  metadata->upstream_payload = packet_type == 1 ? STREAM_PAYLOAD_MP2T_RTP : STREAM_PAYLOAD_MP2T_DIRECT;

  if (metadata->fcc_type != STREAM_FCC_TYPE_UNKNOWN && metadata->fcc_status == STREAM_FCC_STATUS_UNKNOWN) {
    if (origin == STREAM_MEDIA_ORIGIN_FCC_UNICAST) {
      metadata->fcc_status = STREAM_FCC_STATUS_ACTIVE;
    } else if (origin == STREAM_MEDIA_ORIGIN_FCC_MULTICAST) {
      metadata->fcc_status = STREAM_FCC_STATUS_FALLBACK;
    }
  }
}

void stream_send_http_headers(connection_t *conn, const char *content_type, const char *extra_headers) {
  stream_metadata_t *metadata;
  char headers[STREAM_METADATA_HEADERS_SIZE];
  char number[64];
  size_t length = 0;
  int failed = 0;

  if (!conn) {
    return;
  }

  metadata = &conn->stream.metadata;
  headers[0] = '\0';

  if (extra_headers && extra_headers[0])
    failed |= stream_metadata_append_raw(headers, sizeof(headers), &length, extra_headers) < 0;

  failed |= stream_metadata_append_enum(headers, sizeof(headers), &length, STREAM_HDR_UPSTREAM_PROTOCOL,
                                        stream_upstream_protocol_values, ARRAY_SIZE(stream_upstream_protocol_values),
                                        metadata->upstream_protocol) < 0;
  failed |= stream_metadata_append_enum(headers, sizeof(headers), &length, STREAM_HDR_UPSTREAM_TRANSPORT,
                                        stream_upstream_transport_values, ARRAY_SIZE(stream_upstream_transport_values),
                                        metadata->upstream_transport) < 0;
  failed |= stream_metadata_append_enum(headers, sizeof(headers), &length, STREAM_HDR_UPSTREAM_PAYLOAD,
                                        stream_upstream_payload_values, ARRAY_SIZE(stream_upstream_payload_values),
                                        metadata->upstream_payload) < 0;

  /* A value we cannot render exactly is dropped rather than approximated. */
  if (metadata->playback_scale_known && isfinite(metadata->playback_scale)) {
    if (stream_metadata_format_number(metadata->playback_scale, number, sizeof(number)) == 0)
      failed |= stream_metadata_append_header(headers, sizeof(headers), &length,
                                              stream_metadata_header_names[STREAM_HDR_PLAYBACK_SCALE], number) < 0;
    else
      logger(LOG_DEBUG, "Stream: upstream Scale %g is not representable, omitting header", metadata->playback_scale);
  }
  if (metadata->playback_range[0]) {
    failed |= stream_metadata_append_header(headers, sizeof(headers), &length,
                                            stream_metadata_header_names[STREAM_HDR_PLAYBACK_RANGE],
                                            metadata->playback_range) < 0;
  }
  if (metadata->media_duration_known && isfinite(metadata->media_duration)) {
    if (stream_metadata_format_number(metadata->media_duration, number, sizeof(number)) == 0)
      failed |= stream_metadata_append_header(headers, sizeof(headers), &length,
                                              stream_metadata_header_names[STREAM_HDR_MEDIA_DURATION], number) < 0;
    else
      logger(LOG_DEBUG, "Stream: media duration %g is not representable, omitting header", metadata->media_duration);
  }

  failed |= stream_metadata_append_enum(headers, sizeof(headers), &length, STREAM_HDR_FCC_TYPE, stream_fcc_type_values,
                                        ARRAY_SIZE(stream_fcc_type_values), metadata->fcc_type) < 0;
  failed |=
      stream_metadata_append_enum(headers, sizeof(headers), &length, STREAM_HDR_FCC_STATUS, stream_fcc_status_values,
                                  ARRAY_SIZE(stream_fcc_status_values), metadata->fcc_status) < 0;

  if (config.cors_allow_origin && config.cors_allow_origin[0]) {
    failed |= stream_metadata_append_expose_headers(headers, sizeof(headers), &length) < 0;
  }

  if (failed) {
    logger(LOG_ERROR, "Failed to build stream metadata HTTP headers");
    send_http_headers(conn, STATUS_200, content_type, extra_headers);
  } else {
    send_http_headers(conn, STATUS_200, content_type, headers);
  }
  metadata->frozen = 1;
}

void stream_on_client_drain(stream_context_t *ctx) {
  /* Hot path: every successful client write hits this.  Bail out cheaply when
   * no upstream is paused (vast majority of streams). */
  if (!ctx || !ctx->conn || !ctx->conn->any_upstream_paused)
    return;
  if (!connection_can_resume_upstream(ctx->conn))
    return;
  /* Resume functions are no-ops if not paused; no need to re-check here. */
  if (ctx->http_proxy.initialized)
    http_proxy_resume_upstream(&ctx->http_proxy);
  if (ctx->rtsp.initialized)
    rtsp_resume_upstream(&ctx->rtsp);
}

int stream_process_rtp_payload(stream_context_t *ctx, buffer_ref_t *buf_ref, stream_media_origin_t origin) {
  uint8_t *data_ptr = (uint8_t *)buf_ref->data + buf_ref->data_offset;
  uint8_t *payload;
  int payload_len;
  uint16_t seqn;

  int pkt_type = rtp_get_payload(data_ptr, buf_ref->data_size, &payload, &payload_len, &seqn);

  if (pkt_type < 0)
    return 0; /* Malformed packet */

  if (pkt_type == 2) {
    /* FEC packet received on RTP socket - process it for recovery */
    if (ctx->fec.initialized) {
      fec_process_packet(&ctx->fec, payload, payload_len);
    }
    return 0;
  }

  stream_metadata_note_media(ctx, pkt_type, payload, payload_len, origin);

  if (pkt_type == 0) {
    /* Non-RTP packet.  The only legitimate case is an upstream that sends bare
     * MPEG-TS over UDP (RTSP servers negotiating plain MP2T, raw TS multicast
     * streams), so anything that is not TS is a stray datagram: a ZTE
     * ZXV10STB NAT punch reply landing on the media port, an RTCP report sent
     * to the wrong port, or an unrelated sender - the media sockets are
     * unconnected and accept from anyone.  Splicing such a datagram into the
     * output breaks the 188-byte TS alignment for the rest of the stream,
     * which strict demuxers (mpegts.js) never recover from. */
    if (!stream_payload_is_mpegts(payload, payload_len)) {
      logger(LOG_DEBUG, "Stream: Dropped %d-byte datagram that is neither RTP nor MPEG-TS", payload_len);
      return 0;
    }

    /* Bare MPEG-TS - pass through directly (no reordering needed) */
    if (ctx->snapshot.initialized) {
      return snapshot_process_packet(&ctx->snapshot, buf_ref->data_size, data_ptr, ctx->conn);
    }
    return rtp_queue_buf_direct(ctx->conn, buf_ref);
  }

  /* pkt_type == 1: Regular RTP packet */

  /* Adjust buffer to point to payload */
  buf_ref->data_offset = payload - (uint8_t *)buf_ref->data;
  buf_ref->data_size = (size_t)payload_len;

  /* Process through reorder buffer (also serves as FEC packet store) */
  return rtp_reorder_insert(&ctx->reorder, buf_ref, seqn, ctx->conn, ctx->snapshot.initialized,
                            ctx->fec.initialized ? &ctx->fec : NULL);
}

int stream_handle_fd_event(stream_context_t *ctx, int fd, uint32_t events, int64_t now) {
  /* Process FCC socket events */
  if (ctx->fcc.initialized && ctx->fcc.fcc_sock >= 0 && fd == ctx->fcc.fcc_sock) {
    return fcc_handle_socket_event(ctx, fd, now);
  }

  /* Process FCC media socket events */
  if (ctx->fcc.initialized && ctx->fcc.media_sock >= 0 && fd == ctx->fcc.media_sock) {
    return fcc_handle_socket_event(ctx, fd, now);
  }

  /* Process multicast socket events */
  if (ctx->mcast.initialized && ctx->mcast.sock >= 0 && fd == ctx->mcast.sock) {
    return mcast_session_handle_event(&ctx->mcast, ctx, now);
  }

  /* Process FEC socket events - drain all available packets for
   * edge-triggered pollers (epoll EPOLLET / kqueue EV_CLEAR). */
  if (ctx->fec.initialized && ctx->fec.sock >= 0 && fd == ctx->fec.sock) {
    for (;;) {
      uint8_t fec_buf[BUFFER_POOL_BUFFER_SIZE];
      int fec_len = recv(ctx->fec.sock, fec_buf, sizeof(fec_buf), 0);
      if (fec_len <= 0)
        break;
      fec_process_packet(&ctx->fec, fec_buf, fec_len);
    }
    return 0;
  }

  /* Process RTSP socket events */
  if (ctx->rtsp.initialized && ctx->rtsp.socket >= 0 && fd == ctx->rtsp.socket) {
    /* Handle RTSP socket events (handshake and RTP data in PLAYING state) */
    int result = rtsp_handle_socket_event(&ctx->rtsp, events);
    if (result < 0) {
      if (result == STREAM_EVENT_DURATION_READY) {
        logger(LOG_DEBUG, "RTSP: found duration: %0.3f", ctx->rtsp.r2h_duration_value);
        return STREAM_EVENT_DURATION_READY;
      }
      if (result == STREAM_EVENT_METADATA_READY) {
        return STREAM_EVENT_METADATA_READY;
      }
      return STREAM_EVENT_CLOSE;
    }
    return STREAM_EVENT_OK;
  }

  /* Process RTSP RTP socket events (UDP mode) */
  if (ctx->rtsp.initialized && ctx->rtsp.rtp_socket >= 0 && fd == ctx->rtsp.rtp_socket) {
    int result = rtsp_handle_udp_rtp_data(&ctx->rtsp, ctx->conn);
    if (result < 0) {
      return -1; /* Error */
    }
    return 0; /* Success - processed data, continue with other events */
  }

  /* Handle UDP RTCP socket - drain all available packets for
   * edge-triggered pollers (epoll EPOLLET / kqueue EV_CLEAR). */
  if (ctx->rtsp.initialized && ctx->rtsp.rtcp_socket >= 0 && fd == ctx->rtsp.rtcp_socket) {
    /* RTCP data processing could be added here in the future */
    /* For now, just consume all data to prevent buffer overflow */
    uint8_t rtcp_buffer[RTCP_BUFFER_SIZE];
    while (recv(ctx->rtsp.rtcp_socket, rtcp_buffer, sizeof(rtcp_buffer), 0) > 0)
      ;
    return 0;
  }

  /* Process HTTP proxy socket events */
  if (ctx->http_proxy.initialized && ctx->http_proxy.socket >= 0 && fd == ctx->http_proxy.socket) {
    int result = http_proxy_handle_socket_event(&ctx->http_proxy, events);
    if (result < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Socket event handling failed");
      return -1;
    }
    return 0;
  }

  return 0;
}

static int stream_init_rtsp_control(stream_context_t *ctx, service_t *service, int status_index, int metadata_probe) {
  seek_parse_result_t seek_parse_result;
  const char *resolved_seek_param_name = service->seek_param_name;
  char resolved_rtsp_url[2048];

  rtsp_session_init(&ctx->rtsp);
  ctx->rtsp.status_index = status_index;
  ctx->rtsp.epoll_fd = ctx->epoll_fd;
  ctx->rtsp.conn = ctx->conn;
  ctx->rtsp.metadata_probe = metadata_probe;
  ctx->rtsp.upstream_ifname = get_upstream_interface_for_rtsp(service->ifname);

  if (!service->rtsp_url) {
    logger(LOG_ERROR, "RTSP URL not found in service configuration");
    return -1;
  }

  if (service_parse_seek_value(service->seek_param_value, service->seek_begin_offset_seconds,
                               service->seek_end_offset_seconds, service->user_agent, service->seek_mode,
                               service->seek_mode_tz_explicit, service->seek_mode_tz_offset_seconds,
                               service->seek_mode_window_seconds, &seek_parse_result) != 0) {
    logger(LOG_ERROR, "RTSP: Failed to parse seek parameters");
    return -1;
  }

  if (service_format_recent_seek_range(&seek_parse_result, ctx->rtsp.playseek_range_start,
                                       sizeof(ctx->rtsp.playseek_range_start)) > 0) {
    ctx->rtsp.use_playseek_range = 1;
    resolved_seek_param_name = NULL;
  }

  if (service_resolve_upstream_url(service->rtsp_url, resolved_seek_param_name, &seek_parse_result, resolved_rtsp_url,
                                   sizeof(resolved_rtsp_url)) < 0) {
    logger(LOG_ERROR, "RTSP: Failed to resolve upstream URL");
    return -1;
  }
  if (rtsp_parse_server_url(&ctx->rtsp, resolved_rtsp_url, NULL, NULL) < 0) {
    logger(LOG_ERROR, "RTSP: Failed to parse URL");
    return -1;
  }
  if (rtsp_connect(&ctx->rtsp) < 0) {
    logger(LOG_ERROR, "RTSP: Failed to initiate connection");
    return -1;
  }

  logger(LOG_DEBUG, "RTSP: Async connection initiated, state=%d", ctx->rtsp.state);
  return 0;
}

int stream_context_init_rtsp_metadata_probe(stream_context_t *ctx, connection_t *conn, service_t *service,
                                            int epoll_fd) {
  if (!ctx || !conn || !service || service->service_type != SERVICE_RTSP)
    return -1;

  memset(ctx, 0, sizeof(*ctx));
  ctx->conn = conn;
  ctx->service = service;
  ctx->epoll_fd = epoll_fd;
  ctx->status_index = -1;
  ctx->last_status_update = get_time_ms();
  stream_metadata_init(&ctx->metadata, service);
  return stream_init_rtsp_control(ctx, service, -1, 1);
}

/* Initialize context for unified worker epoll (non-blocking, no own loop) */
int stream_context_init_for_worker(stream_context_t *ctx, connection_t *conn, service_t *service, int epoll_fd,
                                   int status_index, int is_snapshot) {
  if (!ctx || !conn || !service)
    return -1;
  memset(ctx, 0, sizeof(*ctx));
  ctx->conn = conn;
  ctx->service = service;
  ctx->epoll_fd = epoll_fd;
  ctx->status_index = status_index;
  ctx->total_bytes_sent = 0;
  ctx->last_bytes_sent = 0;
  ctx->last_status_update = get_time_ms();
  stream_metadata_init(&ctx->metadata, service);

  /* Initialize media path depending on service type */
  if (service->service_type == SERVICE_HTTP) {
    seek_parse_result_t seek_parse_result;

    /* Snapshot mode is not supported for HTTP proxy - ignore is_snapshot */
    http_proxy_session_init(&ctx->http_proxy);
    ctx->http_proxy.epoll_fd = ctx->epoll_fd;
    ctx->http_proxy.conn = conn;
    ctx->http_proxy.status_index = status_index;
    ctx->http_proxy.upstream_ifname = get_upstream_interface_for_http(service->ifname);

    if (!service->http_url) {
      logger(LOG_ERROR, "HTTP URL not found in service configuration");
      return -1;
    }

    if (service_parse_seek_value(service->seek_param_value, service->seek_begin_offset_seconds,
                                 service->seek_end_offset_seconds, service->user_agent, service->seek_mode,
                                 service->seek_mode_tz_explicit, service->seek_mode_tz_offset_seconds,
                                 service->seek_mode_window_seconds, &seek_parse_result) != 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to parse seek parameters");
      return -1;
    }

    /* Build proxy URL with template substitution or seek param append */
    char proxy_url[2048];
    if (service_resolve_upstream_url(service->http_url, service->seek_param_name, &seek_parse_result, proxy_url,
                                     sizeof(proxy_url)) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to resolve upstream URL");
      return -1;
    }

    /* Parse URL */
    if (http_proxy_parse_url(&ctx->http_proxy, proxy_url) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to parse URL");
      return -1;
    }

    /* Set HTTP method from client request */
    http_proxy_set_method(&ctx->http_proxy, conn->http_req.method);

    /* Set raw headers for full passthrough */
    http_proxy_set_raw_headers(&ctx->http_proxy, conn->http_req.raw_headers, conn->http_req.raw_headers_len);

    /* Set request body for passthrough */
    if (conn->http_req.body && conn->http_req.body_len > 0) {
      http_proxy_set_request_body(&ctx->http_proxy, conn->http_req.body, conn->http_req.body_len);
    }

    /* Set request headers for base URL construction during content rewriting */
    http_proxy_set_request_headers(&ctx->http_proxy, conn->http_req.hostname, conn->http_req.x_forwarded_host,
                                   conn->http_req.x_forwarded_proto);

    /* Initiate connection */
    if (http_proxy_connect(&ctx->http_proxy) < 0) {
      logger(LOG_ERROR, "HTTP Proxy: Failed to initiate connection");
      return -1;
    }

    logger(LOG_DEBUG, "HTTP Proxy: Async connection initiated");
  } else {
    /* RTP-based services (RTSP, FCC, multicast) - snapshot mode supported */

    /* Initialize snapshot context if this is a snapshot request */
    if (is_snapshot) {
      if (snapshot_init(&ctx->snapshot) < 0) {
        logger(LOG_ERROR, "Snapshot: Failed to initialize snapshot context");
        return -1;
      }
      if (is_snapshot == 2) /* X-Request-Snapshot or Accept: image/jpeg */
      {
        ctx->snapshot.fallback_to_streaming = 1;
      }
    }

    /* Initialize RTP reorder and FEC (common to all RTP-based services) */
    if (rtp_reorder_init(&ctx->reorder, service->fec_port > 0) < 0) {
      logger(LOG_ERROR, "Failed to initialize RTP reorder buffer");
      return -1;
    }
    fec_init(&ctx->fec, service->fec_port, &ctx->reorder);

    if (service->service_type == SERVICE_RTSP) {
      if (stream_init_rtsp_control(ctx, service, status_index, 0) < 0)
        return -1;
    } else {
      /* Multicast-based services (FCC or direct multicast) */
      mcast_session_init(&ctx->mcast);

      if (service->fcc_addr) {
        /* use Fast Channel Change for quick stream startup */
        fcc_session_init(&ctx->fcc);
        ctx->fcc.status_index = status_index;

        /* Use FCC type from service (already determined during parsing) */
        ctx->fcc.type = service->fcc_type;
        logger(LOG_INFO, "FCC: Using %s FCC protocol",
               ctx->fcc.type == FCC_TYPE_HUAWEI ? "Huawei" : "Telecom/ZTE/Fiberhome");

        if (fcc_initialize_and_request(ctx) < 0) {
          logger(LOG_ERROR, "FCC initialization failed");
          return -1;
        }
      } else {
        /* Direct multicast join (also joins FEC multicast if configured) */
        if (mcast_session_join(&ctx->mcast, ctx) < 0) {
          logger(LOG_ERROR, "Multicast: Failed to join group");
          return -1;
        }
        /* Update client state for direct multicast (no FCC) */
        status_update_client_state(status_index, CLIENT_STATE_FCC_MCAST_ACTIVE);
      }
    }
  }

  return 0;
}

int stream_tick(stream_context_t *ctx, int64_t now) {
  if (!ctx)
    return 0;

  /* Multicast session tick (rejoin and timeout checks) */
  if (mcast_session_tick(&ctx->mcast, ctx->service, now) < 0) {
    return -1; /* Multicast timeout */
  }

  /* FCC session tick (timeout checks) */
  fcc_session_tick(ctx, now);

  /* RTSP session tick (STUN timeout, keepalive, state timeout) */
  if (rtsp_session_tick(&ctx->rtsp, now) < 0)
    return -1;

  /* HTTP proxy session tick (state timeout) */
  if (http_proxy_session_tick(&ctx->http_proxy, now) < 0)
    return -1;

  /* Check snapshot timeout (5 seconds) */
  if (ctx->snapshot.initialized) {
    int64_t snapshot_elapsed = now - ctx->snapshot.start_time;
    if (snapshot_elapsed > SNAPSHOT_TIMEOUT_SEC * 1000) /* 5 seconds */
    {
      logger(LOG_WARN, "Snapshot: Timeout waiting for I-frame (%lld ms)", (long long)snapshot_elapsed);
      snapshot_fallback_to_streaming(&ctx->snapshot, ctx->conn);
    }
  }

  /* Update bandwidth calculation every second (skip for snapshot mode) */
  if (!ctx->snapshot.initialized && now - ctx->last_status_update >= 1000) {
    /* Calculate bandwidth based on bytes sent since last update */
    uint64_t bytes_diff = ctx->total_bytes_sent - ctx->last_bytes_sent;
    int64_t elapsed_ms = now - ctx->last_status_update;
    uint32_t current_bandwidth = 0;

    if (elapsed_ms > 0) {
      /* Convert to bytes per second: (bytes * 1000) / elapsed_ms */
      current_bandwidth = (uint32_t)((bytes_diff * 1000) / elapsed_ms);
    }

    /* Update bytes and bandwidth in status */
    status_update_client_bytes(ctx->status_index, ctx->total_bytes_sent, current_bandwidth);

    /* Save current bytes for next calculation */
    ctx->last_bytes_sent = ctx->total_bytes_sent;
    ctx->last_status_update = now;
  }

  return 0; /* Success */
}

int stream_context_cleanup(stream_context_t *ctx) {
  if (!ctx)
    return 0;

  /* Clean up snapshot resources */
  snapshot_cleanup(&ctx->snapshot);

  /* Clean up FCC session (always safe to cleanup immediately) */
  fcc_session_cleanup(&ctx->fcc, ctx->service, ctx->epoll_fd);

  /* Clean up multicast session */
  mcast_session_cleanup(&ctx->mcast, ctx->epoll_fd);

  /* Clean up HTTP proxy session (always synchronous) */
  http_proxy_session_cleanup(&ctx->http_proxy);

  /* Clean up RTSP session - this may initiate async TEARDOWN */
  int rtsp_async = rtsp_session_cleanup(&ctx->rtsp);

  /* Clean up FEC context (fec_cleanup owns the socket cleanup) */
  fec_cleanup(&ctx->fec, ctx->epoll_fd);

  /* Clean up RTP reorder context */
  rtp_reorder_cleanup(&ctx->reorder);

  if (rtsp_async) {
    /* RTSP async TEARDOWN initiated - defer final cleanup */
    logger(LOG_DEBUG, "Stream: RTSP async TEARDOWN initiated, deferring final cleanup");
    /* Do NOT clear ctx->service - still needed for RTSP */
    return 1; /* Indicate async cleanup in progress */
  }

  /* NOTE: Do NOT free ctx->service here!
   * The service pointer is shared with the parent connection (c->service).
   * The connection owns the service and will free it in connection_cleanup().
   * Freeing it here would cause double-free when connection_cleanup() is called.
   */
  ctx->service = NULL; /* Clear pointer but don't free */

  return 0; /* Cleanup completed */
}

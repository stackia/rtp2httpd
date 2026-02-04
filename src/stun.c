/**
 * STUN (Session Traversal Utilities for NAT) client implementation
 * RFC 5389 compliant for NAT traversal in RTSP UDP transport
 */

#include "stun.h"
#include "configuration.h"
#include "utils.h"
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

/* STUN protocol constants (RFC 5389) */
#define STUN_MSG_BINDING_REQUEST 0x0001
#define STUN_MSG_BINDING_SUCCESS 0x0101
#define STUN_ATTR_MAPPED_ADDR 0x0001
#define STUN_ATTR_XOR_MAPPED_ADDR 0x0020
#define STUN_MAGIC_COOKIE 0x2112A442
#define STUN_HEADER_SIZE 20

/* STUN address family */
#define STUN_ADDR_FAMILY_IPV4 0x01
#define STUN_ADDR_FAMILY_IPV6 0x02

/**
 * Generate random transaction ID
 */
static void stun_gen_transaction_id(unsigned char tid[STUN_TRANSACTION_ID_SIZE]) {
  static int seeded = 0;
  if (!seeded) {
    srand((unsigned)(time(NULL) ^ getpid()));
    seeded = 1;
  }
  for (int i = 0; i < STUN_TRANSACTION_ID_SIZE; i++) {
    tid[i] = rand() & 0xFF;
  }
}

/**
 * Parse host:port string
 * @param server_str Input string like "stun.miwifi.com:3478" or
 * "stun.miwifi.com"
 * @param host Output host buffer
 * @param host_size Size of host buffer
 * @param port Output port (default STUN_DEFAULT_PORT if not specified)
 * @return 0 on success, -1 on error
 */
static int stun_parse_server(const char *server_str, char *host,
                             size_t host_size, int *port) {
  const char *colon;
  size_t host_len;

  if (!server_str || !host || host_size == 0) {
    return -1;
  }

  /* Find last colon (for IPv6 compatibility, though we only support IPv4) */
  colon = strrchr(server_str, ':');

  if (colon && colon != server_str) {
    /* Has port */
    host_len = colon - server_str;
    if (host_len >= host_size) {
      host_len = host_size - 1;
    }
    memcpy(host, server_str, host_len);
    host[host_len] = '\0';
    *port = atoi(colon + 1);
    if (*port <= 0 || *port > 65535) {
      *port = STUN_DEFAULT_PORT;
    }
  } else {
    /* No port, use default */
    strncpy(host, server_str, host_size - 1);
    host[host_size - 1] = '\0';
    *port = STUN_DEFAULT_PORT;
  }

  return 0;
}

int stun_send_request(stun_state_t *state, int socket_fd) {
  struct addrinfo hints, *res = NULL;
  char host[256];
  char port_str[16];
  int port;
  uint8_t request[STUN_HEADER_SIZE];
  ssize_t sent;

  if (!state || socket_fd < 0) {
    return -1;
  }

  /* Check if STUN server is configured */
  if (!config.rtsp_stun_server || config.rtsp_stun_server[0] == '\0') {
    return -1;
  }

  /* Parse server address */
  if (stun_parse_server(config.rtsp_stun_server, host, sizeof(host), &port) <
      0) {
    logger(LOG_WARN, "STUN: Failed to parse server address: %s",
           config.rtsp_stun_server);
    return -1;
  }

  /* Resolve STUN server */
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  hints.ai_protocol = IPPROTO_UDP;

  snprintf(port_str, sizeof(port_str), "%d", port);
  if (getaddrinfo(host, port_str, &hints, &res) != 0) {
    logger(LOG_WARN, "STUN: Failed to resolve server: %s", host);
    return -1;
  }

  /* Generate transaction ID */
  stun_gen_transaction_id(state->transaction_id);

  /* Build STUN Binding Request (20 bytes) */
  memset(request, 0, sizeof(request));

  /* Message Type: Binding Request (0x0001) */
  request[0] = (STUN_MSG_BINDING_REQUEST >> 8) & 0xFF;
  request[1] = STUN_MSG_BINDING_REQUEST & 0xFF;

  /* Message Length: 0 (no attributes in request) */
  request[2] = 0;
  request[3] = 0;

  /* Magic Cookie: 0x2112A442 */
  request[4] = (STUN_MAGIC_COOKIE >> 24) & 0xFF;
  request[5] = (STUN_MAGIC_COOKIE >> 16) & 0xFF;
  request[6] = (STUN_MAGIC_COOKIE >> 8) & 0xFF;
  request[7] = STUN_MAGIC_COOKIE & 0xFF;

  /* Transaction ID (12 bytes) */
  memcpy(request + 8, state->transaction_id, STUN_TRANSACTION_ID_SIZE);

  /* Send request */
  sent = sendto(socket_fd, request, sizeof(request), 0, res->ai_addr,
                res->ai_addrlen);
  freeaddrinfo(res);

  if (sent != sizeof(request)) {
    logger(LOG_WARN, "STUN: Failed to send request: %s", strerror(errno));
    return -1;
  }

  /* Update state */
  state->in_progress = 1;
  state->request_time_ms = get_time_ms();

  logger(LOG_DEBUG, "STUN: Sent Binding Request to %s:%d (attempt %d/%d)", host,
         port, state->retry_count + 1, STUN_MAX_RETRIES + 1);

  return 0;
}

int stun_parse_response(stun_state_t *state, const uint8_t *data, size_t len) {
  uint16_t msg_type, msg_len;
  uint32_t magic;
  size_t offset;

  if (!state || !data || len < STUN_HEADER_SIZE) {
    return -1;
  }

  /* Parse header */
  msg_type = ((uint16_t)data[0] << 8) | data[1];
  msg_len = ((uint16_t)data[2] << 8) | data[3];
  magic = ((uint32_t)data[4] << 24) | ((uint32_t)data[5] << 16) |
          ((uint32_t)data[6] << 8) | data[7];

  /* Validate message type */
  if (msg_type != STUN_MSG_BINDING_SUCCESS) {
    logger(LOG_DEBUG, "STUN: Not a Binding Success response: 0x%04x", msg_type);
    return -1;
  }

  /* Validate magic cookie */
  if (magic != STUN_MAGIC_COOKIE) {
    logger(LOG_DEBUG, "STUN: Invalid magic cookie: 0x%08x", magic);
    return -1;
  }

  /* Validate transaction ID */
  if (memcmp(data + 8, state->transaction_id, STUN_TRANSACTION_ID_SIZE) != 0) {
    logger(LOG_DEBUG, "STUN: Transaction ID mismatch");
    return -1;
  }

  /* Parse attributes */
  offset = STUN_HEADER_SIZE;
  while (offset + 4 <= (size_t)(STUN_HEADER_SIZE + msg_len) && offset + 4 <= len) {
    uint16_t attr_type = ((uint16_t)data[offset] << 8) | data[offset + 1];
    uint16_t attr_len = ((uint16_t)data[offset + 2] << 8) | data[offset + 3];
    size_t val_off = offset + 4;

    if (val_off + attr_len > len) {
      break;
    }

    /* XOR-MAPPED-ADDRESS (preferred) */
    if (attr_type == STUN_ATTR_XOR_MAPPED_ADDR && attr_len >= 8) {
      uint8_t family = data[val_off + 1];
      if (family == STUN_ADDR_FAMILY_IPV4) {
        uint16_t xport =
            ((uint16_t)data[val_off + 2] << 8) | data[val_off + 3];
        uint32_t xaddr = ((uint32_t)data[val_off + 4] << 24) |
                         ((uint32_t)data[val_off + 5] << 16) |
                         ((uint32_t)data[val_off + 6] << 8) | data[val_off + 7];

        /* XOR decode */
        uint16_t port = xport ^ (STUN_MAGIC_COOKIE >> 16);
        uint32_t addr = xaddr ^ STUN_MAGIC_COOKIE;

        state->mapped_rtp_port = port;
        state->mapped_rtcp_port = port + 1;
        state->in_progress = 0;
        state->completed = 1;

        /* Log the mapped address */
        struct in_addr ina;
        ina.s_addr = htonl(addr);
        char ip_str[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &ina, ip_str, sizeof(ip_str));

        logger(LOG_INFO, "STUN: Discovered mapped address %s:%d", ip_str, port);
        return 0;
      }
    }

    /* MAPPED-ADDRESS (fallback for older servers) */
    if (attr_type == STUN_ATTR_MAPPED_ADDR && attr_len >= 8) {
      uint8_t family = data[val_off + 1];
      if (family == STUN_ADDR_FAMILY_IPV4) {
        uint16_t port =
            ((uint16_t)data[val_off + 2] << 8) | data[val_off + 3];

        state->mapped_rtp_port = port;
        state->mapped_rtcp_port = port + 1;
        state->in_progress = 0;
        state->completed = 1;

        logger(LOG_INFO, "STUN: Discovered mapped port %d (MAPPED-ADDRESS)",
               port);
        return 0;
      }
    }

    /* Advance to next attribute (4-byte aligned) */
    size_t advance = 4 + attr_len;
    if (attr_len % 4) {
      advance += (4 - (attr_len % 4));
    }
    offset += advance;
  }

  logger(LOG_DEBUG, "STUN: No valid mapped address in response");
  return -1;
}

int stun_check_timeout(stun_state_t *state, int socket_fd) {
  int64_t now;
  int64_t elapsed;

  if (!state || !state->in_progress) {
    return 0;
  }

  now = get_time_ms();
  elapsed = now - state->request_time_ms;

  if (elapsed >= STUN_TIMEOUT_MS) {
    state->retry_count++;

    if (state->retry_count > STUN_MAX_RETRIES) {
      /* Give up, proceed without STUN */
      logger(LOG_WARN, "STUN: Timeout after %d attempts, using local port",
             state->retry_count);
      state->in_progress = 0;
      state->completed = 1;
      return 1;
    }

    /* Retry */
    logger(LOG_DEBUG, "STUN: Timeout, retrying (attempt %d/%d)",
           state->retry_count + 1, STUN_MAX_RETRIES + 1);

    stun_send_request(state, socket_fd);
  }

  return 0;
}

uint16_t stun_get_mapped_port(const stun_state_t *state) {
  if (!state) {
    return 0;
  }
  return state->mapped_rtp_port;
}

int stun_is_stun_packet(const uint8_t *data, size_t len) {
  if (!data || len < 20) {
    return 0;
  }
  /* STUN messages have first two bits as 00 */
  return (data[0] & 0xC0) == 0x00;
}

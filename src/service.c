#include "service.h"
#include "fcc.h"
#include "hashmap.h"
#include "http.h"
#include "utils.h"
#include <limits.h>
#include <netdb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>

/* GLOBALS */
service_t *services = NULL;

/* RTP URL parsing helper structure */
struct rtp_url_components {
  char multicast_addr[HTTP_ADDR_COMPONENT_SIZE];
  char multicast_port[HTTP_PORT_COMPONENT_SIZE];
  char source_addr[HTTP_ADDR_COMPONENT_SIZE];
  char source_port[HTTP_PORT_COMPONENT_SIZE];
  char fcc_addr[HTTP_ADDR_COMPONENT_SIZE];
  char fcc_port[HTTP_PORT_COMPONENT_SIZE];
  int has_source;
  int has_fcc;
  fcc_type_t fcc_type;   /* FCC protocol type */
  int fcc_type_explicit; /* 1 if fcc-type was explicitly set via query param */
};

/* Service lookup hashmap for O(1) service lookup by URL */
static struct hashmap *service_map = NULL;

static int parse_ipv6_address(const char *input, char *addr, size_t addr_size,
                              const char **remainder) {
  const char *end = strchr(input + 1, ']');
  if (!end) {
    return -1; /* No closing bracket */
  }

  size_t addr_len = end - input - 1;
  if (addr_len >= addr_size) {
    return -1; /* Address too long */
  }

  strncpy(addr, input + 1, addr_len);
  addr[addr_len] = '\0';
  *remainder = end + 1;
  return 0;
}

static int parse_address_port(const char *input, char *addr, size_t addr_size,
                              char *port, size_t port_size) {
  const char *port_start;
  size_t addr_len;

  if (input[0] == '[') {
    /* IPv6 address */
    if (parse_ipv6_address(input, addr, addr_size, &port_start) != 0) {
      return -1;
    }
    if (*port_start == ':') {
      port_start++;
    } else if (*port_start != '\0') {
      return -1; /* Invalid format after IPv6 address */
    }
  } else {
    /* IPv4 address or hostname */
    port_start = strrchr(input, ':');
    if (port_start) {
      addr_len = port_start - input;
      port_start++;
    } else {
      addr_len = strlen(input);
    }

    if (addr_len >= addr_size) {
      return -1; /* Address too long */
    }

    memcpy(addr, input, addr_len);
    addr[addr_len] = '\0';
  }

  /* Copy port if present */
  if (port_start && *port_start) {
    if (strlen(port_start) >= port_size) {
      return -1; /* Port too long */
    }
    strncpy(port, port_start, port_size - 1);
    port[port_size - 1] = '\0';
  } else {
    port[0] = '\0';
  }

  return 0;
}

static int parse_rtp_url_components(char *url_part,
                                    struct rtp_url_components *components) {
  char *query_start, *at_pos;
  char main_part[HTTP_URL_MAIN_PART_SIZE];
  char fcc_value[HTTP_URL_FCC_VALUE_SIZE];
  char fcc_type_value[32];

  /* Initialize components */
  memset(components, 0, sizeof(*components));
  components->fcc_type = FCC_TYPE_TELECOM; /* Default to Telecom */
  components->fcc_type_explicit = 0;

  /* URL decode the input */
  if (http_url_decode(url_part) != 0) {
    return -1;
  }

  /* Split URL and query string */
  query_start = strchr(url_part, '?');
  if (query_start) {
    *query_start = '\0'; /* Terminate main part */
    query_start++;       /* Point to query string */

    /* Parse FCC parameter from query string */
    if (http_parse_query_param(query_start, "fcc", fcc_value,
                               sizeof(fcc_value)) == 0) {
      /* Check for empty FCC value */
      if (fcc_value[0] == '\0') {
        return -1; /* Empty FCC parameter */
      }
      if (parse_address_port(fcc_value, components->fcc_addr,
                             sizeof(components->fcc_addr), components->fcc_port,
                             sizeof(components->fcc_port)) != 0) {
        return -1;
      }
      components->has_fcc = 1;
    }

    /* Parse fcc-type parameter from query string */
    if (http_parse_query_param(query_start, "fcc-type", fcc_type_value,
                               sizeof(fcc_type_value)) == 0) {
      /* Check for empty fcc-type value */
      if (fcc_type_value[0] != '\0') {
        /* Parse fcc-type value (case-insensitive) */
        if (strcasecmp(fcc_type_value, "telecom") == 0) {
          components->fcc_type = FCC_TYPE_TELECOM;
          components->fcc_type_explicit = 1;
        } else if (strcasecmp(fcc_type_value, "huawei") == 0) {
          components->fcc_type = FCC_TYPE_HUAWEI;
          components->fcc_type_explicit = 1;
        }
        /* Unrecognized values are ignored (use port-based detection) */
      }
    }
  }

  /* Remove trailing slash from main part if present (e.g.,
   * "239.253.64.120:5140/") */
  {
    size_t len = strlen(url_part);
    if (len > 0 && url_part[len - 1] == '/') {
      url_part[len - 1] = '\0';
    }
  }

  /* Copy main part for parsing */
  if (strlen(url_part) >= sizeof(main_part)) {
    return -1; /* URL too long */
  }
  strncpy(main_part, url_part, sizeof(main_part) - 1);
  main_part[sizeof(main_part) - 1] = '\0';

  /* Check if main part is empty (missing address) */
  if (main_part[0] == '\0') {
    return -1; /* Missing address */
  }

  /* Check for source address (format: source@multicast) */
  at_pos = strrchr(main_part, '@');
  if (at_pos) {
    *at_pos = '\0'; /* Split at @ */

    /* Check for empty source (malformed source) */
    if (main_part[0] == '\0') {
      return -1; /* Empty source address */
    }

    /* Check for empty multicast (malformed multicast) */
    if (*(at_pos + 1) == '\0') {
      return -1; /* Empty multicast address */
    }

    /* Parse source address */
    if (parse_address_port(
            main_part, components->source_addr, sizeof(components->source_addr),
            components->source_port, sizeof(components->source_port)) != 0) {
      return -1;
    }
    components->has_source = 1;

    /* Parse multicast address */
    if (parse_address_port(at_pos + 1, components->multicast_addr,
                           sizeof(components->multicast_addr),
                           components->multicast_port,
                           sizeof(components->multicast_port)) != 0) {
      return -1;
    }
  } else {
    /* No source, only multicast address */
    if (parse_address_port(main_part, components->multicast_addr,
                           sizeof(components->multicast_addr),
                           components->multicast_port,
                           sizeof(components->multicast_port)) != 0) {
      return -1;
    }
  }

  /* Set default port if not specified */
  if (components->multicast_port[0] == '\0') {
    strcpy(components->multicast_port, "1234");
  }

  return 0;
}

service_t *service_create_from_udpxy_url(char *url) {
  char working_url[HTTP_URL_BUFFER_SIZE];

  /* Validate input */
  if (!url || strlen(url) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long URL");
    return NULL;
  }

  /* Copy URL to avoid modifying original */
  strncpy(working_url, url, sizeof(working_url) - 1);
  working_url[sizeof(working_url) - 1] = '\0';

  /* Determine service type and delegate to appropriate function */
  if (strncmp(working_url, "/rtp/", 5) == 0 ||
      strncmp(working_url, "/udp/", 5) == 0) {
    /* RTP/UDP service - service_create_from_rtp_url handles both */
    return service_create_from_rtp_url(url);
  } else if (strncmp(working_url, "/rtsp/", 6) == 0) {
    /* RTSP service - use service_create_from_rtsp_url */
    return service_create_from_rtsp_url(url);
  } else {
    logger(LOG_ERROR,
           "Invalid URL format (must start with /rtp/, /udp/, or /rtsp/)");
    return NULL;
  }
}
service_t *service_create_from_rtsp_url(const char *http_url) {
  service_t *result = NULL;
  char working_url[HTTP_URL_BUFFER_SIZE];
  char *url_part, *seek_param_value = NULL;
  char *query_start, *seek_start, *seek_end;
  const char *seek_param_name = NULL;
  char *r2h_seek_name_explicit = NULL;
  char rtsp_url[HTTP_URL_BUFFER_SIZE];
  int seek_offset_seconds = 0;

  /* Validate input */
  if (!http_url || strlen(http_url) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long RTSP URL");
    goto cleanup;
  }

  /* Copy URL to avoid modifying original */
  strncpy(working_url, http_url, sizeof(working_url) - 1);
  working_url[sizeof(working_url) - 1] = '\0';

  /* Check if URL starts with rtsp:// or /rtsp/ and extract the part after
   * prefix */
  if (strncmp(working_url, "rtsp://", 7) == 0) {
    /* Direct RTSP URL format: rtsp://server:port/path?query */
    url_part = working_url + 7; /* Skip "rtsp://" */
  } else if (strncmp(working_url, "/rtsp/", 6) == 0) {
    /* HTTP request format: /rtsp/server:port/path?query */
    url_part = working_url + 6; /* Skip "/rtsp/" */
  } else {
    logger(LOG_ERROR,
           "Invalid RTSP URL format (must start with rtsp:// or /rtsp/)");
    goto cleanup;
  }

  /* Check if URL part is empty */
  if (strlen(url_part) == 0) {
    logger(LOG_ERROR, "RTSP URL part is empty");
    goto cleanup;
  }

  /* Find and extract seek parameter, then remove it from URL */
  query_start = strchr(url_part, '?');
  if (query_start) {
    /* Step 1: Extract r2h-seek-name parameter if present */
    char *r2h_start = strstr(query_start, "r2h-seek-name=");

    /* Check if at parameter boundary */
    if (r2h_start &&
        (r2h_start == query_start + 1 || *(r2h_start - 1) == '&')) {
      /* Extract value */
      char *value_start = r2h_start + 14; /* Skip "r2h-seek-name=" */
      char *value_end = strchr(value_start, '&');
      if (!value_end) {
        value_end = value_start + strlen(value_start);
      }

      size_t value_len = value_end - value_start;
      r2h_seek_name_explicit = malloc(value_len + 1);
      if (r2h_seek_name_explicit) {
        strncpy(r2h_seek_name_explicit, value_start, value_len);
        r2h_seek_name_explicit[value_len] = '\0';

        /* URL decode */
        if (http_url_decode(r2h_seek_name_explicit) != 0) {
          logger(LOG_ERROR, "Failed to decode r2h-seek-name parameter");
          free(r2h_seek_name_explicit);
          r2h_seek_name_explicit = NULL;
        } else {
          logger(LOG_DEBUG, "Found r2h-seek-name parameter: %s",
                 r2h_seek_name_explicit);
        }
      }

      /* Remove r2h-seek-name parameter from URL */
      char *param_start =
          (r2h_start > query_start + 1) ? (r2h_start - 1) : r2h_start;
      if (r2h_start == query_start + 1) {
        /* First parameter */
        if (*value_end == '&') {
          /* Has other params after, keep '?' and move them forward */
          memmove(query_start + 1, value_end + 1, strlen(value_end + 1) + 1);
        } else {
          /* Only parameter, remove '?' */
          *query_start = '\0';
          query_start = NULL; /* Mark as no query string */
        }
      } else {
        /* Not first parameter, remove including preceding '&' */
        if (*value_end == '&') {
          memmove(param_start, value_end, strlen(value_end) + 1);
        } else {
          *param_start = '\0';
        }
      }
    }

    /* Step 1.5: Extract r2h-seek-offset parameter if present */
    char *offset_start = strstr(query_start, "r2h-seek-offset=");

    /* Check if at parameter boundary */
    if (offset_start &&
        (offset_start == query_start + 1 || *(offset_start - 1) == '&')) {
      /* Extract value */
      char *value_start = offset_start + 16; /* Skip "r2h-seek-offset=" */
      char *value_end = strchr(value_start, '&');
      if (!value_end) {
        value_end = value_start + strlen(value_start);
      }

      size_t value_len = value_end - value_start;
      char *offset_str = malloc(value_len + 1);
      if (offset_str) {
        strncpy(offset_str, value_start, value_len);
        offset_str[value_len] = '\0';

        /* URL decode */
        if (http_url_decode(offset_str) == 0) {
          /* Parse signed integer (supports +8, -8, 8, +0, -0) */
          char *endptr;
          long offset_val = strtol(offset_str, &endptr, 10);

          if (*endptr == '\0' && offset_val >= INT_MIN &&
              offset_val <= INT_MAX) {
            seek_offset_seconds = (int)offset_val;
            logger(LOG_DEBUG, "Found r2h-seek-offset parameter: %d seconds",
                   seek_offset_seconds);
          } else {
            logger(LOG_WARN, "Invalid r2h-seek-offset value: %s", offset_str);
          }
        } else {
          logger(LOG_ERROR, "Failed to decode r2h-seek-offset parameter");
        }

        free(offset_str);
      }

      /* Remove r2h-seek-offset parameter from URL */
      char *param_start =
          (offset_start > query_start + 1) ? (offset_start - 1) : offset_start;
      if (offset_start == query_start + 1) {
        /* First parameter */
        if (*value_end == '&') {
          /* Has other params after, keep '?' and move them forward */
          memmove(query_start + 1, value_end + 1, strlen(value_end + 1) + 1);
        } else {
          /* Only parameter, remove '?' */
          *query_start = '\0';
          query_start = NULL; /* Mark as no query string */
        }
      } else {
        /* Not first parameter, remove including preceding '&' */
        if (*value_end == '&') {
          memmove(param_start, value_end, strlen(value_end) + 1);
        } else {
          *param_start = '\0';
        }
      }
    }

    /* Step 2: Determine seek parameter name */
    if (r2h_seek_name_explicit) {
      /* Explicitly specified */
      seek_param_name = r2h_seek_name_explicit;
      logger(LOG_DEBUG, "Using explicitly specified seek parameter name: %s",
             seek_param_name);
    } else if (query_start) {
      /* Heuristic detection with fixed priority: playseek > tvdr */
      char *playseek_check = strstr(query_start, "playseek=");
      if (playseek_check &&
          (playseek_check == query_start + 1 || *(playseek_check - 1) == '&')) {
        seek_param_name = "playseek";
        logger(LOG_DEBUG, "Heuristic: detected playseek parameter");
      } else {
        char *tvdr_check = strstr(query_start, "tvdr=");
        if (tvdr_check &&
            (tvdr_check == query_start + 1 || *(tvdr_check - 1) == '&')) {
          seek_param_name = "tvdr";
          logger(LOG_DEBUG, "Heuristic: detected tvdr parameter");
        }
      }
    }
  }

  /* Step 3: Extract seek parameter value if name is determined */
  if (query_start && seek_param_name) {
    char search_pattern[128];
    snprintf(search_pattern, sizeof(search_pattern), "%s=", seek_param_name);

    char *first_value = NULL;
    char *selected_value = NULL;
    char *search_pos = query_start;

    /* Iterate through all occurrences of the seek parameter */
    while ((seek_start = strstr(search_pos, search_pattern)) != NULL) {
      /* Ensure we're at a parameter boundary (after ? or &) */
      if (seek_start > query_start && *(seek_start - 1) != '?' &&
          *(seek_start - 1) != '&') {
        search_pos = seek_start + strlen(search_pattern);
        continue;
      }

      seek_start += strlen(search_pattern); /* Skip "{param_name}=" */
      seek_end = strchr(seek_start, '&');
      if (!seek_end) {
        seek_end = seek_start + strlen(seek_start);
      }

      /* Extract this seek parameter value */
      size_t param_len = seek_end - seek_start;
      char *current_value = malloc(param_len + 1);
      if (!current_value) {
        logger(LOG_ERROR, "Failed to allocate memory for %s parameter",
               seek_param_name);
        if (first_value)
          free(first_value);
        if (selected_value)
          free(selected_value);
        goto cleanup;
      }

      strncpy(current_value, seek_start, param_len);
      current_value[param_len] = '\0';

      /* URL decode the parameter value */
      if (http_url_decode(current_value) != 0) {
        logger(LOG_ERROR, "Failed to decode %s parameter value",
               seek_param_name);
        free(current_value);
        if (first_value)
          free(first_value);
        if (selected_value)
          free(selected_value);
        goto cleanup;
      }

      /* Store the first value as fallback */
      if (!first_value) {
        first_value = strdup(current_value);
      }

      /* Check if this value has valid format (no placeholders like {begin} or
       * {end}) */
      if (!selected_value && current_value && !strchr(current_value, '{') &&
          !strchr(current_value, '}')) {
        selected_value = strdup(current_value);
        logger(LOG_DEBUG, "Found valid %s parameter: %s", seek_param_name,
               selected_value);
      }

      free(current_value);

      /* Move search position forward */
      search_pos = seek_end;
    }

    /* Determine which value to use */
    if (selected_value) {
      seek_param_value = selected_value;
      if (first_value)
        free(first_value);
    } else if (first_value) {
      /* No valid format found, use first value as fallback */
      seek_param_value = first_value;
      logger(LOG_DEBUG,
             "No valid format found for %s, using first value as fallback: %s",
             seek_param_name, seek_param_value);
    }

    /* Remove all seek parameters from URL */
    if (seek_param_value) {
      char *remove_pos = query_start;
      while ((seek_start = strstr(remove_pos, search_pattern)) != NULL) {
        /* Ensure we're at a parameter boundary */
        if (seek_start > query_start && *(seek_start - 1) != '?' &&
            *(seek_start - 1) != '&') {
          remove_pos = seek_start + strlen(search_pattern);
          continue;
        }

        char *param_to_remove_start = seek_start;

        /* Check if seek param is the first parameter or not */
        if (seek_start > query_start + 1) {
          /* Not the first parameter, include preceding '&' */
          param_to_remove_start =
              seek_start - 1; /* Point to '&' before param */
        }

        /* Find the end of the seek parameter value */
        char *param_value_end = strchr(seek_start, '&');
        if (param_value_end) {
          /* There are parameters after seek param */
          if (seek_start == query_start + 1) {
            /* First parameter, keep '?' and move other params */
            memmove(query_start + 1, param_value_end + 1,
                    strlen(param_value_end + 1) + 1);
          } else {
            /* Not first, remove including preceding '&' */
            memmove(param_to_remove_start, param_value_end,
                    strlen(param_value_end) + 1);
          }
          /* Continue from the same position since we moved content */
          remove_pos = param_to_remove_start;
        } else {
          /* Last/only parameter */
          if (seek_start == query_start + 1) {
            /* Remove entire query string */
            *query_start = '\0';
          } else {
            /* Remove just the seek parameter and preceding '&' */
            *param_to_remove_start = '\0';
          }
          break; /* No more parameters to process */
        }
      }
    }
  }

  /* Allocate service structure */
  result = malloc(sizeof(service_t));
  if (!result) {
    logger(LOG_ERROR, "Failed to allocate memory for RTSP service");
    goto cleanup;
  }

  memset(result, 0, sizeof(service_t));
  result->service_type = SERVICE_RTSP;
  result->user_agent = NULL;

  /* Build full RTSP URL */
  /* url_part already has prefix stripped, so always prepend rtsp:// */
  if (strlen(url_part) + 7 >= sizeof(rtsp_url)) {
    logger(LOG_ERROR, "RTSP URL too long: %zu bytes", strlen(url_part) + 7);
    goto cleanup;
  }
  snprintf(rtsp_url, sizeof(rtsp_url), "rtsp://%.1000s", url_part);

  /* Store RTSP URL and seek parameters */
  result->rtsp_url = strdup(rtsp_url);
  if (!result->rtsp_url) {
    logger(LOG_ERROR, "Failed to allocate memory for RTSP URL");
    goto cleanup;
  }

  result->seek_param_name = seek_param_name ? strdup(seek_param_name) : NULL;
  result->seek_param_value = seek_param_value;
  seek_param_value = NULL; /* Transfer ownership to result */
  result->seek_offset_seconds = seek_offset_seconds;

  result->url = strdup(http_url); /* Store original HTTP URL for reference */
  if (!result->url) {
    logger(LOG_ERROR, "Failed to allocate memory for HTTP URL");
    goto cleanup;
  }

  logger(LOG_DEBUG, "Parsed RTSP URL: %s", result->rtsp_url);
  if (result->seek_param_value) {
    logger(LOG_DEBUG, "Parsed %s parameter: %s",
           result->seek_param_name ? result->seek_param_name : "seek",
           result->seek_param_value);
  }

  /* Cleanup temporary (only if not transferred to result) */
  if (r2h_seek_name_explicit && seek_param_name != r2h_seek_name_explicit) {
    free(r2h_seek_name_explicit);
  }

  return result;

cleanup:
  /* Free temporary allocations */
  if (seek_param_value)
    free(seek_param_value);
  if (r2h_seek_name_explicit)
    free(r2h_seek_name_explicit);

  /* Free partially constructed result */
  if (result) {
    if (result->rtsp_url)
      free(result->rtsp_url);
    if (result->seek_param_name)
      free(result->seek_param_name);
    if (result->url)
      free(result->url);
    free(result);
  }

  return NULL;
}

service_t *service_create_with_query_merge(service_t *configured_service,
                                           const char *request_url,
                                           service_type_t expected_type) {
  char merged_url[2048];
  char *query_start, *existing_query;
  const char *base_url;
  const char *type_name;

  /* Validate inputs */
  if (!configured_service || !request_url) {
    logger(LOG_ERROR, "Invalid parameters for query merge");
    return NULL;
  }

  /* Check if this is the expected service type */
  if (configured_service->service_type != expected_type) {
    type_name = (expected_type == SERVICE_RTSP) ? "RTSP" : "RTP";
    logger(LOG_ERROR, "Service is not %s type", type_name);
    return NULL;
  }

  /* Get base URL based on service type */
  if (expected_type == SERVICE_RTSP) {
    if (!configured_service->rtsp_url) {
      logger(LOG_ERROR, "Configured RTSP service has no rtsp_url");
      return NULL;
    }
    base_url = configured_service->rtsp_url;
    type_name = "RTSP";
  } else /* SERVICE_MRTP */
  {
    if (!configured_service->rtp_url) {
      logger(LOG_ERROR, "Configured RTP service has no URL");
      return NULL;
    }
    base_url = configured_service->rtp_url;
    type_name = "RTP";
  }

  /* Find query parameters in request URL */
  query_start = strchr(request_url, '?');
  if (!query_start) {
    /* No query params in request, no merge needed */
    return NULL;
  }

  /* Find query parameters in configured service's URL */
  existing_query = strchr(base_url, '?');

  if (existing_query) {
    /* Service URL already has query params - merge them */
    size_t base_len = existing_query - base_url;
    if (base_len >= sizeof(merged_url)) {
      logger(LOG_ERROR, "%s URL too long for merging", type_name);
      return NULL;
    }

    /* Copy base URL (without query) */
    strncpy(merged_url, base_url, base_len);
    merged_url[base_len] = '\0';

    /* Append merged query params */
    if (strlen(merged_url) + strlen(existing_query) + strlen(query_start) <
        sizeof(merged_url)) {
      strcat(merged_url, existing_query);  /* Existing params with '?' */
      strcat(merged_url, "&");             /* Separator */
      strcat(merged_url, query_start + 1); /* New params without '?' */
    } else {
      logger(LOG_ERROR, "Merged %s URL too long", type_name);
      return NULL;
    }
  } else {
    /* Service URL has no query params - just append request params */
    size_t url_len = strlen(base_url);
    size_t query_len = strlen(query_start);
    if (url_len + query_len >= sizeof(merged_url)) {
      logger(LOG_ERROR, "%s URL too long for merging", type_name);
      return NULL;
    }
    memcpy(merged_url, base_url, url_len);
    memcpy(merged_url + url_len, query_start, query_len);
    merged_url[url_len + query_len] = '\0';
  }

  /* Append r2h-seek-name parameter if present */
  if (configured_service->seek_param_name) {
    char seek_name_param[256];
    const char *separator;

    /* Determine separator based on whether URL already has query params */
    separator = strchr(merged_url, '?') ? "&" : "?";

    snprintf(seek_name_param, sizeof(seek_name_param), "%sr2h-seek-name=%s",
             separator, configured_service->seek_param_name);

    if (strlen(merged_url) + strlen(seek_name_param) < sizeof(merged_url)) {
      strcat(merged_url, seek_name_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-seek-name too long", type_name);
      return NULL;
    }
  }

  /* Append r2h-seek-offset parameter if non-zero */
  if (configured_service->seek_offset_seconds != 0) {
    char seek_offset_param[64];
    const char *separator;

    /* Determine separator based on whether URL already has query params */
    separator = strchr(merged_url, '?') ? "&" : "?";

    snprintf(seek_offset_param, sizeof(seek_offset_param),
             "%sr2h-seek-offset=%d", separator,
             configured_service->seek_offset_seconds);

    if (strlen(merged_url) + strlen(seek_offset_param) < sizeof(merged_url)) {
      strcat(merged_url, seek_offset_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-seek-offset too long",
             type_name);
      return NULL;
    }
  }

  /* Create new service from merged URL */
  logger(LOG_DEBUG, "Creating %s service with merged URL: %s", type_name,
         merged_url);

  if (expected_type == SERVICE_RTSP) {
    return service_create_from_rtsp_url(merged_url);
  } else /* SERVICE_MRTP */
  {
    return service_create_from_rtp_url(merged_url);
  }
}

service_t *service_create_from_rtp_url(const char *http_url) {
  service_t *result = NULL;
  char working_url[HTTP_URL_BUFFER_SIZE];
  char *url_part;
  struct rtp_url_components components;
  struct addrinfo hints, *res = NULL, *msrc_res = NULL, *fcc_res = NULL;
  struct sockaddr_storage *res_addr = NULL, *msrc_res_addr = NULL,
                          *fcc_res_addr = NULL;
  struct addrinfo *res_ai = NULL, *msrc_res_ai = NULL, *fcc_res_ai = NULL;
  int r = 0, rr = 0, rrr = 0;

  /* Validate input */
  if (!http_url || strlen(http_url) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long RTP URL");
    return NULL;
  }

  /* Copy URL to avoid modifying original */
  strncpy(working_url, http_url, sizeof(working_url) - 1);
  working_url[sizeof(working_url) - 1] = '\0';

  /* Check URL format and extract the part after prefix */
  if (strncmp(working_url, "rtp://", 6) == 0) {
    /* Direct RTP URL format: rtp://multicast_addr:port[@source]?query */
    url_part = working_url + 6; /* Skip "rtp://" */
  } else if (strncmp(working_url, "/rtp/", 5) == 0) {
    /* HTTP request format: /rtp/multicast_addr:port[@source]?query */
    url_part = working_url + 5; /* Skip "/rtp/" */
  } else if (strncmp(working_url, "udp://", 6) == 0) {
    /* Direct UDP URL format: udp://multicast_addr:port[@source]?query */
    url_part = working_url + 6; /* Skip "udp://" */
  } else if (strncmp(working_url, "/udp/", 5) == 0) {
    /* HTTP request format: /udp/multicast_addr:port[@source]?query */
    url_part = working_url + 5; /* Skip "/udp/" */
  } else {
    logger(LOG_ERROR, "Invalid RTP/UDP URL format (must start with rtp://, "
                      "/rtp/, udp://, or /udp/)");
    return NULL;
  }

  /* Check if URL part is empty */
  if (strlen(url_part) == 0) {
    logger(LOG_ERROR, "RTP URL part is empty");
    return NULL;
  }

  /* Allocate service structure */
  result = calloc(1, sizeof(service_t));
  if (!result) {
    logger(LOG_ERROR, "Failed to allocate memory for RTP service structure");
    return NULL;
  }

  /* Set service type to RTP */
  result->service_type = SERVICE_MRTP;

  /* Build and store full RTP URL (rtp://) */
  char rtp_url[HTTP_URL_BUFFER_SIZE];
  snprintf(rtp_url, sizeof(rtp_url), "rtp://%.1000s", url_part);
  result->rtp_url = strdup(rtp_url);
  if (!result->rtp_url) {
    logger(LOG_ERROR, "Failed to allocate memory for RTP URL");
    service_free(result);
    return NULL;
  }

  /* Parse RTP URL components */
  if (parse_rtp_url_components(url_part, &components) != 0) {
    logger(LOG_ERROR, "Failed to parse RTP URL components");
    service_free(result);
    return NULL;
  }

  logger(LOG_DEBUG, "Parsed RTP URL: mcast=%s:%s", components.multicast_addr,
         components.multicast_port);
  if (components.has_source) {
    logger(LOG_DEBUG, " src=%s:%s", components.source_addr,
           components.source_port);
  }
  if (components.has_fcc) {
    logger(LOG_DEBUG, " fcc=%s:%s", components.fcc_addr, components.fcc_port);
  }

  /* Resolve addresses */
  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_DGRAM;

  /* Resolve multicast address */
  r = getaddrinfo(components.multicast_addr, components.multicast_port, &hints,
                  &res);
  if (r != 0) {
    logger(LOG_ERROR, "Cannot resolve multicast address %s:%s. GAI: %s",
           components.multicast_addr, components.multicast_port,
           gai_strerror(r));
    free(result);
    return NULL;
  }

  /* Resolve source address if present */
  if (components.has_source) {
    const char *src_port =
        components.source_port[0] ? components.source_port : NULL;
    rr = getaddrinfo(components.source_addr, src_port, &hints, &msrc_res);
    if (rr != 0) {
      logger(LOG_ERROR, "Cannot resolve source address %s. GAI: %s",
             components.source_addr, gai_strerror(rr));
      freeaddrinfo(res);
      free(result);
      return NULL;
    }
  }

  /* Resolve FCC address if present */
  if (components.has_fcc) {
    const char *fcc_port = components.fcc_port[0] ? components.fcc_port : NULL;
    rrr = getaddrinfo(components.fcc_addr, fcc_port, &hints, &fcc_res);
    if (rrr != 0) {
      logger(LOG_ERROR, "Cannot resolve FCC address %s. GAI: %s",
             components.fcc_addr, gai_strerror(rrr));
      freeaddrinfo(res);
      if (msrc_res)
        freeaddrinfo(msrc_res);
      free(result);
      return NULL;
    }
  }

  /* Warn about ambiguous addresses */
  if (res->ai_next != NULL) {
    logger(LOG_WARN, "Multicast address is ambiguous (multiple results)");
  }
  if (msrc_res && msrc_res->ai_next != NULL) {
    logger(LOG_WARN, "Source address is ambiguous (multiple results)");
  }
  if (fcc_res && fcc_res->ai_next != NULL) {
    logger(LOG_WARN, "FCC address is ambiguous (multiple results)");
  }

  /* Allocate and copy multicast address structures */
  res_addr = malloc(sizeof(struct sockaddr_storage));
  res_ai = malloc(sizeof(struct addrinfo));
  if (!res_addr || !res_ai) {
    logger(LOG_ERROR, "Failed to allocate memory for address structures");
    freeaddrinfo(res);
    if (msrc_res)
      freeaddrinfo(msrc_res);
    if (fcc_res)
      freeaddrinfo(fcc_res);
    free(res_addr);
    free(res_ai);
    free(result);
    return NULL;
  }

  memcpy(res_addr, res->ai_addr, res->ai_addrlen);
  memcpy(res_ai, res, sizeof(struct addrinfo));
  res_ai->ai_addr = (struct sockaddr *)res_addr;
  res_ai->ai_canonname = NULL;
  res_ai->ai_next = NULL;
  result->addr = res_ai;

  /* Set up source address */
  result->msrc_addr = NULL;
  result->msrc = NULL;
  if (components.has_source) {
    msrc_res_addr = malloc(sizeof(struct sockaddr_storage));
    msrc_res_ai = malloc(sizeof(struct addrinfo));
    if (!msrc_res_addr || !msrc_res_ai) {
      logger(LOG_ERROR,
             "Failed to allocate memory for source address structures");
      freeaddrinfo(res);
      freeaddrinfo(msrc_res);
      if (fcc_res)
        freeaddrinfo(fcc_res);
      free(msrc_res_addr);
      free(msrc_res_ai);
      free(res_addr);
      free(res_ai);
      free(result);
      return NULL;
    }

    memcpy(msrc_res_addr, msrc_res->ai_addr, msrc_res->ai_addrlen);
    memcpy(msrc_res_ai, msrc_res, sizeof(struct addrinfo));
    msrc_res_ai->ai_addr = (struct sockaddr *)msrc_res_addr;
    msrc_res_ai->ai_canonname = NULL;
    msrc_res_ai->ai_next = NULL;
    result->msrc_addr = msrc_res_ai;

    /* Create source string for compatibility */
    char source_str[HTTP_SOURCE_STRING_SIZE];
    if (components.source_port[0]) {
      snprintf(source_str, sizeof(source_str), "%s:%s", components.source_addr,
               components.source_port);
    } else {
      strncpy(source_str, components.source_addr, sizeof(source_str) - 1);
      source_str[sizeof(source_str) - 1] = '\0';
    }
    result->msrc = strdup(source_str);
    if (!result->msrc) {
      logger(LOG_ERROR, "Failed to allocate memory for source string");
      freeaddrinfo(res);
      freeaddrinfo(msrc_res);
      if (fcc_res)
        freeaddrinfo(fcc_res);
      free(msrc_res_addr);
      free(msrc_res_ai);
      free(res_addr);
      free(res_ai);
      free(result);
      return NULL;
    }
  } else {
    result->msrc = strdup("");
    if (!result->msrc) {
      logger(LOG_ERROR, "Failed to allocate memory for empty source string");
      freeaddrinfo(res);
      if (msrc_res)
        freeaddrinfo(msrc_res);
      if (fcc_res)
        freeaddrinfo(fcc_res);
      free(res_addr);
      free(res_ai);
      free(result);
      return NULL;
    }
  }

  /* Set up FCC address */
  result->fcc_addr = NULL;
  result->fcc_type = components.fcc_type;
  if (components.has_fcc) {
    fcc_res_addr = malloc(sizeof(struct sockaddr_storage));
    fcc_res_ai = malloc(sizeof(struct addrinfo));
    if (!fcc_res_addr || !fcc_res_ai) {
      logger(LOG_ERROR, "Failed to allocate memory for FCC address structures");
      freeaddrinfo(res);
      if (msrc_res)
        freeaddrinfo(msrc_res);
      freeaddrinfo(fcc_res);
      free(fcc_res_addr);
      free(fcc_res_ai);
      if (msrc_res_addr)
        free(msrc_res_addr);
      if (msrc_res_ai)
        free(msrc_res_ai);
      free(res_addr);
      free(res_ai);
      if (result->msrc)
        free(result->msrc);
      free(result);
      return NULL;
    }

    memcpy(fcc_res_addr, fcc_res->ai_addr, fcc_res->ai_addrlen);
    memcpy(fcc_res_ai, fcc_res, sizeof(struct addrinfo));
    fcc_res_ai->ai_addr = (struct sockaddr *)fcc_res_addr;
    fcc_res_ai->ai_canonname = NULL;
    fcc_res_ai->ai_next = NULL;
    result->fcc_addr = fcc_res_ai;

    /* Determine FCC type based on explicit parameter or port-based detection */
    if (components.fcc_type_explicit) {
      logger(LOG_DEBUG, "FCC type explicitly set to %s",
             result->fcc_type == FCC_TYPE_HUAWEI ? "Huawei" : "Telecom");
    }
  }

  /* Free temporary addrinfo structures */
  freeaddrinfo(res);
  if (msrc_res)
    freeaddrinfo(msrc_res);
  if (fcc_res)
    freeaddrinfo(fcc_res);

  /* Store original URL for reference */
  result->url = strdup(http_url);
  if (!result->url) {
    logger(LOG_ERROR, "Failed to allocate memory for URL");
    service_free(result);
    return NULL;
  }

  logger(LOG_DEBUG, "Created RTP service from URL: %s", http_url);
  return result;
}

/* Clone addrinfo structure with embedded sockaddr */
static struct addrinfo *clone_addrinfo(const struct addrinfo *src) {
  struct addrinfo *cloned;

  if (!src) {
    return NULL;
  }

  cloned = malloc(sizeof(struct addrinfo));
  if (!cloned) {
    return NULL;
  }

  /* Copy all fields */
  memcpy(cloned, src, sizeof(struct addrinfo));

  /* Clone embedded sockaddr */
  if (src->ai_addr && src->ai_addrlen > 0) {
    cloned->ai_addr = malloc(src->ai_addrlen);
    if (!cloned->ai_addr) {
      free(cloned);
      return NULL;
    }
    memcpy(cloned->ai_addr, src->ai_addr, src->ai_addrlen);
  } else {
    cloned->ai_addr = NULL;
  }

  /* Don't copy ai_next - cloned addrinfo is standalone */
  cloned->ai_next = NULL;
  cloned->ai_canonname = NULL; /* Don't clone canonname */

  return cloned;
}

service_t *service_clone(service_t *service) {
  service_t *cloned;

  if (!service) {
    return NULL;
  }

  /* Allocate new service structure */
  cloned = malloc(sizeof(service_t));
  if (!cloned) {
    logger(LOG_ERROR, "Failed to allocate memory for cloned service");
    return NULL;
  }

  /* Initialize all fields to NULL/0 */
  memset(cloned, 0, sizeof(service_t));

  /* Copy simple fields */
  cloned->service_type = service->service_type;
  cloned->source = service->source;
  cloned->fcc_type = service->fcc_type;

  /* Clone string fields */
  if (service->url) {
    cloned->url = strdup(service->url);
    if (!cloned->url) {
      goto cleanup_error;
    }
  }

  if (service->msrc) {
    cloned->msrc = strdup(service->msrc);
    if (!cloned->msrc) {
      goto cleanup_error;
    }
  }

  if (service->rtp_url) {
    cloned->rtp_url = strdup(service->rtp_url);
    if (!cloned->rtp_url) {
      goto cleanup_error;
    }
  }

  if (service->rtsp_url) {
    cloned->rtsp_url = strdup(service->rtsp_url);
    if (!cloned->rtsp_url) {
      goto cleanup_error;
    }
  }

  if (service->seek_param_name) {
    cloned->seek_param_name = strdup(service->seek_param_name);
    if (!cloned->seek_param_name) {
      goto cleanup_error;
    }
  }

  if (service->seek_param_value) {
    cloned->seek_param_value = strdup(service->seek_param_value);
    if (!cloned->seek_param_value) {
      goto cleanup_error;
    }
  }

  /* Copy seek_offset_seconds */
  cloned->seek_offset_seconds = service->seek_offset_seconds;

  if (service->user_agent) {
    cloned->user_agent = strdup(service->user_agent);
    if (!cloned->user_agent) {
      goto cleanup_error;
    }
  }

  /* Clone addrinfo structures */
  if (service->addr) {
    cloned->addr = clone_addrinfo(service->addr);
    if (!cloned->addr) {
      goto cleanup_error;
    }
  }

  if (service->msrc_addr) {
    cloned->msrc_addr = clone_addrinfo(service->msrc_addr);
    if (!cloned->msrc_addr) {
      goto cleanup_error;
    }
  }

  if (service->fcc_addr) {
    cloned->fcc_addr = clone_addrinfo(service->fcc_addr);
    if (!cloned->fcc_addr) {
      goto cleanup_error;
    }
  }

  /* Don't copy next pointer - cloned service is standalone */
  cloned->next = NULL;

  return cloned;

cleanup_error:
  logger(LOG_ERROR, "Failed to clone service - out of memory");
  service_free(cloned);
  return NULL;
}

void service_free(service_t *service) {
  if (!service) {
    return;
  }

  /* Free RTP-specific fields */
  if (service->service_type == SERVICE_MRTP) {
    if (service->rtp_url) {
      free(service->rtp_url);
      service->rtp_url = NULL;
    }
  }

  /* Free RTSP-specific fields */
  if (service->service_type == SERVICE_RTSP) {
    if (service->rtsp_url) {
      free(service->rtsp_url);
      service->rtsp_url = NULL;
    }

    if (service->seek_param_name) {
      free(service->seek_param_name);
      service->seek_param_name = NULL;
    }

    if (service->seek_param_value) {
      free(service->seek_param_value);
      service->seek_param_value = NULL;
    }

    if (service->user_agent) {
      free(service->user_agent);
      service->user_agent = NULL;
    }
  }

  /* Free common fields */
  if (service->url) {
    free(service->url);
    service->url = NULL;
  }

  if (service->msrc) {
    free(service->msrc);
    service->msrc = NULL;
  }

  /* Free address structures and their embedded sockaddr */
  if (service->addr) {
    if (service->addr->ai_addr) {
      free(service->addr->ai_addr);
    }
    free(service->addr);
    service->addr = NULL;
  }

  if (service->msrc_addr) {
    if (service->msrc_addr->ai_addr) {
      free(service->msrc_addr->ai_addr);
    }
    free(service->msrc_addr);
    service->msrc_addr = NULL;
  }

  if (service->fcc_addr) {
    if (service->fcc_addr->ai_addr) {
      free(service->fcc_addr->ai_addr);
    }
    free(service->fcc_addr);
    service->fcc_addr = NULL;
  }

  /* Free the service structure itself */
  free(service);
}

void service_free_external(void) {
  service_t **current_ptr = &services;
  service_t *current;
  int freed_count = 0;

  while (*current_ptr != NULL) {
    current = *current_ptr;

    /* If this service is from external M3U, remove it */
    if (current->source == SERVICE_SOURCE_EXTERNAL) {
      *current_ptr = current->next;    /* Remove from list */
      service_hashmap_remove(current); /* Remove from hashmap */
      service_free(current);
      freed_count++;
    } else {
      /* Keep this service, move to next */
      current_ptr = &(current->next);
    }
  }

  logger(LOG_INFO, "Freed %d external M3U services", freed_count);
}

/* ========== SERVICE HASHMAP IMPLEMENTATION ========== */

/**
 * Hash function for service URL
 * Uses the URL string as the key with xxhash3 for better performance
 * Note: item is a pointer to service_t* (i.e., service_t**)
 */
static uint64_t service_hash(const void *item, uint64_t seed0, uint64_t seed1) {
  service_t *service = *(service_t *const *)item;
  return hashmap_xxhash3(service->url, strlen(service->url), seed0, seed1);
}

/**
 * Compare function for service URL
 * Compares URL strings
 * Note: a and b are pointers to service_t* (i.e., service_t**)
 */
static int service_compare(const void *a, const void *b, void *udata) {
  service_t *sa = *(service_t *const *)a;
  service_t *sb = *(service_t *const *)b;
  (void)udata; /* Unused */
  return strcmp(sa->url, sb->url);
}

void service_hashmap_init(void) {
  if (service_map != NULL) {
    logger(LOG_WARN, "Service hashmap already initialized");
    return;
  }

  /* Create hashmap with initial capacity of 64
   * elsize is sizeof(service_t *) because we store pointers to services
   * We use random seeds for security
   */
  service_map = hashmap_new(sizeof(service_t *), 64, 0, 0, service_hash,
                            service_compare, NULL, NULL);

  if (service_map == NULL) {
    logger(LOG_ERROR, "Failed to create service hashmap");
  } else {
    logger(LOG_DEBUG, "Service hashmap initialized");
  }
}

void service_hashmap_free(void) {
  if (service_map != NULL) {
    hashmap_free(service_map);
    service_map = NULL;
    logger(LOG_DEBUG, "Service hashmap freed");
  }
}

void service_hashmap_add(service_t *service) {
  if (service_map == NULL) {
    logger(LOG_ERROR, "Service hashmap not initialized");
    return;
  }

  if (service == NULL || service->url == NULL) {
    logger(LOG_ERROR, "Invalid service for hashmap add");
    return;
  }

  /* Store pointer to the service in the hashmap
   * We pass &service because hashmap stores service_t* (pointer to service)
   * The hashmap will copy this pointer value into its internal storage */
  const void *old = hashmap_set(service_map, &service);

  if (hashmap_oom(service_map)) {
    logger(LOG_ERROR, "Out of memory when adding service to hashmap: %s",
           service->url);
  } else if (old != NULL) {
    logger(LOG_WARN, "Service URL already exists in hashmap (replaced): %s",
           service->url);
  }
}

void service_hashmap_remove(service_t *service) {
  if (service_map == NULL) {
    logger(LOG_ERROR, "Service hashmap not initialized");
    return;
  }

  if (service == NULL || service->url == NULL) {
    logger(LOG_ERROR, "Invalid service for hashmap remove");
    return;
  }

  hashmap_delete(service_map, &service);
}

service_t *service_hashmap_get(const char *url) {
  if (service_map == NULL) {
    logger(LOG_ERROR, "Service hashmap not initialized");
    return NULL;
  }

  if (url == NULL) {
    return NULL;
  }

  /* Create a temporary service pointer to use as search key
   * We need to cast away const here because the hashmap expects a non-const
   * pointer, but we only use it for lookup, not modification */
  service_t key_service;
  memset(&key_service, 0, sizeof(key_service));
  key_service.url =
      (char *)(uintptr_t)url; /* Cast via uintptr_t to avoid warning */

  /* Pass pointer to the key service pointer (service_t**) */
  service_t *key_ptr = &key_service;
  const void *result = hashmap_get(service_map, &key_ptr);

  if (result == NULL) {
    return NULL;
  }

  return *(service_t *const *)result;
}

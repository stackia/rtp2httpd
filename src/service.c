#include "service.h"
#include "fcc.h"
#include "hashmap.h"
#include "http.h"
#include "timezone.h"
#include "url_template.h"
#include "utils.h"
#include <limits.h>
#include <net/if.h>
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
  uint16_t fec_port;     /* FEC multicast port (0 if not configured) */
};

/* Service lookup hashmap for O(1) service lookup by URL */
static struct hashmap *service_map = NULL;

static int parse_ipv6_address(const char *input, char *addr, size_t addr_size, const char **remainder) {
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

static int parse_address_port(const char *input, char *addr, size_t addr_size, char *port, size_t port_size) {
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

static int parse_rtp_url_components(char *url_part, struct rtp_url_components *components) {
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
    if (http_parse_query_param(query_start, "fcc", fcc_value, sizeof(fcc_value)) == 0) {
      /* Check for empty FCC value */
      if (fcc_value[0] == '\0') {
        return -1; /* Empty FCC parameter */
      }
      if (parse_address_port(fcc_value, components->fcc_addr, sizeof(components->fcc_addr), components->fcc_port,
                             sizeof(components->fcc_port)) != 0) {
        return -1;
      }
      components->has_fcc = 1;
    }

    /* Parse fcc-type parameter from query string */
    if (http_parse_query_param(query_start, "fcc-type", fcc_type_value, sizeof(fcc_type_value)) == 0) {
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

    /* Parse FEC port parameter from query string */
    char fec_port_value[16];
    if (http_parse_query_param(query_start, "fec", fec_port_value, sizeof(fec_port_value)) == 0) {
      if (fec_port_value[0] != '\0') {
        char *endptr;
        long port = strtol(fec_port_value, &endptr, 10);
        if (*endptr == '\0' && port > 0 && port <= 65535) {
          components->fec_port = (uint16_t)port;
        }
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
    if (parse_address_port(main_part, components->source_addr, sizeof(components->source_addr), components->source_port,
                           sizeof(components->source_port)) != 0) {
      return -1;
    }
    components->has_source = 1;

    /* Parse multicast address */
    if (parse_address_port(at_pos + 1, components->multicast_addr, sizeof(components->multicast_addr),
                           components->multicast_port, sizeof(components->multicast_port)) != 0) {
      return -1;
    }
  } else {
    /* No source, only multicast address */
    if (parse_address_port(main_part, components->multicast_addr, sizeof(components->multicast_addr),
                           components->multicast_port, sizeof(components->multicast_port)) != 0) {
      return -1;
    }
  }

  /* Set default port if not specified */
  if (components->multicast_port[0] == '\0') {
    strcpy(components->multicast_port, "1234");
  }

  return 0;
}

/* Helper: remove a query parameter in-place from a query string.
 * query_start points to '?' (may be set to NULL if query becomes empty).
 * param_start points to the first char of the parameter name.
 * value_end points past the last char of the parameter value. */
static void remove_query_param(char **query_start, char *param_start, char *value_end) {
  char *qs = *query_start;

  if (param_start == qs + 1) {
    /* First parameter */
    if (*value_end == '&') {
      memmove(qs + 1, value_end + 1, strlen(value_end + 1) + 1);
    } else {
      *qs = '\0';
      *query_start = NULL;
    }
  } else {
    /* Not first parameter, remove including preceding '&' */
    char *amp = param_start - 1;
    if (*value_end == '&') {
      memmove(amp, value_end, strlen(value_end) + 1);
    } else {
      *amp = '\0';
    }
  }
}

/* Find first occurrence of `param_name=` in the query string anchored at qs
 * (the '?' character). Returns pointer to the start of the param name, or NULL.
 * Read-only in practice; signature matches strstr's char*-in-char*-out idiom. */
static char *find_query_param(char *qs, const char *param_name, size_t name_len) {
  char *p = qs;
  while ((p = strstr(p, param_name)) != NULL) {
    int leading_ok = (p == qs + 1) || (p > qs && *(p - 1) == '&');
    int trailing_ok = (p[name_len] == '=');
    if (leading_ok && trailing_ok) {
      return p;
    }
    p++;
  }
  return NULL;
}

/* Convenience: does the request query string contain `param_name=...`? */
static int request_query_has(char *request_query_start, const char *param_name) {
  if (!request_query_start || *request_query_start != '?') {
    return 0;
  }
  return find_query_param(request_query_start, param_name, strlen(param_name)) != NULL;
}

/**
 * Parse the value of r2h-seek-mode.
 * Recognized syntax:
 *   passthrough              -> SEEK_MODE_PASSTHROUGH
 *   range[(<TZ>[/<seconds>])]
 *     where <TZ> = "UTC" / "UTC+N" / "UTC-N" (optional; empty means inherit)
 *     and <seconds> is a positive integer (optional; defaults to
 *     SEEK_MODE_DEFAULT_WINDOW_SECONDS).
 * Anything unrecognized maps to SEEK_MODE_PASSTHROUGH with a warn log.
 */
static int parse_seek_mode_value(const char *value, seek_mode_t *out_mode, int *out_tz_explicit,
                                 int *out_tz_offset_seconds, int *out_window_seconds) {
  if (!out_mode || !out_tz_explicit || !out_tz_offset_seconds || !out_window_seconds) {
    return -1;
  }

  *out_mode = SEEK_MODE_PASSTHROUGH;
  *out_tz_explicit = 0;
  *out_tz_offset_seconds = 0;
  *out_window_seconds = SEEK_MODE_DEFAULT_WINDOW_SECONDS;

  if (!value || value[0] == '\0' || strcasecmp(value, "passthrough") == 0) {
    return 0;
  }

  if (strncasecmp(value, "range", 5) != 0) {
    logger(LOG_WARN, "Unrecognized r2h-seek-mode value '%s', falling back to passthrough", value);
    return 0;
  }

  const char *rest = value + 5;
  if (rest[0] == '\0') {
    *out_mode = SEEK_MODE_RANGE;
    return 0;
  }

  if (rest[0] != '(') {
    logger(LOG_WARN,
           "Invalid r2h-seek-mode value '%s' (expected 'range(...)' or 'range'), "
           "falling back to passthrough",
           value);
    return 0;
  }

  rest++;

  const char *close = strchr(rest, ')');
  if (!close) {
    logger(LOG_WARN, "Invalid r2h-seek-mode value '%s' (missing ')'), falling back to passthrough", value);
    return 0;
  }

  if (close[1] != '\0') {
    logger(LOG_WARN,
           "Invalid r2h-seek-mode value '%s' (trailing characters after ')'), "
           "falling back to passthrough",
           value);
    return 0;
  }

  size_t inner_len = (size_t)(close - rest);
  if (inner_len >= 64) {
    logger(LOG_WARN, "r2h-seek-mode '%s' too long, falling back to passthrough", value);
    return 0;
  }

  char inner[64];
  memcpy(inner, rest, inner_len);
  inner[inner_len] = '\0';

  if (inner[0] == '\0') {
    *out_mode = SEEK_MODE_RANGE;
    return 0;
  }

  char *slash = strchr(inner, '/');
  char *tz_part;
  char *secs_part;

  if (slash) {
    *slash = '\0';
    tz_part = inner;
    secs_part = slash + 1;
  } else {
    /* No slash: distinguish "TZ only" from "seconds only" by the UTC prefix. */
    if (strncasecmp(inner, "UTC", 3) == 0) {
      tz_part = inner;
      secs_part = NULL;
    } else {
      tz_part = NULL;
      secs_part = inner;
    }
  }

  if (tz_part && tz_part[0] != '\0') {
    int tz_seconds = 0;
    const char *tz_endptr = NULL;
    if (timezone_parse_utc_offset(tz_part, &tz_seconds, &tz_endptr) != 0 || !tz_endptr || *tz_endptr != '\0') {
      logger(LOG_WARN, "Invalid TZ '%s' in r2h-seek-mode, falling back to passthrough", tz_part);
      return 0;
    }
    *out_tz_offset_seconds = tz_seconds;
    *out_tz_explicit = 1;
  }

  if (secs_part && secs_part[0] != '\0') {
    char *endptr;
    long window = strtol(secs_part, &endptr, 10);
    if (*endptr != '\0' || window <= 0 || window > SEEK_MODE_MAX_WINDOW_SECONDS) {
      logger(LOG_WARN, "Invalid window seconds '%s' in r2h-seek-mode (must be 1-%d), falling back to passthrough",
             secs_part, SEEK_MODE_MAX_WINDOW_SECONDS);
      *out_tz_explicit = 0;
      *out_tz_offset_seconds = 0;
      return 0;
    }
    *out_window_seconds = (int)window;
  }

  *out_mode = SEEK_MODE_RANGE;
  return 0;
}

/**
 * Find a query parameter, copy its URL-decoded value into the caller's buffer,
 * and remove the parameter from the query string in place. If the parameter is
 * present multiple times, only the first occurrence's value is returned and
 * every subsequent duplicate is also stripped to prevent the leftover copies
 * from leaking into the upstream URI (where they could even override the value
 * we just extracted).
 *
 * @return  1 if the param was present and decoded successfully,
 *          0 if the param was absent,
 *         -1 on decode failure or value too long for the buffer (param is
 *            still removed from the query in those cases).
 */
static int extract_query_param(char **query_start_ptr, const char *param_name, char *out_value, size_t out_size) {
  if (!query_start_ptr || !*query_start_ptr || !param_name || !out_value || out_size == 0)
    return 0;

  size_t name_len = strlen(param_name);
  char *match = find_query_param(*query_start_ptr, param_name, name_len);
  if (!match)
    return 0;

  char *value_start = match + name_len + 1;
  char *value_end = strchr(value_start, '&');
  if (!value_end)
    value_end = value_start + strlen(value_start);

  size_t value_len = (size_t)(value_end - value_start);
  int rc = 1;
  if (value_len >= out_size) {
    logger(LOG_WARN, "Value for query param '%s' too long (max %zu bytes), ignoring", param_name, out_size - 1);
    out_value[0] = '\0';
    rc = -1;
  } else {
    memcpy(out_value, value_start, value_len);
    out_value[value_len] = '\0';
  }

  remove_query_param(query_start_ptr, match, value_end);

  /* Strip any duplicate occurrences. A misbehaving client sending the param
   * twice would otherwise leak the second copy into the upstream URI, where
   * it could even be re-parsed before the value we just extracted. */
  while (*query_start_ptr) {
    char *dup = find_query_param(*query_start_ptr, param_name, name_len);
    if (!dup)
      break;
    char *dup_value_end = strchr(dup + name_len + 1, '&');
    if (!dup_value_end)
      dup_value_end = dup + name_len + 1 + strlen(dup + name_len + 1);
    logger(LOG_WARN, "Duplicate query param '%s' stripped to avoid upstream leak", param_name);
    remove_query_param(query_start_ptr, dup, dup_value_end);
  }

  if (rc == 1 && http_url_decode(out_value) != 0) {
    logger(LOG_ERROR, "Failed to decode query param '%s'", param_name);
    out_value[0] = '\0';
    return -1;
  }

  return rc;
}

int service_extract_seek_params(char *query_start, char **out_seek_param_name, char **out_seek_param_value,
                                int *out_seek_offset_seconds, seek_mode_t *out_seek_mode,
                                int *out_seek_mode_tz_explicit, int *out_seek_mode_tz_offset_seconds,
                                int *out_seek_mode_window_seconds) {
  char r2h_seek_name_buf[128];
  int has_seek_name = 0;
  const char *seek_param_name = NULL;
  char *seek_param_value = NULL;
  int seek_offset_seconds = 0;
  seek_mode_t seek_mode = SEEK_MODE_PASSTHROUGH;
  int seek_mode_tz_explicit = 0;
  int seek_mode_tz_offset_seconds = 0;
  int seek_mode_window_seconds = SEEK_MODE_DEFAULT_WINDOW_SECONDS;
  char heuristic_seek_name[16];

  if (!query_start || *query_start != '?' || !out_seek_param_name || !out_seek_param_value ||
      !out_seek_offset_seconds || !out_seek_mode || !out_seek_mode_tz_explicit || !out_seek_mode_tz_offset_seconds ||
      !out_seek_mode_window_seconds) {
    return -1;
  }

  *out_seek_param_name = NULL;
  *out_seek_param_value = NULL;
  *out_seek_offset_seconds = 0;
  *out_seek_mode = SEEK_MODE_PASSTHROUGH;
  *out_seek_mode_tz_explicit = 0;
  *out_seek_mode_tz_offset_seconds = 0;
  *out_seek_mode_window_seconds = SEEK_MODE_DEFAULT_WINDOW_SECONDS;

  if (extract_query_param(&query_start, "r2h-seek-name", r2h_seek_name_buf, sizeof(r2h_seek_name_buf)) == 1) {
    has_seek_name = 1;
    logger(LOG_DEBUG, "Found r2h-seek-name parameter: %s", r2h_seek_name_buf);
  }

  char offset_buf[32];
  if (extract_query_param(&query_start, "r2h-seek-offset", offset_buf, sizeof(offset_buf)) == 1) {
    char *endptr;
    long offset_val = strtol(offset_buf, &endptr, 10);
    if (*endptr == '\0' && offset_val >= INT_MIN && offset_val <= INT_MAX) {
      seek_offset_seconds = (int)offset_val;
      logger(LOG_DEBUG, "Found r2h-seek-offset parameter: %d seconds", seek_offset_seconds);
    } else {
      logger(LOG_WARN, "Invalid r2h-seek-offset value: %s", offset_buf);
    }
  }

  char mode_buf[96];
  if (extract_query_param(&query_start, "r2h-seek-mode", mode_buf, sizeof(mode_buf)) == 1) {
    parse_seek_mode_value(mode_buf, &seek_mode, &seek_mode_tz_explicit, &seek_mode_tz_offset_seconds,
                          &seek_mode_window_seconds);
    if (seek_mode == SEEK_MODE_RANGE) {
      if (seek_mode_tz_explicit) {
        logger(LOG_DEBUG, "Found r2h-seek-mode: range (TZ %+d sec, window %d sec)", seek_mode_tz_offset_seconds,
               seek_mode_window_seconds);
      } else {
        logger(LOG_DEBUG, "Found r2h-seek-mode: range (TZ from UA fallback, window %d sec)", seek_mode_window_seconds);
      }
    } else {
      logger(LOG_DEBUG, "Found r2h-seek-mode: passthrough");
    }
  }

  /* Step 2: Determine seek parameter name */
  if (has_seek_name) {
    seek_param_name = r2h_seek_name_buf;
    logger(LOG_DEBUG, "Using explicitly specified seek parameter name: %s", seek_param_name);
  } else if (query_start) {
    /* Heuristic detection with fixed priority: playseek > tvdr
     * Use case-insensitive matching and preserve original case */
    char *playseek_check = strcasestr(query_start, "playseek=");
    if (playseek_check && (playseek_check == query_start + 1 || *(playseek_check - 1) == '&')) {
      memcpy(heuristic_seek_name, playseek_check, 8);
      heuristic_seek_name[8] = '\0';
      seek_param_name = heuristic_seek_name;
      logger(LOG_DEBUG, "Heuristic: detected playseek parameter (%s)", seek_param_name);
    } else {
      char *tvdr_check = strcasestr(query_start, "tvdr=");
      if (tvdr_check && (tvdr_check == query_start + 1 || *(tvdr_check - 1) == '&')) {
        memcpy(heuristic_seek_name, tvdr_check, 4);
        heuristic_seek_name[4] = '\0';
        seek_param_name = heuristic_seek_name;
        logger(LOG_DEBUG, "Heuristic: detected tvdr parameter (%s)", seek_param_name);
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
    char *seek_start, *seek_end;

    /* Iterate through all occurrences of the seek parameter (case-insensitive) */
    while ((seek_start = strcasestr(search_pos, search_pattern)) != NULL) {
      if (seek_start > query_start && *(seek_start - 1) != '?' && *(seek_start - 1) != '&') {
        search_pos = seek_start + strlen(search_pattern);
        continue;
      }

      seek_start += strlen(search_pattern);
      seek_end = strchr(seek_start, '&');
      if (!seek_end)
        seek_end = seek_start + strlen(seek_start);

      size_t param_len = seek_end - seek_start;
      char *current_value = malloc(param_len + 1);
      if (!current_value) {
        logger(LOG_ERROR, "Failed to allocate memory for %s parameter", seek_param_name);
        if (first_value)
          free(first_value);
        if (selected_value)
          free(selected_value);
        goto fail;
      }

      strncpy(current_value, seek_start, param_len);
      current_value[param_len] = '\0';

      if (http_url_decode(current_value) != 0) {
        logger(LOG_ERROR, "Failed to decode %s parameter value", seek_param_name);
        free(current_value);
        if (first_value)
          free(first_value);
        if (selected_value)
          free(selected_value);
        goto fail;
      }

      if (!first_value)
        first_value = strdup(current_value);

      if (!selected_value && current_value && !strchr(current_value, '{') && !strchr(current_value, '}')) {
        selected_value = strdup(current_value);
        logger(LOG_DEBUG, "Found valid %s parameter: %s", seek_param_name, selected_value);
      }

      free(current_value);
      search_pos = seek_end;
    }

    /* Determine which value to use */
    if (selected_value) {
      seek_param_value = selected_value;
      if (first_value)
        free(first_value);
    } else if (first_value) {
      seek_param_value = first_value;
      logger(LOG_DEBUG, "No valid format found for %s, using first value as fallback: %s", seek_param_name,
             seek_param_value);
    }

    /* Remove all seek parameters from URL (case-insensitive) */
    if (seek_param_value) {
      char *remove_pos = query_start;
      while ((seek_start = strcasestr(remove_pos, search_pattern)) != NULL) {
        if (seek_start > query_start && *(seek_start - 1) != '?' && *(seek_start - 1) != '&') {
          remove_pos = seek_start + strlen(search_pattern);
          continue;
        }

        char *param_to_remove_start = seek_start;
        if (seek_start > query_start + 1)
          param_to_remove_start = seek_start - 1;

        char *param_value_end = strchr(seek_start, '&');
        if (param_value_end) {
          if (seek_start == query_start + 1) {
            memmove(query_start + 1, param_value_end + 1, strlen(param_value_end + 1) + 1);
          } else {
            memmove(param_to_remove_start, param_value_end, strlen(param_value_end) + 1);
          }
          remove_pos = param_to_remove_start;
        } else {
          if (seek_start == query_start + 1) {
            *query_start = '\0';
          } else {
            *param_to_remove_start = '\0';
          }
          break;
        }
      }
    }
  }

  if (seek_param_name)
    *out_seek_param_name = strdup(seek_param_name);
  *out_seek_param_value = seek_param_value;
  seek_param_value = NULL; /* Transfer ownership */
  *out_seek_offset_seconds = seek_offset_seconds;
  *out_seek_mode = seek_mode;
  *out_seek_mode_tz_explicit = seek_mode_tz_explicit;
  *out_seek_mode_tz_offset_seconds = seek_mode_tz_offset_seconds;
  *out_seek_mode_window_seconds = seek_mode_window_seconds;

  return 0;

fail:
  if (seek_param_value)
    free(seek_param_value);
  return -1;
}

/**
 * Extract r2h-ifname and r2h-ifname-fcc from query string, removing them
 * in-place. Duplicate occurrences are stripped automatically by
 * extract_query_param so they never leak into the upstream URI.
 * @param query_start Pointer to '?' in URL (may be set to NULL if query becomes
 * empty)
 * @param out_ifname Output: malloc'd ifname string (caller frees), or NULL
 * @param out_ifname_fcc Output: malloc'd ifname_fcc string (caller frees), or
 * NULL
 */
static void service_extract_ifname_params(char *query_start, char **out_ifname, char **out_ifname_fcc) {
  if (!out_ifname || !out_ifname_fcc) {
    return;
  }
  *out_ifname = NULL;
  *out_ifname_fcc = NULL;

  if (!query_start || *query_start != '?') {
    return;
  }

  /* Extract r2h-ifname-fcc first (the trailing '=' check inside
   * extract_query_param keeps it from matching r2h-ifname). */
  char ifname_fcc_buf[IFNAMSIZ];
  if (extract_query_param(&query_start, "r2h-ifname-fcc", ifname_fcc_buf, sizeof(ifname_fcc_buf)) == 1) {
    *out_ifname_fcc = strdup(ifname_fcc_buf);
    if (*out_ifname_fcc) {
      logger(LOG_DEBUG, "Found r2h-ifname-fcc parameter: %s", *out_ifname_fcc);
    }
  }

  char ifname_buf[IFNAMSIZ];
  if (extract_query_param(&query_start, "r2h-ifname", ifname_buf, sizeof(ifname_buf)) == 1) {
    *out_ifname = strdup(ifname_buf);
    if (*out_ifname) {
      logger(LOG_DEBUG, "Found r2h-ifname parameter: %s", *out_ifname);
    }
  }
}

static int is_valid_seek_time_value(const char *value) {
  time_t parsed_time;

  if (!value || value[0] == '\0')
    return 0;

  return timezone_parse_to_utc(value, 0, 0, &parsed_time) == 0;
}

static const char *find_seek_range_separator(const char *value) {
  const char *separator;

  if (!value)
    return NULL;

  separator = value;
  while ((separator = strchr(separator, '-')) != NULL) {
    char begin_candidate[128] = {0};
    size_t begin_len = (size_t)(separator - value);

    if (begin_len > 0 && begin_len < sizeof(begin_candidate)) {
      memcpy(begin_candidate, value, begin_len);
      begin_candidate[begin_len] = '\0';

      if (is_valid_seek_time_value(begin_candidate)) {
        const char *end_candidate = separator + 1;

        if (*end_candidate == '\0' || is_valid_seek_time_value(end_candidate))
          return separator;
      }
    }

    separator++;
  }

  return NULL;
}

int service_parse_seek_value(const char *seek_param_value, int seek_offset_seconds, const char *user_agent,
                             seek_mode_t seek_mode, int seek_mode_tz_explicit, int seek_mode_tz_offset_seconds,
                             int seek_mode_window_seconds, seek_parse_result_t *parse_result) {
  const char *dash_pos;

  if (!parse_result)
    return -1;

  memset(parse_result, 0, sizeof(*parse_result));
  parse_result->seek_offset_seconds = seek_offset_seconds;
  parse_result->now_utc = time(NULL);

  if (user_agent)
    timezone_parse_from_user_agent(user_agent, &parse_result->tz_offset_seconds);

  if (!seek_param_value || seek_param_value[0] == '\0')
    return 0;

  parse_result->has_seek = 1;
  dash_pos = find_seek_range_separator(seek_param_value);
  parse_result->has_range_separator = (dash_pos != NULL);

  if (dash_pos) {
    size_t begin_len = (size_t)(dash_pos - seek_param_value);
    if (begin_len > 0 && begin_len < sizeof(parse_result->begin_str)) {
      memcpy(parse_result->begin_str, seek_param_value, begin_len);
      parse_result->begin_str[begin_len] = '\0';
      parse_result->has_begin = 1;
    }

    strncpy(parse_result->end_str, dash_pos + 1, sizeof(parse_result->end_str) - 1);
    parse_result->end_str[sizeof(parse_result->end_str) - 1] = '\0';
    if (parse_result->end_str[0] != '\0')
      parse_result->has_end = 1;
  } else {
    strncpy(parse_result->begin_str, seek_param_value, sizeof(parse_result->begin_str) - 1);
    parse_result->begin_str[sizeof(parse_result->begin_str) - 1] = '\0';
    if (parse_result->begin_str[0] != '\0')
      parse_result->has_begin = 1;
  }

  if (parse_result->has_begin && timezone_parse_to_utc(parse_result->begin_str, parse_result->tz_offset_seconds,
                                                       seek_offset_seconds, &parse_result->begin_utc) == 0) {
    parse_result->begin_parsed = 1;
  }

  if (parse_result->has_end && timezone_parse_to_utc(parse_result->end_str, parse_result->tz_offset_seconds,
                                                     seek_offset_seconds, &parse_result->end_utc) == 0) {
    parse_result->end_parsed = 1;
  }

  if (parse_result->begin_parsed) {
    struct tm *tmp;
    tmp = gmtime(&parse_result->begin_utc);
    if (!tmp)
      return -1;
    parse_result->begin_tm_utc = *tmp;
    time_t local_ts = parse_result->begin_utc + parse_result->tz_offset_seconds;
    tmp = gmtime(&local_ts);
    if (!tmp)
      return -1;
    parse_result->begin_tm_local = *tmp;
  }

  if (parse_result->end_parsed) {
    struct tm *tmp;
    tmp = gmtime(&parse_result->end_utc);
    if (!tmp)
      return -1;
    parse_result->end_tm_utc = *tmp;
    time_t local_ts = parse_result->end_utc + parse_result->tz_offset_seconds;
    tmp = gmtime(&local_ts);
    if (!tmp)
      return -1;
    parse_result->end_tm_local = *tmp;
  }

  /* Recent-clock optimization: opt-in via r2h-seek-mode=range(...). The TZ used
   * for the recency comparison may differ from the passthrough TZ when range()
   * supplies an explicit TZ that overrides the UA TZ. r2h-seek-offset is baked
   * into begin_utc via timezone_parse_to_utc above and propagates here.
   *
   * The recent-clock UTC time is stored separately in recent_clock_tm_utc so
   * the RTSP `Range: clock=` formatter can use it without disturbing
   * begin_tm_utc. begin_tm_utc is shared with the HTTP URL-template path,
   * which would otherwise render placeholders in the explicit-TZ frame even
   * though r2h-seek-mode is documented as RTSP-only. */
  if (seek_mode == SEEK_MODE_RANGE && parse_result->begin_parsed && parse_result->now_utc != (time_t)-1) {
    time_t begin_utc_for_recent;
    int recompute = seek_mode_tz_explicit && seek_mode_tz_offset_seconds != parse_result->tz_offset_seconds;
    if (recompute) {
      if (timezone_parse_to_utc(parse_result->begin_str, seek_mode_tz_offset_seconds, seek_offset_seconds,
                                &begin_utc_for_recent) != 0) {
        return 0;
      }
    } else {
      begin_utc_for_recent = parse_result->begin_utc;
    }
    if (begin_utc_for_recent <= parse_result->now_utc &&
        parse_result->now_utc - begin_utc_for_recent < (time_t)seek_mode_window_seconds) {
      parse_result->is_recent = 1;
      struct tm *tmp = gmtime(&begin_utc_for_recent);
      if (tmp)
        parse_result->recent_clock_tm_utc = *tmp;
    }
  }

  return 0;
}

int service_convert_seek_value(const seek_parse_result_t *parse_result, char *output, size_t output_size) {
  char begin_utc[128] = {0};
  char end_utc[128] = {0};

  if (!parse_result || !output || output_size == 0)
    return -1;

  if (!parse_result->has_seek)
    return -1;

  logger(LOG_DEBUG, "Parsed seek - begin='%s', end='%s'", parse_result->begin_str, parse_result->end_str);

  if (parse_result->has_begin &&
      timezone_convert_time_with_offset(parse_result->begin_str, parse_result->tz_offset_seconds,
                                        parse_result->seek_offset_seconds, begin_utc, sizeof(begin_utc)) == 0) {
    logger(LOG_DEBUG, "Converted begin time '%s' to UTC '%s'", parse_result->begin_str, begin_utc);
  } else {
    strncpy(begin_utc, parse_result->begin_str, sizeof(begin_utc) - 1);
    begin_utc[sizeof(begin_utc) - 1] = '\0';
  }

  if (parse_result->has_end) {
    if (timezone_convert_time_with_offset(parse_result->end_str, parse_result->tz_offset_seconds,
                                          parse_result->seek_offset_seconds, end_utc, sizeof(end_utc)) == 0) {
      logger(LOG_DEBUG, "Converted end time '%s' to UTC '%s'", parse_result->end_str, end_utc);
    } else {
      strncpy(end_utc, parse_result->end_str, sizeof(end_utc) - 1);
      end_utc[sizeof(end_utc) - 1] = '\0';
    }
    snprintf(output, output_size, "%s-%s", begin_utc, end_utc);
  } else if (parse_result->has_range_separator) {
    snprintf(output, output_size, "%s-", begin_utc);
  } else {
    snprintf(output, output_size, "%s", begin_utc);
  }

  logger(LOG_DEBUG, "UTC seek parameter: '%s'", output);
  return 0;
}

int service_format_recent_seek_range(const seek_parse_result_t *parse_result, char *output, size_t output_size) {
  if (!parse_result || !output || output_size == 0)
    return -1;

  output[0] = '\0';

  if (!parse_result->is_recent || !parse_result->begin_parsed)
    return 0;

  if (output_size < 17)
    return -1;

  if (strftime(output, output_size, "%Y%m%dT%H%M%SZ", &parse_result->recent_clock_tm_utc) == 0)
    return -1;

  return 1;
}

int service_resolve_upstream_url(const char *url, const char *seek_param_name, const seek_parse_result_t *parse_result,
                                 char *output, size_t output_size) {
  int has_template;
  seek_parse_result_t empty_parse_result;

  if (!url || !output || output_size == 0)
    return -1;

  has_template = url_template_has_placeholders(url);

  if (!parse_result) {
    memset(&empty_parse_result, 0, sizeof(empty_parse_result));
    parse_result = &empty_parse_result;
  }

  if (!has_template) {
    strncpy(output, url, output_size - 1);
    output[output_size - 1] = '\0';

    if (seek_param_name && parse_result->has_seek && strlen(seek_param_name) > 0) {
      char converted[256];
      if (service_convert_seek_value(parse_result, converted, sizeof(converted)) == 0) {
        size_t current_len = strlen(output);
        char *query_marker = strchr(output, '?');
        size_t remain = output_size - current_len;
        int written =
            snprintf(output + current_len, remain, "%c%s=%s", query_marker ? '&' : '?', seek_param_name, converted);
        if (written < 0 || (size_t)written >= remain) {
          logger(LOG_ERROR, "URL too long to append seek parameter");
          output[current_len] = '\0';
          return -1;
        }
      }
    }
    return 0;
  }

  return url_template_resolve(url, parse_result, output, output_size);
}

/* Merge query strings with override semantics:
 * - For each param name in base: if override has the same name, ALL override
 *   instances replace ALL base instances (emitted at the first base position).
 * - Override params whose name doesn't appear in base are appended.
 * - Multiple same-name params in override are all preserved.
 * base_query and override_query should not include the leading '?'. */
static int merge_query_strings(const char *base_query, const char *override_query, char *output, size_t output_size) {
  if (!output || output_size == 0)
    return -1;

  output[0] = '\0';
  size_t out_pos = 0;

#define MERGE_APPEND_SEP()                                                                                             \
  do {                                                                                                                 \
    if (out_pos > 0) {                                                                                                 \
      if (out_pos + 1 >= output_size)                                                                                  \
        return -1;                                                                                                     \
      output[out_pos++] = '&';                                                                                         \
    }                                                                                                                  \
  } while (0)

#define MERGE_APPEND_PARAM(src, len)                                                                                   \
  do {                                                                                                                 \
    MERGE_APPEND_SEP();                                                                                                \
    if (out_pos + (len) >= output_size)                                                                                \
      return -1;                                                                                                       \
    memcpy(output + out_pos, (src), (len));                                                                            \
    out_pos += (len);                                                                                                  \
  } while (0)

  /* Pass 1: Walk base params. For each param name:
   * - If override has params with the same name AND this is the first
   *   occurrence of this name in base, emit ALL override params with that name.
   * - If override has params with the same name but this is a duplicate
   *   base occurrence, skip it (overrides already emitted).
   * - If override has no param with this name, emit the base param. */
  const char *bp = base_query;
  while (bp && *bp) {
    const char *bamp = strchr(bp, '&');
    size_t bparam_len = bamp ? (size_t)(bamp - bp) : strlen(bp);
    const char *beq = memchr(bp, '=', bparam_len);
    size_t bname_len = beq ? (size_t)(beq - bp) : bparam_len;

    /* Check if override has any param with the same name */
    int overridden = 0;
    const char *op = override_query;
    while (op && *op) {
      const char *oamp = strchr(op, '&');
      size_t oparam_len = oamp ? (size_t)(oamp - op) : strlen(op);
      const char *oeq = memchr(op, '=', oparam_len);
      size_t oname_len = oeq ? (size_t)(oeq - op) : oparam_len;
      (void)oparam_len;

      if (oname_len == bname_len && memcmp(bp, op, bname_len) == 0) {
        overridden = 1;
        break;
      }
      op = oamp ? oamp + 1 : NULL;
    }

    if (overridden) {
      /* Check if this name already appeared earlier in base */
      int first_occurrence = 1;
      const char *prev = base_query;
      while (prev && prev < bp && *prev) {
        const char *pamp = strchr(prev, '&');
        size_t pparam_len = pamp ? (size_t)(pamp - prev) : strlen(prev);
        const char *peq = memchr(prev, '=', pparam_len);
        size_t pname_len = peq ? (size_t)(peq - prev) : pparam_len;

        if (pname_len == bname_len && memcmp(prev, bp, bname_len) == 0) {
          first_occurrence = 0;
          break;
        }
        prev = (pamp && pamp + 1 < bp) ? pamp + 1 : NULL;
      }

      if (first_occurrence) {
        /* Emit ALL override params with this name */
        op = override_query;
        while (op && *op) {
          const char *oamp = strchr(op, '&');
          size_t oparam_len = oamp ? (size_t)(oamp - op) : strlen(op);
          const char *oeq = memchr(op, '=', oparam_len);
          size_t oname_len = oeq ? (size_t)(oeq - op) : oparam_len;

          if (oname_len == bname_len && memcmp(bp, op, bname_len) == 0) {
            MERGE_APPEND_PARAM(op, oparam_len);
          }
          op = oamp ? oamp + 1 : NULL;
        }
      }
      /* else: duplicate base name, skip (overrides already emitted) */
    } else {
      /* Not overridden, keep base param */
      MERGE_APPEND_PARAM(bp, bparam_len);
    }

    bp = bamp ? bamp + 1 : NULL;
  }

  /* Pass 2: Append override params whose name doesn't appear in base */
  const char *op = override_query;
  while (op && *op) {
    const char *oamp = strchr(op, '&');
    size_t oparam_len = oamp ? (size_t)(oamp - op) : strlen(op);
    const char *oeq = memchr(op, '=', oparam_len);
    size_t oname_len = oeq ? (size_t)(oeq - op) : oparam_len;

    int found_in_base = 0;
    const char *bp2 = base_query;
    while (bp2 && *bp2) {
      const char *bamp2 = strchr(bp2, '&');
      size_t bparam_len2 = bamp2 ? (size_t)(bamp2 - bp2) : strlen(bp2);
      const char *beq2 = memchr(bp2, '=', bparam_len2);
      size_t bname_len2 = beq2 ? (size_t)(beq2 - bp2) : bparam_len2;

      if (bname_len2 == oname_len && memcmp(bp2, op, oname_len) == 0) {
        found_in_base = 1;
        break;
      }
      bp2 = bamp2 ? bamp2 + 1 : NULL;
    }

    if (!found_in_base) {
      MERGE_APPEND_PARAM(op, oparam_len);
    }

    op = oamp ? oamp + 1 : NULL;
  }

#undef MERGE_APPEND_PARAM
#undef MERGE_APPEND_SEP

  output[out_pos] = '\0';
  return 0;
}

service_t *service_create_from_http_url(const char *http_url) {
  service_t *result = NULL;
  char working_url[HTTP_URL_BUFFER_SIZE];
  const char *url_part;
  size_t url_len;

  /* Validate input. strnlen + memcpy avoids strncpy's NUL-fill of the rest of
   * the buffer, which is wasteful on the per-request URL parse path. */
  if (!http_url || (url_len = strnlen(http_url, sizeof(working_url))) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long HTTP proxy URL");
    return NULL;
  }
  memcpy(working_url, http_url, url_len + 1);

  /* Check URL format: /http/host:port/path or http://host:port/path */
  if (strncmp(working_url, "/http/", 6) == 0) {
    url_part = working_url + 6;
  } else if (strncmp(working_url, "http://", 7) == 0) {
    url_part = working_url + 7;
  } else {
    logger(LOG_ERROR,
           "Invalid HTTP proxy URL format (must start with /http/ "
           "or http://): %s",
           http_url);
    return NULL;
  }

  /* Validate that we have at least a host */
  if (!url_part || url_part[0] == '\0' || url_part[0] == '/') {
    logger(LOG_ERROR, "HTTP proxy URL missing host: %s", http_url);
    return NULL;
  }

  /* Allocate and initialize service */
  result = calloc(1, sizeof(service_t));
  if (!result) {
    logger(LOG_ERROR, "Failed to allocate service for HTTP proxy");
    return NULL;
  }

  result->service_type = SERVICE_HTTP;
  result->source = SERVICE_SOURCE_INLINE;

  /* Store the original URL */
  result->url = strdup(http_url);
  if (!result->url) {
    logger(LOG_ERROR, "Failed to duplicate URL for HTTP proxy service");
    free(result);
    return NULL;
  }

  /* Build full HTTP URL: http://host:port/path */
  /* Use larger buffer to accommodate "http://" prefix + url_part */
  char full_url[HTTP_URL_BUFFER_SIZE + 8];
  snprintf(full_url, sizeof(full_url), "http://%s", url_part);
  result->http_url = strdup(full_url);
  if (!result->http_url) {
    logger(LOG_ERROR, "Failed to duplicate HTTP URL for service");
    free(result->url);
    free(result);
    return NULL;
  }

  /* Extract r2h-* parameters from HTTP URL (removes in-place) */
  char *query_start = strchr(result->http_url, '?');
  if (query_start) {
    service_extract_seek_params(query_start, &result->seek_param_name, &result->seek_param_value,
                                &result->seek_offset_seconds, &result->seek_mode, &result->seek_mode_tz_explicit,
                                &result->seek_mode_tz_offset_seconds, &result->seek_mode_window_seconds);
    service_extract_ifname_params(query_start, &result->ifname, &result->ifname_fcc);
  }

  logger(LOG_DEBUG, "Created HTTP proxy service: %s -> %s", http_url, result->http_url);
  if (result->seek_param_value) {
    logger(LOG_DEBUG, "HTTP: Extracted %s parameter: %s", result->seek_param_name ? result->seek_param_name : "seek",
           result->seek_param_value);
  }

  return result;
}

service_t *service_create_from_udpxy_url(char *url) {
  char working_url[HTTP_URL_BUFFER_SIZE];
  size_t url_len;

  /* Validate input */
  if (!url || (url_len = strnlen(url, sizeof(working_url))) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long URL");
    return NULL;
  }
  memcpy(working_url, url, url_len + 1);

  /* Determine service type and delegate to appropriate function */
  if (strncmp(working_url, "/rtp/", 5) == 0 || strncmp(working_url, "/udp/", 5) == 0) {
    /* RTP/UDP service - service_create_from_rtp_url handles both */
    return service_create_from_rtp_url(url);
  } else if (strncmp(working_url, "/rtsp/", 6) == 0) {
    /* RTSP service - use service_create_from_rtsp_url */
    return service_create_from_rtsp_url(url);
  } else if (strncmp(working_url, "/http/", 6) == 0) {
    /* HTTP proxy service - use service_create_from_http_url */
    return service_create_from_http_url(url);
  } else {
    logger(LOG_DEBUG,
           "Invalid URL format (must start with /rtp/, /udp/, /rtsp/, or "
           "/http/): %s",
           url);
    return NULL;
  }
}
service_t *service_create_from_rtsp_url(const char *http_url) {
  service_t *result = NULL;
  char working_url[HTTP_URL_BUFFER_SIZE];
  char *url_part;
  char *query_start;
  char rtsp_url[HTTP_URL_BUFFER_SIZE];
  char *seek_param_name = NULL;
  char *seek_param_value = NULL;
  int seek_offset_seconds = 0;
  seek_mode_t seek_mode = SEEK_MODE_PASSTHROUGH;
  int seek_mode_tz_explicit = 0;
  int seek_mode_tz_offset_seconds = 0;
  int seek_mode_window_seconds = SEEK_MODE_DEFAULT_WINDOW_SECONDS;

  /* Validate input */
  size_t url_len;
  if (!http_url || (url_len = strnlen(http_url, sizeof(working_url))) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long RTSP URL");
    return NULL;
  }
  memcpy(working_url, http_url, url_len + 1);

  /* Check if URL starts with rtsp:// or /rtsp/ and extract the part after
   * prefix */
  if (strncmp(working_url, "rtsp://", 7) == 0) {
    url_part = working_url + 7;
  } else if (strncmp(working_url, "/rtsp/", 6) == 0) {
    url_part = working_url + 6;
  } else {
    logger(LOG_ERROR, "Invalid RTSP URL format (must start with rtsp:// or /rtsp/)");
    return NULL;
  }

  if (strlen(url_part) == 0) {
    logger(LOG_ERROR, "RTSP URL part is empty");
    return NULL;
  }

  /* Extract r2h-* parameters from query string (modifies url_part in-place) */
  char *ifname = NULL, *ifname_fcc = NULL;
  query_start = strchr(url_part, '?');
  if (query_start) {
    if (service_extract_seek_params(query_start, &seek_param_name, &seek_param_value, &seek_offset_seconds, &seek_mode,
                                    &seek_mode_tz_explicit, &seek_mode_tz_offset_seconds,
                                    &seek_mode_window_seconds) < 0) {
      return NULL;
    }
    service_extract_ifname_params(query_start, &ifname, &ifname_fcc);
  }

  /* Allocate service structure */
  result = calloc(1, sizeof(service_t));
  if (!result) {
    logger(LOG_ERROR, "Failed to allocate memory for RTSP service");
    goto cleanup;
  }

  result->service_type = SERVICE_RTSP;
  result->ifname = ifname;
  result->ifname_fcc = ifname_fcc;
  ifname = NULL;     /* Transfer ownership */
  ifname_fcc = NULL; /* Transfer ownership */

  /* Build full RTSP URL */
  if (strlen(url_part) + 7 >= sizeof(rtsp_url)) {
    logger(LOG_ERROR, "RTSP URL too long: %zu bytes", strlen(url_part) + 7);
    goto cleanup;
  }
  snprintf(rtsp_url, sizeof(rtsp_url), "rtsp://%s", url_part);

  /* Store RTSP URL and seek parameters */
  result->rtsp_url = strdup(rtsp_url);
  if (!result->rtsp_url) {
    logger(LOG_ERROR, "Failed to allocate memory for RTSP URL");
    goto cleanup;
  }

  result->seek_param_name = seek_param_name;
  seek_param_name = NULL; /* Transfer ownership */
  result->seek_param_value = seek_param_value;
  seek_param_value = NULL; /* Transfer ownership */
  result->seek_offset_seconds = seek_offset_seconds;
  result->seek_mode = seek_mode;
  result->seek_mode_tz_explicit = seek_mode_tz_explicit;
  result->seek_mode_tz_offset_seconds = seek_mode_tz_offset_seconds;
  result->seek_mode_window_seconds = seek_mode_window_seconds;

  result->url = strdup(http_url);
  if (!result->url) {
    logger(LOG_ERROR, "Failed to allocate memory for HTTP URL");
    goto cleanup;
  }

  logger(LOG_DEBUG, "Parsed RTSP URL: %s", result->rtsp_url);
  if (result->seek_param_value) {
    logger(LOG_DEBUG, "Parsed %s parameter: %s", result->seek_param_name ? result->seek_param_name : "seek",
           result->seek_param_value);
  }

  return result;

cleanup:
  if (seek_param_name)
    free(seek_param_name);
  if (seek_param_value)
    free(seek_param_value);
  if (ifname)
    free(ifname);
  if (ifname_fcc)
    free(ifname_fcc);

  if (result) {
    service_free(result);
  }

  return NULL;
}

service_t *service_create_with_query_merge(service_t *configured_service, const char *request_url,
                                           service_type_t expected_type) {
  char merged_url[HTTP_URL_BUFFER_SIZE];
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
    type_name = (expected_type == SERVICE_RTSP) ? "RTSP" : (expected_type == SERVICE_HTTP) ? "HTTP" : "RTP";
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
  } else if (expected_type == SERVICE_HTTP) {
    if (!configured_service->http_url) {
      logger(LOG_ERROR, "Configured HTTP service has no http_url");
      return NULL;
    }
    base_url = configured_service->http_url;
    type_name = "HTTP";
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
    /* No request query params: nothing to merge, just hand back a fresh clone
     * of the configured service. We deliberately do NOT use NULL as the "no
     * merge needed" sentinel — NULL is reserved strictly for failures (e.g.
     * merged URL too long for HTTP_URL_BUFFER_SIZE). Otherwise the caller
     * cannot tell apart "user sent no params" from "user's params were
     * silently discarded by an overflow", and the latter would let long
     * requests behave as if the client never sent its overrides. */
    return service_clone(configured_service);
  }

  /* Find query parameters in configured service's URL */
  existing_query = strchr(base_url, '?');

  if (existing_query) {
    /* Service URL already has query params - merge with override semantics */
    size_t base_len = (size_t)(existing_query - base_url);
    if (base_len >= sizeof(merged_url)) {
      logger(LOG_ERROR, "%s URL too long for merging", type_name);
      return NULL;
    }

    /* Copy base URL (without query) and add '?' */
    memcpy(merged_url, base_url, base_len);
    merged_url[base_len] = '?';

    /* Merge query strings: override params replace same-name base params */
    if (merge_query_strings(existing_query + 1, query_start + 1, merged_url + base_len + 1,
                            sizeof(merged_url) - base_len - 1) < 0) {
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

  /* For every internal r2h-* control parameter, the request takes precedence
   * over the M3U-configured value. The request's copy (if any) is already in
   * merged_url after merge_query_strings, so we only append the configured
   * fallback when the request didn't supply that param. Re-parsing the merged
   * URL via service_create_from_*_url strips r2h-* before the upstream URI is
   * emitted, so neither side leaks. */

  if (configured_service->seek_param_name && !request_query_has(query_start, "r2h-seek-name")) {
    char seek_name_param[256];
    const char *separator = strchr(merged_url, '?') ? "&" : "?";
    snprintf(seek_name_param, sizeof(seek_name_param), "%sr2h-seek-name=%s", separator,
             configured_service->seek_param_name);
    if (strlen(merged_url) + strlen(seek_name_param) < sizeof(merged_url)) {
      strcat(merged_url, seek_name_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-seek-name too long", type_name);
      return NULL;
    }
  }

  if (configured_service->seek_offset_seconds != 0 && !request_query_has(query_start, "r2h-seek-offset")) {
    char seek_offset_param[64];
    const char *separator = strchr(merged_url, '?') ? "&" : "?";
    snprintf(seek_offset_param, sizeof(seek_offset_param), "%sr2h-seek-offset=%d", separator,
             configured_service->seek_offset_seconds);
    if (strlen(merged_url) + strlen(seek_offset_param) < sizeof(merged_url)) {
      strcat(merged_url, seek_offset_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-seek-offset too long", type_name);
      return NULL;
    }
  }

  if (configured_service->seek_mode == SEEK_MODE_RANGE && !request_query_has(query_start, "r2h-seek-mode")) {
    char seek_mode_param[96];
    const char *separator = strchr(merged_url, '?') ? "&" : "?";
    if (configured_service->seek_mode_tz_explicit) {
      int tz_hours = configured_service->seek_mode_tz_offset_seconds / 3600;
      snprintf(seek_mode_param, sizeof(seek_mode_param), "%sr2h-seek-mode=range(UTC%+d/%d)", separator, tz_hours,
               configured_service->seek_mode_window_seconds);
    } else {
      snprintf(seek_mode_param, sizeof(seek_mode_param), "%sr2h-seek-mode=range(/%d)", separator,
               configured_service->seek_mode_window_seconds);
    }
    if (strlen(merged_url) + strlen(seek_mode_param) < sizeof(merged_url)) {
      strcat(merged_url, seek_mode_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-seek-mode too long", type_name);
      return NULL;
    }
  }

  if (configured_service->ifname && !request_query_has(query_start, "r2h-ifname")) {
    char ifname_param[IFNAMSIZ + 16];
    const char *separator = strchr(merged_url, '?') ? "&" : "?";
    snprintf(ifname_param, sizeof(ifname_param), "%sr2h-ifname=%s", separator, configured_service->ifname);
    if (strlen(merged_url) + strlen(ifname_param) < sizeof(merged_url)) {
      strcat(merged_url, ifname_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-ifname too long", type_name);
      return NULL;
    }
  }

  if (configured_service->ifname_fcc && !request_query_has(query_start, "r2h-ifname-fcc")) {
    char ifname_fcc_param[IFNAMSIZ + 20];
    const char *separator = strchr(merged_url, '?') ? "&" : "?";
    snprintf(ifname_fcc_param, sizeof(ifname_fcc_param), "%sr2h-ifname-fcc=%s", separator,
             configured_service->ifname_fcc);
    if (strlen(merged_url) + strlen(ifname_fcc_param) < sizeof(merged_url)) {
      strcat(merged_url, ifname_fcc_param);
    } else {
      logger(LOG_ERROR, "Merged %s URL with r2h-ifname-fcc too long", type_name);
      return NULL;
    }
  }

  /* Create new service from merged URL */
  logger(LOG_DEBUG, "Creating %s service with merged URL: %s", type_name, merged_url);

  if (expected_type == SERVICE_RTSP) {
    return service_create_from_rtsp_url(merged_url);
  } else if (expected_type == SERVICE_HTTP) {
    return service_create_from_http_url(merged_url);
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
  struct sockaddr_storage *res_addr = NULL, *msrc_res_addr = NULL, *fcc_res_addr = NULL;
  struct addrinfo *res_ai = NULL, *msrc_res_ai = NULL, *fcc_res_ai = NULL;
  int r = 0, rr = 0, rrr = 0;

  /* Validate input */
  size_t url_len;
  if (!http_url || (url_len = strnlen(http_url, sizeof(working_url))) >= sizeof(working_url)) {
    logger(LOG_ERROR, "Invalid or too long RTP URL");
    return NULL;
  }
  memcpy(working_url, http_url, url_len + 1);

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

  /* Extract r2h-ifname and r2h-ifname-fcc before storing URL (removes
   * in-place) */
  {
    char *qstart = strchr(url_part, '?');
    service_extract_ifname_params(qstart, &result->ifname, &result->ifname_fcc);
  }

  /* Build and store full RTP URL (rtp://) - r2h-ifname already stripped */
  char rtp_url[HTTP_URL_BUFFER_SIZE];
  if (strlen(url_part) + 6 >= sizeof(rtp_url)) {
    logger(LOG_ERROR, "RTP URL too long: %zu bytes", strlen(url_part) + 6);
    service_free(result);
    return NULL;
  }
  snprintf(rtp_url, sizeof(rtp_url), "rtp://%s", url_part);
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

  logger(LOG_DEBUG, "Parsed RTP URL: mcast=%s:%s", components.multicast_addr, components.multicast_port);
  if (components.has_source) {
    logger(LOG_DEBUG, " src=%s:%s", components.source_addr, components.source_port);
  }
  if (components.has_fcc) {
    logger(LOG_DEBUG, " fcc=%s:%s", components.fcc_addr, components.fcc_port);
  }
  if (components.fec_port > 0) {
    logger(LOG_DEBUG, " fec_port=%u", components.fec_port);
  }

  /* Resolve addresses */
  memset(&hints, 0, sizeof(hints));
  hints.ai_socktype = SOCK_DGRAM;

  /* Resolve multicast address */
  r = getaddrinfo(components.multicast_addr, components.multicast_port, &hints, &res);
  if (r != 0) {
    logger(LOG_ERROR, "Cannot resolve multicast address %s:%s. GAI: %s", components.multicast_addr,
           components.multicast_port, gai_strerror(r));
    service_free(result);
    return NULL;
  }

  /* Resolve source address if present */
  if (components.has_source) {
    const char *src_port = components.source_port[0] ? components.source_port : NULL;
    rr = getaddrinfo(components.source_addr, src_port, &hints, &msrc_res);
    if (rr != 0) {
      logger(LOG_ERROR, "Cannot resolve source address %s. GAI: %s", components.source_addr, gai_strerror(rr));
      freeaddrinfo(res);
      service_free(result);
      return NULL;
    }
  }

  /* Resolve FCC address if present */
  if (components.has_fcc) {
    const char *fcc_port = components.fcc_port[0] ? components.fcc_port : NULL;
    rrr = getaddrinfo(components.fcc_addr, fcc_port, &hints, &fcc_res);
    if (rrr != 0) {
      logger(LOG_ERROR, "Cannot resolve FCC address %s. GAI: %s", components.fcc_addr, gai_strerror(rrr));
      freeaddrinfo(res);
      if (msrc_res)
        freeaddrinfo(msrc_res);
      service_free(result);
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
    service_free(result);
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
      logger(LOG_ERROR, "Failed to allocate memory for source address structures");
      freeaddrinfo(res);
      freeaddrinfo(msrc_res);
      if (fcc_res)
        freeaddrinfo(fcc_res);
      free(msrc_res_addr);
      free(msrc_res_ai);
      service_free(result);
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
      snprintf(source_str, sizeof(source_str), "%s:%s", components.source_addr, components.source_port);
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
      service_free(result);
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
      service_free(result);
      return NULL;
    }
  }

  /* Set up FCC address */
  result->fcc_addr = NULL;
  result->fcc_type = components.fcc_type;
  result->fec_port = components.fec_port;
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
      service_free(result);
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
      logger(LOG_DEBUG, "FCC type explicitly set to %s", result->fcc_type == FCC_TYPE_HUAWEI ? "Huawei" : "Telecom");
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
  cloned->fec_port = service->fec_port;

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

  if (service->http_url) {
    cloned->http_url = strdup(service->http_url);
    if (!cloned->http_url) {
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

  cloned->seek_offset_seconds = service->seek_offset_seconds;
  cloned->seek_mode = service->seek_mode;
  cloned->seek_mode_tz_explicit = service->seek_mode_tz_explicit;
  cloned->seek_mode_tz_offset_seconds = service->seek_mode_tz_offset_seconds;
  cloned->seek_mode_window_seconds = service->seek_mode_window_seconds;

  if (service->user_agent) {
    cloned->user_agent = strdup(service->user_agent);
    if (!cloned->user_agent) {
      goto cleanup_error;
    }
  }

  if (service->ifname) {
    cloned->ifname = strdup(service->ifname);
    if (!cloned->ifname) {
      goto cleanup_error;
    }
  }

  if (service->ifname_fcc) {
    cloned->ifname_fcc = strdup(service->ifname_fcc);
    if (!cloned->ifname_fcc) {
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
  }

  /* Free HTTP-specific fields */
  if (service->service_type == SERVICE_HTTP) {
    if (service->http_url) {
      free(service->http_url);
      service->http_url = NULL;
    }
  }

  /* Free fields shared across service types */
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

  if (service->ifname) {
    free(service->ifname);
    service->ifname = NULL;
  }

  if (service->ifname_fcc) {
    free(service->ifname_fcc);
    service->ifname_fcc = NULL;
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

void service_free_all(void) {
  service_t *current;
  int freed_count = 0;

  /* Free hashmap */
  service_hashmap_free();

  /* Free all services */
  while (services != NULL) {
    current = services;
    services = current->next;
    service_free(current);
    freed_count++;
  }

  logger(LOG_INFO, "Freed %d services (all)", freed_count);
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
  service_map = hashmap_new(sizeof(service_t *), 64, 0, 0, service_hash, service_compare, NULL, NULL);

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
    logger(LOG_ERROR, "Out of memory when adding service to hashmap: %s", service->url);
  } else if (old != NULL) {
    logger(LOG_WARN, "Service URL already exists in hashmap (replaced): %s", service->url);
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
  key_service.url = (char *)(uintptr_t)url; /* Cast via uintptr_t to avoid warning */

  /* Pass pointer to the key service pointer (service_t**) */
  service_t *key_ptr = &key_service;
  const void *result = hashmap_get(service_map, &key_ptr);

  if (result == NULL) {
    return NULL;
  }

  return *(service_t *const *)result;
}

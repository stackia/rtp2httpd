#include "configuration.h"
#include "connection.h"
#include "embedded_web_data.h"
#include "hashmap.h"
#include "http.h"
#include "utils.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* Static hashmap for O(1) embedded file lookup */
static struct hashmap *embedded_files_map = NULL;

/**
 * Hash function for embedded file paths
 */
static uint64_t hash_path(const void *item, uint64_t seed0, uint64_t seed1) {
  const embedded_file_t *file = item;
  return hashmap_xxhash3(file->path, strlen(file->path), seed0, seed1);
}

/**
 * Compare function for embedded file paths
 */
static int compare_paths(const void *a, const void *b, void *udata) {
  const embedded_file_t *fa = a;
  const embedded_file_t *fb = b;
  (void)udata; /* unused */
  return strcmp(fa->path, fb->path);
}

/**
 * Initialize the embedded files hashmap (lazy initialization)
 */
static void init_embedded_files_map(void) {
  if (embedded_files_map)
    return;

  /* Create hashmap with initial capacity set to number of embedded files */
  embedded_files_map = hashmap_new(sizeof(embedded_file_t), /* element size */
                                   EMBEDDED_FILES_COUNT,    /* initial capacity */
                                   0, 0,                    /* seeds (use default) */
                                   hash_path,               /* hash function */
                                   compare_paths,           /* compare function */
                                   NULL,                    /* no element free function (static data) */
                                   NULL                     /* no udata */
  );

  if (!embedded_files_map) {
    logger(LOG_ERROR, "Failed to create embedded files hashmap");
    return;
  }

  /* Insert all embedded files into hashmap */
  for (size_t i = 0; i < EMBEDDED_FILES_COUNT; i++) {
    hashmap_set(embedded_files_map, &embedded_files[i]);
  }

  logger(LOG_DEBUG, "Initialized embedded files hashmap with %d files", EMBEDDED_FILES_COUNT);
}

/**
 * Find an embedded file by path (O(1) lookup using hashmap)
 * Internal function - not exposed in header
 * @param path The requested path (e.g., "/status.html")
 * @return Pointer to embedded_file_t or NULL if not found
 */
static const embedded_file_t *find_embedded_file(const char *path) {
  if (!path)
    return NULL;

  /* Lazy initialization of hashmap */
  if (!embedded_files_map) {
    init_embedded_files_map();
    if (!embedded_files_map)
      return NULL; /* Initialization failed */
  }

  /* Create temporary key for lookup */
  embedded_file_t key = {.path = path};

  /* O(1) hashmap lookup */
  return hashmap_get(embedded_files_map, &key);
}

/* Configuration parsing normalizes the prefix to empty or /prefix (no trailing slash), and page paths to /path
 * (no trailing slash) or /. Concatenating those normalized forms therefore also handles root pages correctly. */
static char *build_public_path(const char *page_path) {
  const char *prefix = (config.app_path_prefix && config.app_path_prefix[0] != '\0') ? config.app_path_prefix : "";
  const char *path = (page_path && page_path[0] != '\0') ? page_path : "/";
  size_t prefix_len = strlen(prefix);
  size_t path_len = strlen(path);
  size_t result_len = prefix_len + path_len;
  char *result;

  if (result_len >= HTTP_URL_BUFFER_SIZE)
    return NULL;

  result = malloc(result_len + 1);
  if (!result)
    return NULL;

  snprintf(result, result_len + 1, "%s%s", prefix, path);
  return result;
}

static char *build_manifest_start_url(const char *page_path) {
  char *public_path = build_public_path(page_path);
  char *encoded_token = NULL;
  char *start_url = NULL;
  size_t start_url_len;

  if (!public_path)
    return NULL;

  if (!config.r2h_token || config.r2h_token[0] == '\0')
    return public_path;

  encoded_token = http_url_encode(config.r2h_token);
  if (!encoded_token) {
    free(public_path);
    return NULL;
  }

  start_url_len = strlen(public_path) + strlen("?r2h-token=") + strlen(encoded_token);
  if (start_url_len >= HTTP_URL_BUFFER_SIZE) {
    free(encoded_token);
    free(public_path);
    return NULL;
  }

  start_url = malloc(start_url_len + 1);
  if (start_url)
    snprintf(start_url, start_url_len + 1, "%s?r2h-token=%s", public_path, encoded_token);

  free(encoded_token);
  free(public_path);
  return start_url;
}

static int format_web_app_manifest(char *buffer, size_t buffer_size, const char *name, const char *short_name,
                                   const char *english_name, const char *english_short_name, const char *public_path,
                                   const char *start_url, const char *theme_color, const char *background_color,
                                   const char *icon_192_path, const char *icon_512_path) {
  return snprintf(buffer, buffer_size,
                  "{\n"
                  "  \"lang\": \"zh-Hans\",\n"
                  "  \"dir\": \"ltr\",\n"
                  "  \"name\": \"%s\",\n"
                  "  \"short_name\": \"%s\",\n"
                  "  \"name_localized\": {\n"
                  "    \"zh-Hans\": \"%s\",\n"
                  "    \"zh-Hant\": \"%s\",\n"
                  "    \"en\": \"%s\"\n"
                  "  },\n"
                  "  \"short_name_localized\": {\n"
                  "    \"zh-Hans\": \"%s\",\n"
                  "    \"zh-Hant\": \"%s\",\n"
                  "    \"en\": \"%s\"\n"
                  "  },\n"
                  "  \"id\": \"%s\",\n"
                  "  \"scope\": \"%s\",\n"
                  "  \"start_url\": \"%s\",\n"
                  "  \"display\": \"standalone\",\n"
                  "  \"theme_color\": \"%s\",\n"
                  "  \"background_color\": \"%s\",\n"
                  "  \"icons\": [\n"
                  "    {\"src\": \"%s\", \"sizes\": \"192x192\", \"type\": \"image/png\"},\n"
                  "    {\"src\": \"%s\", \"sizes\": \"512x512\", \"type\": \"image/png\"}\n"
                  "  ]\n"
                  "}\n",
                  name, short_name, name, name, english_name, short_name, short_name, english_short_name, public_path,
                  public_path, start_url, theme_color, background_color, icon_192_path, icon_512_path);
}

void handle_web_app_manifest(connection_t *c, bool player_page) {
  const char *page_path = player_page ? config.player_page_path : config.status_page_path;
  /* JSON Unicode escapes preserve an ASCII-only payload template: \u64ad\u653e\u5668 is "播放器" and
   * \u9762\u677f is "面板". */
  const char *name = player_page ? "rtp2httpd \\u64ad\\u653e\\u5668" : "rtp2httpd \\u9762\\u677f";
  const char *short_name = player_page ? "R2H \\u64ad\\u653e\\u5668" : "R2H \\u9762\\u677f";
  const char *english_name = player_page ? "rtp2httpd Player" : "rtp2httpd Status";
  const char *english_short_name = player_page ? "R2H Player" : "R2H Status";
  /* Manifest colors cannot vary with prefers-color-scheme. Use each page's dark background for both fields to keep
   * the installed-app splash and browser chrome consistent and avoid a bright flash during launch. */
  const char *theme_color = player_page ? "#050b18" : "#090b1a";
  const char *background_color = theme_color;
  char *public_path = NULL;
  char *start_url = NULL;
  char *icon_192_path = NULL;
  char *icon_512_path = NULL;
  char *escaped_public_path = NULL;
  char *escaped_start_url = NULL;
  char *escaped_icon_192_path = NULL;
  char *escaped_icon_512_path = NULL;
  char *manifest = NULL;
  char extra_headers[256];
  int manifest_len;

  if (!c)
    return;

  public_path = build_public_path(page_path);
  start_url = build_manifest_start_url(page_path);
  icon_192_path = build_public_path("/assets/icon-192.png");
  icon_512_path = build_public_path("/assets/icon-512.png");
  if (!public_path || !start_url || !icon_192_path || !icon_512_path)
    goto error;

  escaped_public_path = json_escape_string(public_path);
  escaped_start_url = json_escape_string(start_url);
  escaped_icon_192_path = json_escape_string(icon_192_path);
  escaped_icon_512_path = json_escape_string(icon_512_path);
  if (!escaped_public_path || !escaped_start_url || !escaped_icon_192_path || !escaped_icon_512_path)
    goto error;

  manifest_len = format_web_app_manifest(NULL, 0, name, short_name, english_name, english_short_name,
                                         escaped_public_path, escaped_start_url, theme_color, background_color,
                                         escaped_icon_192_path, escaped_icon_512_path);
  if (manifest_len < 0)
    goto error;

  manifest = malloc((size_t)manifest_len + 1);
  if (!manifest)
    goto error;

  if (format_web_app_manifest(manifest, (size_t)manifest_len + 1, name, short_name, english_name, english_short_name,
                              escaped_public_path, escaped_start_url, theme_color, background_color,
                              escaped_icon_192_path, escaped_icon_512_path) != manifest_len)
    goto error;

  snprintf(extra_headers, sizeof(extra_headers),
           "Content-Length: %d\r\n"
           "Cache-Control: no-cache\r\n",
           manifest_len);
  send_http_headers(c, STATUS_200, "application/manifest+json; charset=utf-8", extra_headers);
  connection_queue_output_and_flush(c, (const uint8_t *)manifest, (size_t)manifest_len);

  free(manifest);
  free(escaped_icon_512_path);
  free(escaped_icon_192_path);
  free(escaped_start_url);
  free(escaped_public_path);
  free(icon_512_path);
  free(icon_192_path);
  free(start_url);
  free(public_path);
  return;

error:
  free(manifest);
  free(escaped_icon_512_path);
  free(escaped_icon_192_path);
  free(escaped_start_url);
  free(escaped_public_path);
  free(icon_512_path);
  free(icon_192_path);
  free(start_url);
  free(public_path);
  http_send_500(c);
}

static size_t html_attr_escaped_len(const char *value) {
  size_t len = 0;

  if (!value)
    return 0;

  for (const char *p = value; *p; p++) {
    switch (*p) {
    case '"':
      len += 6;
      break;
    case '&':
    case '\'':
      len += 5;
      break;
    case '<':
    case '>':
      len += 4;
      break;
    default:
      len++;
      break;
    }
  }

  return len;
}

static char *html_attr_escape_string(const char *value) {
  size_t len = html_attr_escaped_len(value);
  char *result = malloc(len + 1);
  char *out = result;

  if (!result)
    return NULL;

  for (const char *p = value; value && *p; p++) {
    switch (*p) {
    case '"':
      memcpy(out, "&quot;", 6);
      out += 6;
      break;
    case '&':
      memcpy(out, "&amp;", 5);
      out += 5;
      break;
    case '\'':
      memcpy(out, "&#39;", 5);
      out += 5;
      break;
    case '<':
      memcpy(out, "&lt;", 4);
      out += 4;
      break;
    case '>':
      memcpy(out, "&gt;", 4);
      out += 4;
      break;
    default:
      *out++ = *p;
      break;
    }
  }
  *out = '\0';

  return result;
}

static int handle_embedded_html(connection_t *c, const embedded_file_t *file) {
  const char *prefix = (config.app_path_prefix && config.app_path_prefix[0] != '\0') ? config.app_path_prefix : "";
  char *base_href = NULL;
  char *escaped_prefix = json_escape_string(prefix);
  char *escaped_base_href = NULL;
  char *html = NULL;
  char *output = NULL;
  char *head = NULL;
  char *injection = NULL;
  char extra_headers[256];
  size_t injection_size;
  int injection_len;

  if (!escaped_prefix) {
    http_send_500(c);
    return -1;
  }

  base_href = malloc(strlen(prefix) + 2);
  if (!base_href) {
    free(escaped_prefix);
    http_send_500(c);
    return -1;
  }
  snprintf(base_href, strlen(prefix) + 2, "%s%s", prefix[0] ? prefix : "/", prefix[0] ? "/" : "");
  escaped_base_href = html_attr_escape_string(base_href);
  free(base_href);
  if (!escaped_base_href) {
    free(escaped_prefix);
    http_send_500(c);
    return -1;
  }

  injection_size = strlen(escaped_base_href) + strlen(escaped_prefix) + 160;
  injection = malloc(injection_size);
  if (!injection) {
    free(escaped_base_href);
    free(escaped_prefix);
    http_send_500(c);
    return -1;
  }

  injection_len = snprintf(injection, injection_size,
                           "<base href=\"%s\">\n"
                           "<script>window.__RTP2HTTPD_CONFIG__={\"appPathPrefix\":\"%s\",\"logLevel\":%d};</script>\n",
                           escaped_base_href, escaped_prefix, config.verbosity);
  free(escaped_base_href);
  free(escaped_prefix);

  if (injection_len < 0 || (size_t)injection_len >= injection_size) {
    free(injection);
    http_send_500(c);
    return -1;
  }

  html = malloc(file->size + 1);
  if (!html) {
    free(injection);
    http_send_500(c);
    return -1;
  }
  memcpy(html, file->data, file->size);
  html[file->size] = '\0';

  head = strstr(html, "<head>");
  size_t prefix_len = head ? (size_t)(head + strlen("<head>") - html) : 0;
  size_t output_size = file->size + (size_t)injection_len;

  output = malloc(output_size);
  if (!output) {
    free(injection);
    free(html);
    http_send_500(c);
    return -1;
  }

  memcpy(output, html, prefix_len);
  memcpy(output + prefix_len, injection, (size_t)injection_len);
  memcpy(output + prefix_len + (size_t)injection_len, html + prefix_len, file->size - prefix_len);

  snprintf(extra_headers, sizeof(extra_headers),
           "Content-Length: %zu\r\n"
           "Cache-Control: no-cache\r\n",
           output_size);
  send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
  connection_queue_output_and_flush(c, (const uint8_t *)output, output_size);

  free(output);
  free(injection);
  free(html);
  return 0;
}

/**
 * Handle embedded static file request
 * @param c The connection
 * @param path The requested path
 */
void handle_embedded_file(connection_t *c, const char *path) {
  if (!c || !path)
    return;

  const embedded_file_t *file = find_embedded_file(path);
  if (!file) {
    http_send_404(c);
    return;
  }

  char extra_headers[512];

  if (!file->gzip_encoded && strncasecmp(file->mime_type, "text/html", 9) == 0) {
    handle_embedded_html(c, file);
    return;
  }

  /* Apply different caching strategies based on whether filename has hash */
  if (file->has_hash) {
    /* Hashed files: use immutable long-term caching */
    snprintf(extra_headers, sizeof(extra_headers),
             "%sContent-Length: %zu\r\n"
             "Cache-Control: public, max-age=31536000, immutable\r\n",
             file->gzip_encoded ? "Content-Encoding: gzip\r\n" : "", file->size);

    send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
    connection_queue_output_and_flush(c, file->data, file->size);
  } else {
    /* Non-hashed files (e.g., HTML): use ETag-based negotiation caching */

    /* Check ETag and send 304 if it matches */
    if (http_check_etag_and_send_304(c, file->etag, file->mime_type)) {
      return;
    }

    /* Send file with ETag for future cache validation */
    http_build_etag_headers(extra_headers, sizeof(extra_headers), file->size, file->etag,
                            file->gzip_encoded ? "Content-Encoding: gzip" : NULL);

    send_http_headers(c, STATUS_200, file->mime_type, extra_headers);
    connection_queue_output_and_flush(c, file->data, file->size);
  }
}

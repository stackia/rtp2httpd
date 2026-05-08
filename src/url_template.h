#ifndef __URL_TEMPLATE_H__
#define __URL_TEMPLATE_H__

#include <stddef.h>
#include <time.h>

typedef struct seek_parse_result_s {
  int has_seek;
  int has_range_separator;
  int has_begin;
  int has_end;
  int begin_parsed;
  int end_parsed;
  int tz_offset_seconds;
  int seek_offset_seconds;
  int is_recent;
  time_t now_utc;
  time_t begin_utc;
  time_t end_utc;
  struct tm begin_tm_utc;
  struct tm end_tm_utc;
  struct tm begin_tm_local;
  struct tm end_tm_local;
  /* Begin time for the RTSP recent-clock path. Populated only when is_recent.
   * Kept separate from begin_tm_utc so that an explicit r2h-seek-mode TZ
   * override does not pollute the URL-template / passthrough begin_tm_utc
   * shared with the HTTP proxy path. */
  struct tm recent_clock_tm_utc;
  char begin_str[128];
  char end_str[128];
} seek_parse_result_t;

#ifndef URL_TEMPLATE_FRAGMENT_SIZE
#define URL_TEMPLATE_FRAGMENT_SIZE 2048
#endif

struct url_template_analysis_s {
  int has_template;
  int needs_begin;
  int needs_end;
  char begin_template[URL_TEMPLATE_FRAGMENT_SIZE];
  char end_template[URL_TEMPLATE_FRAGMENT_SIZE];
  char seek_param_name[128];
};

typedef struct url_template_analysis_s url_template_analysis_t;

int url_template_analyze(const char *url, url_template_analysis_t *analysis);

int url_template_has_placeholders(const char *url);

int url_template_resolve(const char *url, const seek_parse_result_t *parse_result, char *output, size_t output_size);

#endif

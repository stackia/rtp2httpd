#ifndef __URL_TEMPLATE_H__
#define __URL_TEMPLATE_H__

#include <stddef.h>

#ifndef URL_TEMPLATE_FRAGMENT_SIZE
#define URL_TEMPLATE_FRAGMENT_SIZE 2048
#endif

struct url_template_analysis_s {
  int has_template;
  int needs_begin;
  int needs_end;
  char begin_template[URL_TEMPLATE_FRAGMENT_SIZE];
  char end_template[URL_TEMPLATE_FRAGMENT_SIZE];
};

typedef struct url_template_analysis_s url_template_analysis_t;

int url_template_analyze(const char *url, url_template_analysis_t *analysis);

int url_template_has_placeholders(const char *url);

int url_template_resolve(const char *url, const char *seek_param_value,
                         int tz_offset_seconds, int seek_offset_seconds,
                         char *output, size_t output_size);

#endif

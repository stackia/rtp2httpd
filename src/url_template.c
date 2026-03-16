#include "url_template.h"
#include "timezone.h"
#include "utils.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
  const char *long_name;
  const char *short_name;
} time_component_def_t;

static const time_component_def_t time_components[] = {{"yyyy", "Y"}, {"MM", "m"}, {"dd", "d"}, {"HH", "H"},
                                                       {"mm", "M"},   {"ss", "S"}, {NULL, NULL}};

static int append_template_fragment(char *buffer, size_t buffer_size, size_t *buffer_len, const char *fragment_start,
                                    size_t fragment_len) {
  if (!buffer || !buffer_len || !fragment_start)
    return -1;

  if (*buffer_len + fragment_len >= buffer_size) {
    logger(LOG_WARN, "Template fragments exceed buffer size");
    return -1;
  }

  memcpy(buffer + *buffer_len, fragment_start, fragment_len);
  *buffer_len += fragment_len;
  buffer[*buffer_len] = '\0';
  return 0;
}

static int copy_template_value(char *buffer, size_t buffer_size, const char *value_start, size_t value_len) {
  if (!buffer || !value_start || value_len >= buffer_size)
    return -1;

  memcpy(buffer, value_start, value_len);
  buffer[value_len] = '\0';
  return 0;
}

static int classify_template_placeholder(const char *inner, int is_short_syntax, int *is_known_template, int *is_begin,
                                         int *is_end, int *needs_begin, int *needs_end) {
  char normalized[128];
  char *colon;

  if (!inner || !is_known_template || !is_begin || !is_end || !needs_begin || !needs_end)
    return -1;

  *is_known_template = 0;
  *is_begin = 0;
  *is_end = 0;
  *needs_begin = 0;
  *needs_end = 0;

  if (inner[0] == '(' && inner[2] == ')' && (inner[1] == 'b' || inner[1] == 'e')) {
    *is_known_template = 1;
    if (inner[1] == 'b') {
      *is_begin = 1;
      *needs_begin = 1;
    } else {
      *is_end = 1;
      *needs_end = 1;
    }
    return 0;
  }

  strncpy(normalized, inner, sizeof(normalized) - 1);
  normalized[sizeof(normalized) - 1] = '\0';
  colon = strchr(normalized, ':');
  if (colon)
    *colon = '\0';

  if (strcmp(normalized, "utc") == 0 || strcmp(normalized, "start") == 0 || strcmp(normalized, "yyyy") == 0 ||
      strcmp(normalized, "MM") == 0 || strcmp(normalized, "dd") == 0 || strcmp(normalized, "HH") == 0 ||
      strcmp(normalized, "mm") == 0 || strcmp(normalized, "ss") == 0) {
    *is_known_template = 1;
    *is_begin = 1;
    *needs_begin = 1;
  } else if (strcmp(normalized, "utcend") == 0 || strcmp(normalized, "end") == 0) {
    *is_known_template = 1;
    *is_end = 1;
    *needs_end = 1;
  } else if (strcmp(normalized, "duration") == 0) {
    *is_known_template = 1;
    *needs_begin = 1;
    *needs_end = 1;
  } else if (strcmp(normalized, "offset") == 0) {
    *is_known_template = 1;
    *needs_begin = 1;
  } else if (strcmp(normalized, "lutc") == 0 || strcmp(normalized, "now") == 0 ||
             strcmp(normalized, "timestamp") == 0) {
    *is_known_template = 1;
  } else if (is_short_syntax &&
             (strcmp(normalized, "Y") == 0 || strcmp(normalized, "m") == 0 || strcmp(normalized, "d") == 0 ||
              strcmp(normalized, "H") == 0 || strcmp(normalized, "M") == 0 || strcmp(normalized, "S") == 0)) {
    *is_known_template = 1;
    *is_begin = 1;
    *needs_begin = 1;
  }

  return 0;
}

static int template_substring_requirements(const char *input, size_t input_len, int *has_template, int *has_begin,
                                           int *has_end, int *needs_begin, int *needs_end) {
  const char *p;
  const char *input_end;

  if (!input || !has_template || !has_begin || !has_end || !needs_begin || !needs_end)
    return -1;

  *has_template = 0;
  *has_begin = 0;
  *has_end = 0;
  *needs_begin = 0;
  *needs_end = 0;
  input_end = input + input_len;
  p = input;

  while (p < input_end) {
    if (*p == '$' && p + 1 < input_end && *(p + 1) == '{') {
      const char *closing = strchr(p + 2, '}');
      const char *inner_start = p + 2;
      size_t inner_len;
      char inner[128];
      int is_known_template = 0;
      int is_begin = 0;
      int is_end = 0;
      int local_needs_begin = 0;
      int local_needs_end = 0;

      if (!closing || closing >= input_end) {
        p++;
        continue;
      }

      inner_len = (size_t)(closing - inner_start);
      if (inner_len >= sizeof(inner)) {
        p = closing + 1;
        continue;
      }

      memcpy(inner, inner_start, inner_len);
      inner[inner_len] = '\0';

      if (classify_template_placeholder(inner, 0, &is_known_template, &is_begin, &is_end, &local_needs_begin,
                                        &local_needs_end) != 0)
        return -1;

      if (is_known_template)
        *has_template = 1;
      if (is_begin)
        *has_begin = 1;
      if (is_end)
        *has_end = 1;
      *needs_begin |= local_needs_begin;
      *needs_end |= local_needs_end;

      p = closing + 1;
      continue;
    }

    if (*p == '{' && (p == input || *(p - 1) != '$')) {
      const char *closing = strchr(p + 1, '}');
      const char *inner_start = p + 1;
      size_t inner_len;
      char inner[128];
      int is_known_template = 0;
      int is_begin = 0;
      int is_end = 0;
      int local_needs_begin = 0;
      int local_needs_end = 0;

      if (!closing || closing >= input_end) {
        p++;
        continue;
      }

      inner_len = (size_t)(closing - inner_start);
      if (inner_len >= sizeof(inner)) {
        p = closing + 1;
        continue;
      }

      memcpy(inner, inner_start, inner_len);
      inner[inner_len] = '\0';

      if (classify_template_placeholder(inner, 1, &is_known_template, &is_begin, &is_end, &local_needs_begin,
                                        &local_needs_end) != 0)
        return -1;

      if (is_known_template)
        *has_template = 1;
      if (is_begin)
        *has_begin = 1;
      if (is_end)
        *has_end = 1;
      *needs_begin |= local_needs_begin;
      *needs_end |= local_needs_end;

      p = closing + 1;
      continue;
    }

    p++;
  }

  return 0;
}

static const char *find_template_range_separator(const char *value, size_t value_len) {
  const char *separator;
  const char *value_end;

  if (!value)
    return NULL;

  value_end = value + value_len;
  separator = value;
  while ((separator = strchr(separator, '-')) != NULL && separator < value_end) {
    int left_has_template = 0;
    int left_has_begin = 0;
    int left_has_end = 0;
    int left_needs_begin = 0;
    int left_needs_end = 0;
    int right_has_template = 0;
    int right_has_begin = 0;
    int right_has_end = 0;
    int right_needs_begin = 0;
    int right_needs_end = 0;

    if (template_substring_requirements(value, (size_t)(separator - value), &left_has_template, &left_has_begin,
                                        &left_has_end, &left_needs_begin, &left_needs_end) == 0 &&
        template_substring_requirements(separator + 1, (size_t)(value_end - (separator + 1)), &right_has_template,
                                        &right_has_begin, &right_has_end, &right_needs_begin, &right_needs_end) == 0) {
      if (left_has_begin && !left_has_end && right_has_end)
        return separator;
    }

    separator++;
  }

  return NULL;
}

static int template_path_requirements(const char *url, int *has_template, int *needs_begin, int *needs_end,
                                      char *begin_template, size_t begin_template_size, char *end_template,
                                      size_t end_template_size) {
  const char *query;
  size_t path_len;
  const char *p;
  size_t begin_len = 0;
  size_t end_len = 0;

  if (!url || !has_template || !needs_begin || !needs_end || !begin_template || !end_template)
    return -1;

  *has_template = 0;
  *needs_begin = 0;
  *needs_end = 0;
  begin_template[0] = '\0';
  end_template[0] = '\0';

  query = strchr(url, '?');
  path_len = query ? (size_t)(query - url) : strlen(url);
  p = url;

  while (p < url + path_len) {
    if (*p == '$' && p + 1 < url + path_len && *(p + 1) == '{') {
      const char *closing = strchr(p + 2, '}');
      const char *inner_start = p + 2;
      size_t inner_len;
      char inner[128];
      int is_known_template = 0;
      int is_begin = 0;
      int is_end = 0;
      int local_needs_begin = 0;
      int local_needs_end = 0;

      if (!closing || (size_t)(closing - url) >= path_len) {
        p++;
        continue;
      }

      inner_len = (size_t)(closing - inner_start);
      if (inner_len >= sizeof(inner)) {
        p = closing + 1;
        continue;
      }

      memcpy(inner, inner_start, inner_len);
      inner[inner_len] = '\0';

      if (classify_template_placeholder(inner, 0, &is_known_template, &is_begin, &is_end, &local_needs_begin,
                                        &local_needs_end) != 0)
        return -1;

      if (is_known_template)
        *has_template = 1;
      *needs_begin |= local_needs_begin;
      *needs_end |= local_needs_end;

      if (is_begin) {
        if (append_template_fragment(begin_template, begin_template_size, &begin_len, p, (size_t)(closing - p + 1)) !=
            0)
          return -1;
      } else if (is_end) {
        if (append_template_fragment(end_template, end_template_size, &end_len, p, (size_t)(closing - p + 1)) != 0)
          return -1;
      }

      p = closing + 1;
      continue;
    }

    if (*p == '{' && (p == url || *(p - 1) != '$')) {
      const char *closing = strchr(p + 1, '}');
      const char *inner_start = p + 1;
      size_t inner_len;
      char inner[128];
      int is_known_template = 0;
      int is_begin = 0;
      int is_end = 0;
      int local_needs_begin = 0;
      int local_needs_end = 0;

      if (!closing || (size_t)(closing - url) >= path_len) {
        p++;
        continue;
      }

      inner_len = (size_t)(closing - inner_start);
      if (inner_len >= sizeof(inner)) {
        p = closing + 1;
        continue;
      }

      memcpy(inner, inner_start, inner_len);
      inner[inner_len] = '\0';

      if (classify_template_placeholder(inner, 1, &is_known_template, &is_begin, &is_end, &local_needs_begin,
                                        &local_needs_end) != 0)
        return -1;

      if (is_known_template)
        *has_template = 1;
      *needs_begin |= local_needs_begin;
      *needs_end |= local_needs_end;

      if (is_begin) {
        if (append_template_fragment(begin_template, begin_template_size, &begin_len, p, (size_t)(closing - p + 1)) !=
            0)
          return -1;
      } else if (is_end) {
        if (append_template_fragment(end_template, end_template_size, &end_len, p, (size_t)(closing - p + 1)) != 0)
          return -1;
      }

      p = closing + 1;
      continue;
    }

    p++;
  }

  return 0;
}

static int template_query_requirements(const char *url, int *has_template, int *needs_begin, int *needs_end,
                                       char *begin_template, size_t begin_template_size, char *end_template,
                                       size_t end_template_size) {
  const char *query_start;
  const char *param_start;

  if (!url || !has_template || !needs_begin || !needs_end || !begin_template || !end_template)
    return -1;

  *has_template = 0;
  *needs_begin = 0;
  *needs_end = 0;
  begin_template[0] = '\0';
  end_template[0] = '\0';

  query_start = strchr(url, '?');
  if (!query_start) {
    if (url[0] == '?') {
      query_start = url;
    } else {
      return 0;
    }
  }

  param_start = query_start + 1;
  while (*param_start) {
    const char *param_end = strchr(param_start, '&');
    const char *equals_pos;
    const char *value_start;
    size_t value_len;
    int local_has_template = 0;
    int has_begin = 0;
    int has_end = 0;
    int local_needs_begin = 0;
    int local_needs_end = 0;

    if (!param_end)
      param_end = param_start + strlen(param_start);

    equals_pos = strchr(param_start, '=');
    if (!equals_pos || equals_pos >= param_end) {
      if (*param_end == '\0')
        break;
      param_start = param_end + 1;
      continue;
    }

    value_start = equals_pos + 1;
    value_len = (size_t)(param_end - value_start);

    if (template_substring_requirements(value_start, value_len, &local_has_template, &has_begin, &has_end,
                                        &local_needs_begin, &local_needs_end) != 0)
      return -1;

    if (local_has_template)
      *has_template = 1;
    *needs_begin |= local_needs_begin;
    *needs_end |= local_needs_end;

    if (has_begin && has_end) {
      const char *separator = find_template_range_separator(value_start, value_len);
      if (separator) {
        if (!begin_template[0] && copy_template_value(begin_template, begin_template_size, value_start,
                                                      (size_t)(separator - value_start)) != 0)
          return -1;
        if (!end_template[0] && copy_template_value(end_template, end_template_size, separator + 1,
                                                    (size_t)(param_end - (separator + 1))) != 0)
          return -1;
      }
    } else if (has_begin && !has_end) {
      if (!begin_template[0] && copy_template_value(begin_template, begin_template_size, value_start, value_len) != 0)
        return -1;
    } else if (has_end && !has_begin) {
      if (!end_template[0] && copy_template_value(end_template, end_template_size, value_start, value_len) != 0)
        return -1;
    }

    if (*param_end == '\0')
      break;
    param_start = param_end + 1;
  }

  return 0;
}

static int append_output_string(char *output, size_t output_size, size_t *output_pos, const char *value) {
  size_t value_len;

  if (!output || !output_pos || !value)
    return -1;

  value_len = strlen(value);
  if (*output_pos + value_len >= output_size) {
    logger(LOG_ERROR, "Resolved URL too long");
    return -1;
  }

  memcpy(output + *output_pos, value, value_len);
  *output_pos += value_len;
  output[*output_pos] = '\0';
  return 0;
}

static int get_tm_component(const struct tm *t, int index) {
  switch (index) {
  case 0:
    return t->tm_year + 1900;
  case 1:
    return t->tm_mon + 1;
  case 2:
    return t->tm_mday;
  case 3:
    return t->tm_hour;
  case 4:
    return t->tm_min;
  case 5:
    return t->tm_sec;
  default:
    return -1;
  }
}

static int format_time_by_pattern(const struct tm *t, const char *fmt, int use_short, char *output,
                                  size_t output_size) {
  size_t pos = 0;
  const char *p = fmt;
  int i;

  while (*p && pos < output_size - 1) {
    int matched = 0;

    for (i = 0; time_components[i].long_name; i++) {
      const char *name = use_short ? time_components[i].short_name : time_components[i].long_name;
      size_t name_len = strlen(name);

      if (strncmp(p, name, name_len) == 0) {
        int comp = get_tm_component(t, i);
        int width = (i == 0) ? 4 : 2;
        int n = snprintf(output + pos, output_size - pos, "%0*d", width, comp);
        if (n < 0 || (size_t)n >= output_size - pos)
          return -1;
        pos += (size_t)n;
        p += name_len;
        matched = 1;
        break;
      }
    }

    if (!matched)
      output[pos++] = *p++;
  }

  if (pos >= output_size)
    return -1;
  output[pos] = '\0';
  return 0;
}

static int render_be_format(const char *fmt, size_t fmt_len, int is_begin, int use_short,
                            const seek_parse_result_t *ctx, char *val, size_t val_size) {
  const struct tm *tm_utc = is_begin ? &ctx->begin_tm_utc : &ctx->end_tm_utc;
  time_t epoch = is_begin ? ctx->begin_utc : ctx->end_utc;

  if ((is_begin && !ctx->begin_parsed) || (!is_begin && !ctx->end_parsed)) {
    logger(LOG_ERROR, "Template requires %s time but seek value does not provide it", is_begin ? "begin" : "end");
    return -1;
  }

  if (fmt_len == 0)
    return timezone_format_time_iso8601(tm_utc, 0, "Z", val, val_size);

  if (strcmp(fmt, "timestamp") == 0) {
    if (snprintf(val, val_size, "%lld", (long long)epoch) >= (int)val_size)
      return -1;
    return 0;
  }

  {
    int force_utc = 0;
    char clean_fmt[128];
    size_t clean_len;
    const struct tm *which;

    strncpy(clean_fmt, fmt, sizeof(clean_fmt) - 1);
    clean_fmt[sizeof(clean_fmt) - 1] = '\0';
    clean_len = strlen(clean_fmt);
    if (clean_len >= 4 && strcmp(clean_fmt + clean_len - 4, "|UTC") == 0) {
      clean_fmt[clean_len - 4] = '\0';
      force_utc = 1;
    }

    which = force_utc ? tm_utc : (is_begin ? &ctx->begin_tm_local : &ctx->end_tm_local);
    return format_time_by_pattern(which, clean_fmt, use_short, val, val_size);
  }
}

static int render_keyword(const char *inner, int use_short, const seek_parse_result_t *ctx, const struct tm *now_tm,
                          char *val, size_t val_size) {
  char buf[128];
  char *colon;

  strncpy(buf, inner, sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = '\0';

  colon = strchr(buf, ':');
  if (colon) {
    const struct tm *tm_target = NULL;

    *colon = '\0';
    if (strcmp(buf, "utc") == 0 || strcmp(buf, "start") == 0) {
      if (!ctx->begin_parsed)
        return -1;
      tm_target = &ctx->begin_tm_utc;
    } else if (strcmp(buf, "utcend") == 0 || strcmp(buf, "end") == 0) {
      if (!ctx->end_parsed)
        return -1;
      tm_target = &ctx->end_tm_utc;
    } else if (strcmp(buf, "lutc") == 0 || strcmp(buf, "now") == 0 || strcmp(buf, "timestamp") == 0) {
      tm_target = now_tm;
    }

    if (tm_target) {
      if (format_time_by_pattern(tm_target, colon + 1, use_short, val, val_size) != 0)
        return -1;
      return 1;
    }
    return 0;
  }

  if (strcmp(inner, "utc") == 0 || strcmp(inner, "start") == 0) {
    if (!ctx->begin_parsed || timezone_format_time_iso8601(&ctx->begin_tm_utc, 0, "Z", val, val_size) != 0)
      return -1;
    return 1;
  }
  if (strcmp(inner, "utcend") == 0 || strcmp(inner, "end") == 0) {
    if (!ctx->end_parsed || timezone_format_time_iso8601(&ctx->end_tm_utc, 0, "Z", val, val_size) != 0)
      return -1;
    return 1;
  }
  if (strcmp(inner, "lutc") == 0 || strcmp(inner, "now") == 0) {
    if (timezone_format_time_iso8601(now_tm, 0, "Z", val, val_size) != 0)
      return -1;
    return 1;
  }
  if (strcmp(inner, "timestamp") == 0) {
    if (snprintf(val, val_size, "%lld", (long long)ctx->now_utc) >= (int)val_size)
      return -1;
    return 1;
  }
  if (strcmp(inner, "duration") == 0) {
    if (!ctx->begin_parsed || !ctx->end_parsed)
      return -1;
    if (snprintf(val, val_size, "%lld", (long long)(ctx->end_utc - ctx->begin_utc)) >= (int)val_size)
      return -1;
    return 1;
  }
  if (strcmp(inner, "offset") == 0) {
    if (!ctx->begin_parsed)
      return -1;
    if (snprintf(val, val_size, "%lld", (long long)(ctx->now_utc - ctx->begin_utc)) >= (int)val_size)
      return -1;
    return 1;
  }

  {
    int i;

    for (i = 0; time_components[i].long_name; i++) {
      const char *name = use_short ? time_components[i].short_name : time_components[i].long_name;
      if (strcmp(inner, name) == 0) {
        int comp;
        int width;

        if (!ctx->begin_parsed)
          return -1;
        comp = get_tm_component(&ctx->begin_tm_utc, i);
        width = (i == 0) ? 4 : 2;
        if (snprintf(val, val_size, "%0*d", width, comp) >= (int)val_size)
          return -1;
        return 1;
      }
    }
  }

  return 0;
}

static int render_placeholder(const char *p, int inner_offset, int be_char_offset, int fmt_offset, int use_short,
                              const seek_parse_result_t *ctx, const struct tm *now_tm, char *output, size_t output_size,
                              size_t *output_pos) {
  if (p[inner_offset] == '(' && (p[be_char_offset] == 'b' || p[be_char_offset] == 'e') && p[inner_offset + 2] == ')') {
    const char *fmt_start = p + fmt_offset;
    const char *closing = strchr(fmt_start, '}');

    if (closing) {
      size_t fmt_len = (size_t)(closing - fmt_start);
      char fmt[128];
      char val[128];

      if (fmt_len >= sizeof(fmt))
        return -1;
      memcpy(fmt, fmt_start, fmt_len);
      fmt[fmt_len] = '\0';

      if (render_be_format(fmt, fmt_len, p[be_char_offset] == 'b', use_short, ctx, val, sizeof(val)) != 0)
        return -1;
      if (append_output_string(output, output_size, output_pos, val) != 0)
        return -1;
      return (int)(closing + 1 - p);
    }
  }

  {
    const char *closing = strchr(p + inner_offset, '}');

    if (closing) {
      size_t inner_len = (size_t)(closing - (p + inner_offset));
      char inner[128];
      char val[128];
      int rc;

      if (inner_len >= sizeof(inner))
        return -1;
      memcpy(inner, p + inner_offset, inner_len);
      inner[inner_len] = '\0';

      rc = render_keyword(inner, use_short, ctx, now_tm, val, sizeof(val));
      if (rc < 0)
        return -1;
      if (rc > 0) {
        if (append_output_string(output, output_size, output_pos, val) != 0)
          return -1;
        return (int)(closing + 1 - p);
      }
    }
  }

  return 0;
}

static int render_template_url(const char *url, const seek_parse_result_t *ctx, char *output, size_t output_size) {
  size_t output_pos = 0;
  const char *p;
  struct tm now_tm;

  if (!url || !ctx || !output || output_size == 0)
    return -1;

  output[0] = '\0';
  {
    struct tm *tmp = gmtime(&ctx->now_utc);
    if (!tmp)
      return -1;
    now_tm = *tmp;
  }

  p = url;
  while (*p) {
    if (p[0] == '$' && p[1] == '{') {
      int consumed = render_placeholder(p, 2, 3, 5, 0, ctx, &now_tm, output, output_size, &output_pos);
      if (consumed < 0)
        return -1;
      if (consumed > 0) {
        p += consumed;
        continue;
      }
    }

    if (*p == '{' && (p == url || *(p - 1) != '$')) {
      int consumed = render_placeholder(p, 1, 2, 4, 1, ctx, &now_tm, output, output_size, &output_pos);
      if (consumed < 0)
        return -1;
      if (consumed > 0) {
        p += consumed;
        continue;
      }
    }

    if (output_pos + 1 >= output_size) {
      logger(LOG_ERROR, "Resolved URL too long");
      return -1;
    }
    output[output_pos++] = *p++;
    output[output_pos] = '\0';
  }

  return 0;
}

int url_template_analyze(const char *url, url_template_analysis_t *analysis) {
  int path_has_template = 0;
  int query_has_template = 0;
  int path_needs_begin = 0;
  int path_needs_end = 0;
  int query_needs_begin = 0;
  int query_needs_end = 0;
  char path_begin_template[URL_TEMPLATE_FRAGMENT_SIZE];
  char path_end_template[URL_TEMPLATE_FRAGMENT_SIZE];
  char query_begin_template[URL_TEMPLATE_FRAGMENT_SIZE];
  char query_end_template[URL_TEMPLATE_FRAGMENT_SIZE];

  if (!url || !analysis)
    return -1;

  memset(analysis, 0, sizeof(*analysis));

  if (template_path_requirements(url, &path_has_template, &path_needs_begin, &path_needs_end, path_begin_template,
                                 sizeof(path_begin_template), path_end_template, sizeof(path_end_template)) != 0)
    return -1;

  if (template_query_requirements(url, &query_has_template, &query_needs_begin, &query_needs_end, query_begin_template,
                                  sizeof(query_begin_template), query_end_template, sizeof(query_end_template)) != 0)
    return -1;

  analysis->has_template = path_has_template || query_has_template;
  analysis->needs_begin = path_needs_begin || query_needs_begin;
  analysis->needs_end = path_needs_end || query_needs_end;

  if (query_begin_template[0]) {
    strncpy(analysis->begin_template, query_begin_template, sizeof(analysis->begin_template) - 1);
    analysis->begin_template[sizeof(analysis->begin_template) - 1] = '\0';
  } else if (path_begin_template[0]) {
    strncpy(analysis->begin_template, path_begin_template, sizeof(analysis->begin_template) - 1);
    analysis->begin_template[sizeof(analysis->begin_template) - 1] = '\0';
  }

  if (query_end_template[0]) {
    strncpy(analysis->end_template, query_end_template, sizeof(analysis->end_template) - 1);
    analysis->end_template[sizeof(analysis->end_template) - 1] = '\0';
  } else if (path_end_template[0]) {
    strncpy(analysis->end_template, path_end_template, sizeof(analysis->end_template) - 1);
    analysis->end_template[sizeof(analysis->end_template) - 1] = '\0';
  }

  return 0;
}

int url_template_has_placeholders(const char *url) {
  const char *p;

  if (!url)
    return 0;

  /* Quick scan for ${...} patterns */
  if (strstr(url, "${"))
    return 1;

  /* Check for known simple placeholders */
  static const char *tokens[] = {"{utc}",    "{start}", "{lutc}",      "{end}", "{duration}", "{offset}",
                                 "{utcend}", "{now}",   "{timestamp}", "{Y}",   "{m}",        "{d}",
                                 "{H}",      "{M}",     "{S}",         NULL};
  for (int i = 0; tokens[i]; i++) {
    if (strstr(url, tokens[i]))
      return 1;
  }

  /* Check for {(b)...} or {(e)...} without $ prefix */
  p = url;
  while ((p = strstr(p, "{(")) != NULL) {
    if (p == url || *(p - 1) != '$') {
      if ((p[2] == 'b' || p[2] == 'e') && p[3] == ')')
        return 1;
    }
    p++;
  }

  /* Check for {keyword:FORMAT} patterns */
  static const char *keyword_prefixes[] = {
      "{utc:", "{start:", "{lutc:", "{end:", "{utcend:", "{now:", "{timestamp:", NULL};
  for (int i = 0; keyword_prefixes[i]; i++) {
    const char *found = strstr(url, keyword_prefixes[i]);
    if (found && (found == url || *(found - 1) != '$')) {
      if (strchr(found + 1, '}'))
        return 1;
    }
  }

  return 0;
}

int url_template_resolve(const char *url, const seek_parse_result_t *parse_result, char *output, size_t output_size) {
  if (!url || !parse_result || !output || output_size == 0)
    return -1;

  if (!parse_result->has_seek) {
    strncpy(output, url, output_size - 1);
    output[output_size - 1] = '\0';
    return 0;
  }

  if (parse_result->has_begin && !parse_result->begin_parsed) {
    logger(LOG_ERROR, "Failed to parse begin time '%s' for template", parse_result->begin_str);
    return -1;
  }

  if (parse_result->has_end && !parse_result->end_parsed) {
    logger(LOG_ERROR, "Failed to parse end time '%s' for template", parse_result->end_str);
    return -1;
  }

  return render_template_url(url, parse_result, output, output_size);
}

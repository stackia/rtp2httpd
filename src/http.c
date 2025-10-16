#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <netdb.h>
#include <ctype.h>
#include <sys/socket.h>
#include "http.h"
#include "rtp2httpd.h"
#include "connection.h"

static const char *response_codes[] = {
    "HTTP/1.1 200 OK\r\n",                    /* 0 */
    "HTTP/1.1 404 Not Found\r\n",             /* 1 */
    "HTTP/1.1 400 Bad Request\r\n",           /* 2 */
    "HTTP/1.1 501 Not Implemented\r\n",       /* 3 */
    "HTTP/1.1 503 Service Unavailable\r\n",   /* 4 */
    "HTTP/1.1 500 Internal Server Error\r\n", /* 5 */
    "HTTP/1.1 401 Unauthorized\r\n",          /* 6 */
    "HTTP/1.1 304 Not Modified\r\n",          /* 7 */
};

static const char *content_types[] = {
    "Content-Type: application/octet-stream\r\n", /* 0 */
    "Content-Type: text/html\r\n",                /* 1 */
    "Content-Type: text/html; charset=utf-8\r\n", /* 2 */
    "Content-Type: video/mpeg\r\n",               /* 3 */
    "Content-Type: audio/mpeg\r\n",               /* 4 */
    "Content-Type: video/mp2t\r\n",               /* 5 */
    "Content-Type: text/event-stream\r\n",        /* 6 */
    "Content-Type: image/jpeg\r\n"                /* 7 */
};

void send_http_headers(connection_t *c, http_status_t status, content_type_t type, const char *extra_headers)
{
    char headers[2048];
    int len = 0;

    /* Build complete header in one buffer */
    /* Status line */
    len += snprintf(headers + len, sizeof(headers) - len, "%s", response_codes[status]);

    /* Content-Type (skip for 304 responses which have no body) */
    if (status != STATUS_304)
    {
        len += snprintf(headers + len, sizeof(headers) - len, "%s", content_types[type]);
    }

    /* Connection header */
    if (type == CONTENT_SSE)
    {
        /* SSE needs keep-alive and cache control */
        len += snprintf(headers + len, sizeof(headers) - len,
                        "Cache-Control: no-cache\r\n"
                        "Connection: keep-alive\r\n");
    }
    else
    {
        /* For non-SSE responses, always close the connection (no keep-alive support) */
        len += snprintf(headers + len, sizeof(headers) - len, "Connection: close\r\n");
    }

    /* Extra headers if provided */
    if (extra_headers && extra_headers[0])
    {
        len += snprintf(headers + len, sizeof(headers) - len, "%s", extra_headers);
    }

    /* Final CRLF */
    len += snprintf(headers + len, sizeof(headers) - len, "\r\n");

    connection_queue_output(c, (const uint8_t *)headers, len);
}

int http_url_decode(char *str)
{
    char *src = str;
    char *dst = str;
    unsigned int hex_value;

    if (!str)
        return -1;

    while (*src)
    {
        if (*src == '%')
        {
            if (strlen(src) >= 3 && sscanf(src + 1, "%2x", &hex_value) == 1)
            {
                *dst++ = (char)hex_value;
                src += 3;
            }
            else
            {
                return -1;
            }
        }
        else
        {
            *dst++ = *src++;
        }
    }

    *dst = '\0';
    return 0;
}

/**
 * Initialize HTTP request structure
 */
void http_request_init(http_request_t *req)
{
    if (!req)
        return;
    memset(req, 0, sizeof(*req));
    req->parse_state = HTTP_PARSE_REQ_LINE;
    req->content_length = -1;
    req->body_len = 0;
}

/**
 * Parse HTTP request from buffer (incremental parsing)
 * Returns: 0 = need more data, 1 = request complete, -1 = parse error
 */
int http_parse_request(char *inbuf, int *in_len, http_request_t *req)
{
    if (!inbuf || !in_len || !req)
        return -1;

    /* Parse HTTP request line */
    if (req->parse_state == HTTP_PARSE_REQ_LINE)
    {
        char *line_end = strstr(inbuf, "\r\n");
        if (!line_end)
            return 0; /* Need more data */

        size_t line_len = (size_t)(line_end - inbuf) + 2;
        *line_end = '\0';

        /* Parse: METHOD URL HTTP/1.x */
        char *sp1 = strchr(inbuf, ' ');
        if (sp1)
        {
            *sp1 = '\0';
            strncpy(req->method, inbuf, sizeof(req->method) - 1);
            req->method[sizeof(req->method) - 1] = '\0';

            char *sp2 = strchr(sp1 + 1, ' ');
            if (sp2)
            {
                *sp2 = '\0';
                strncpy(req->url, sp1 + 1, sizeof(req->url) - 1);
                req->url[sizeof(req->url) - 1] = '\0';

                if (strstr(sp2 + 1, "HTTP/1.1"))
                    req->is_http_1_1 = 1;
            }
        }

        /* Shift buffer */
        memmove(inbuf, inbuf + line_len, *in_len - (int)line_len);
        *in_len -= (int)line_len;
        req->parse_state = HTTP_PARSE_HEADERS;
    }

    /* Parse headers */
    if (req->parse_state == HTTP_PARSE_HEADERS)
    {
        for (;;)
        {
            char *line_end = strstr(inbuf, "\r\n");
            if (!line_end)
                return 0; /* Need more data */

            size_t line_len = (size_t)(line_end - inbuf) + 2;

            /* Empty line = end of headers */
            if (line_len == 2)
            {
                memmove(inbuf, inbuf + 2, *in_len - 2);
                *in_len -= 2;

                /* Check if we need to read body */
                if (req->content_length > 0)
                {
                    req->parse_state = HTTP_PARSE_BODY;
                    break; /* Exit header parsing loop to read body */
                }
                else
                {
                    req->parse_state = HTTP_PARSE_COMPLETE;
                    return 1; /* Request complete */
                }
            }

            *line_end = '\0';

            /* Parse header: Name: Value */
            char *colon = strchr(inbuf, ':');
            if (colon)
            {
                *colon = '\0';
                char *value = colon + 1;
                /* Skip leading whitespace */
                while (*value == ' ' || *value == '\t')
                    value++;

                /* Trim trailing whitespace */
                char *value_end = value + strlen(value);
                while (value_end > value && (value_end[-1] == ' ' || value_end[-1] == '\t'))
                {
                    value_end--;
                    *value_end = '\0';
                }

                /* Extract interesting headers */
                if (strcasecmp(inbuf, "Host") == 0)
                {
                    strncpy(req->hostname, value, sizeof(req->hostname) - 1);
                    req->hostname[sizeof(req->hostname) - 1] = '\0';
                }
                else if (strcasecmp(inbuf, "User-Agent") == 0)
                {
                    strncpy(req->user_agent, value, sizeof(req->user_agent) - 1);
                    req->user_agent[sizeof(req->user_agent) - 1] = '\0';
                }
                else if (strcasecmp(inbuf, "Accept") == 0)
                {
                    strncpy(req->accept, value, sizeof(req->accept) - 1);
                    req->accept[sizeof(req->accept) - 1] = '\0';
                }
                else if (strcasecmp(inbuf, "If-None-Match") == 0)
                {
                    strncpy(req->if_none_match, value, sizeof(req->if_none_match) - 1);
                    req->if_none_match[sizeof(req->if_none_match) - 1] = '\0';
                }
                else if (strcasecmp(inbuf, "X-Request-Snapshot") == 0)
                {
                    req->x_request_snapshot = (value[0] == '1');
                }
                else if (strcasecmp(inbuf, "Content-Length") == 0)
                {
                    req->content_length = atoi(value);
                }
            }

            /* Shift buffer */
            memmove(inbuf, inbuf + line_len, *in_len - (int)line_len);
            *in_len -= (int)line_len;
        }
    }

    /* Parse body if needed */
    if (req->parse_state == HTTP_PARSE_BODY)
    {
        int body_size = req->content_length;
        if (body_size > (int)sizeof(req->body) - 1)
            body_size = (int)sizeof(req->body) - 1; /* Truncate if too large */

        if (*in_len >= body_size)
        {
            /* We have the full body */
            memcpy(req->body, inbuf, body_size);
            req->body[body_size] = '\0';
            req->body_len = body_size;

            /* Shift buffer */
            memmove(inbuf, inbuf + body_size, *in_len - body_size);
            *in_len -= body_size;

            req->parse_state = HTTP_PARSE_COMPLETE;
            return 1; /* Request complete */
        }
        else
        {
            return 0; /* Need more data */
        }
    }

    return 0;
}

/**
 * Find parameter in query/form string (case-insensitive)
 * @param query_string Query or form data string
 * @param param_name Parameter name to search for
 * @param param_len Length of parameter name
 * @return Pointer to parameter start, or NULL if not found
 */
static const char *find_query_param(const char *query_string, const char *param_name, size_t param_len)
{
    const char *pos = query_string;

    while (pos && *pos)
    {
        /* Check if this position matches our parameter */
        if (strncasecmp(pos, param_name, param_len) == 0 && pos[param_len] == '=')
        {
            return pos;
        }

        /* Move to next parameter (find next &) */
        pos = strchr(pos, '&');
        if (pos)
        {
            pos++; /* Skip the & */
        }
    }

    return NULL;
}

/**
 * Parse query parameter value from query/form string (case-insensitive parameter names)
 * Works for both URL query strings and application/x-www-form-urlencoded body data
 * @param query_string Query or form data string (without leading ?)
 * @param param_name Parameter name to search for (case-insensitive)
 * @param value_buf Buffer to store parameter value
 * @param value_size Size of value buffer
 * @return 0 if parameter found, -1 if not found or error
 */
int http_parse_query_param(const char *query_string, const char *param_name,
                           char *value_buf, size_t value_size)
{
    const char *param_start, *value_start, *value_end;
    size_t param_len = strlen(param_name);
    size_t value_len;

    if (!query_string || !param_name || !value_buf)
    {
        return -1;
    }

    /* Find parameter in query string (case-insensitive) */
    param_start = find_query_param(query_string, param_name, param_len);
    if (!param_start)
    {
        return -1; /* Parameter not found */
    }

    /* Find value start */
    value_start = param_start + param_len + 1; /* Skip "param=" */

    /* Find value end (next & or end of string) */
    value_end = strchr(value_start, '&');
    if (!value_end)
    {
        value_end = value_start + strlen(value_start);
    }

    /* Check value length */
    value_len = value_end - value_start;
    if (value_len >= value_size)
    {
        return -1; /* Value too long */
    }

    /* Copy value */
    strncpy(value_buf, value_start, value_len);
    value_buf[value_len] = '\0';

    return 0;
}

/**
 * Send HTTP 400 Bad Request response
 * @param conn Connection object
 */
void http_send_400(connection_t *conn)
{
    static const char body[] = "<!doctype html><title>400</title>Bad Request";

    /* Send headers */
    send_http_headers(conn, STATUS_400, CONTENT_HTML, NULL);

    /* Send body and flush */
    connection_queue_output_and_flush(conn, (const uint8_t *)body, sizeof(body) - 1);

    /* Set connection to closing state */
    conn->state = CONN_CLOSING;
}

/**
 * Send HTTP 404 Not Found response
 * @param conn Connection object
 */
void http_send_404(connection_t *conn)
{
    static const char body[] = "<!doctype html><title>404</title>Not Found";

    /* Send headers */
    send_http_headers(conn, STATUS_404, CONTENT_HTML, NULL);

    /* Send body and flush */
    connection_queue_output_and_flush(conn, (const uint8_t *)body, sizeof(body) - 1);

    /* Set connection to closing state */
    conn->state = CONN_CLOSING;
}

/**
 * Send HTTP 500 Internal Server Error response
 * @param conn Connection object
 */
void http_send_500(connection_t *conn)
{
    static const char body[] = "<!doctype html><title>500</title>Internal Server Error";

    /* Send headers */
    send_http_headers(conn, STATUS_500, CONTENT_HTML, NULL);

    /* Send body and flush */
    connection_queue_output_and_flush(conn, (const uint8_t *)body, sizeof(body) - 1);

    /* Set connection to closing state */
    conn->state = CONN_CLOSING;
}

/**
 * Send HTTP 503 Service Unavailable response
 * @param conn Connection object
 */
void http_send_503(connection_t *conn)
{
    static const char body[] = "<!doctype html><title>503</title>Service Unavailable";

    /* Send headers */
    send_http_headers(conn, STATUS_503, CONTENT_HTML, NULL);

    /* Send body and flush */
    connection_queue_output_and_flush(conn, (const uint8_t *)body, sizeof(body) - 1);

    /* Set connection to closing state */
    conn->state = CONN_CLOSING;
}

/**
 * Send HTTP 401 Unauthorized response
 * @param conn Connection object
 */
void http_send_401(connection_t *conn)
{
    static const char body[] = "<!doctype html><title>401</title>Unauthorized";

    /* Send headers with WWW-Authenticate */
    send_http_headers(conn, STATUS_401, CONTENT_HTML, "WWW-Authenticate: Bearer\r\n");

    /* Send body and flush */
    connection_queue_output_and_flush(conn, (const uint8_t *)body, sizeof(body) - 1);

    /* Set connection to closing state */
    conn->state = CONN_CLOSING;
}

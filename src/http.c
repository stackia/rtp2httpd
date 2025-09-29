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
#include "http.h"
#include "rtp2httpd.h"

/* Function declarations */
static struct services_s *parse_rtsp_url(const char *http_url);

static const char *response_codes[] = {
    "HTTP/1.1 200 OK\r\n",                  /* 0 */
    "HTTP/1.1 404 Not Found\r\n",           /* 1 */
    "HTTP/1.1 400 Bad Request\r\n",         /* 2 */
    "HTTP/1.1 501 Not Implemented\r\n",     /* 3 */
    "HTTP/1.1 503 Service Unavailable\r\n", /* 4 */
};

static const char *content_types[] = {
    "Content-Type: application/octet-stream\r\n", /* 0 */
    "Content-Type: text/html\r\n",                /* 1 */
    "Content-Type: text/html; charset=utf-8\r\n", /* 2 */
    "Content-Type: video/mpeg\r\n",               /* 3 */
    "Content-Type: audio/mpeg\r\n",               /* 4 */
    "Content-Type: video/mp2t\r\n"                /* 5 */
};

static const char static_headers[] =
    "Server: " PACKAGE "/" VERSION "\r\n"
    "\r\n";

void write_to_client(int s, const uint8_t *buf, const size_t buflen)
{
    ssize_t actual;
    size_t written = 0;
    while (written < buflen)
    {
        actual = write(s, buf + written, buflen - written);
        if (actual <= 0)
        {
            exit(RETVAL_WRITE_FAILED);
        }
        written += actual;
    }
}

void send_http_headers(int s, http_status_t status, content_type_t type)
{
    write_to_client(s, (const uint8_t *)response_codes[status],
                    strlen(response_codes[status]));
    write_to_client(s, (const uint8_t *)content_types[type],
                    strlen(content_types[type]));
    write_to_client(s, (const uint8_t *)static_headers,
                    sizeof(static_headers) - 1);
}

void sigpipe_handler(int signum)
{
    exit(RETVAL_WRITE_FAILED);
}

/* URL parsing helper structure */
struct url_components
{
    char multicast_addr[HTTP_ADDR_COMPONENT_SIZE];
    char multicast_port[HTTP_PORT_COMPONENT_SIZE];
    char source_addr[HTTP_ADDR_COMPONENT_SIZE];
    char source_port[HTTP_PORT_COMPONENT_SIZE];
    char fcc_addr[HTTP_ADDR_COMPONENT_SIZE];
    char fcc_port[HTTP_PORT_COMPONENT_SIZE];
    int has_source;
    int has_fcc;
};

/**
 * URL decode a string in place
 * @param str String to decode
 * @return 0 on success, -1 on error
 */
static int url_decode(char *str)
{
    char *src = str, *dst = str;
    unsigned int hex_value;

    while (*src)
    {
        if (*src == '%')
        {
            /* Check if we have at least 2 more characters for hex digits */
            if (strlen(src) >= 3 && sscanf(src + 1, "%2x", &hex_value) == 1)
            {
                *dst++ = (char)hex_value;
                src += 3;
            }
            else
            {
                return -1; /* Invalid hex encoding */
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
 * Parse IPv6 address from URL component
 * @param input Input string starting with '['
 * @param addr Output buffer for address
 * @param addr_size Size of address buffer
 * @param remainder Pointer to set to remainder of string
 * @return 0 on success, -1 on error
 */
static int parse_ipv6_address(const char *input, char *addr, size_t addr_size, const char **remainder)
{
    const char *end = strchr(input + 1, ']');
    if (!end)
    {
        return -1; /* No closing bracket */
    }

    size_t addr_len = end - input - 1;
    if (addr_len >= addr_size)
    {
        return -1; /* Address too long */
    }

    strncpy(addr, input + 1, addr_len);
    addr[addr_len] = '\0';
    *remainder = end + 1;
    return 0;
}

/**
 * Parse address:port component
 * @param input Input string
 * @param addr Output buffer for address
 * @param addr_size Size of address buffer
 * @param port Output buffer for port
 * @param port_size Size of port buffer
 * @return 0 on success, -1 on error
 */
static int parse_address_port(const char *input, char *addr, size_t addr_size,
                              char *port, size_t port_size)
{
    const char *port_start;
    size_t addr_len;

    if (input[0] == '[')
    {
        /* IPv6 address */
        if (parse_ipv6_address(input, addr, addr_size, &port_start) != 0)
        {
            return -1;
        }
        if (*port_start == ':')
        {
            port_start++;
        }
        else if (*port_start != '\0')
        {
            return -1; /* Invalid format after IPv6 address */
        }
    }
    else
    {
        /* IPv4 address or hostname */
        port_start = strrchr(input, ':');
        if (port_start)
        {
            addr_len = port_start - input;
            port_start++;
        }
        else
        {
            addr_len = strlen(input);
        }

        if (addr_len >= addr_size)
        {
            return -1; /* Address too long */
        }

        memcpy(addr, input, addr_len);
        addr[addr_len] = '\0';
    }

    /* Copy port if present */
    if (port_start && *port_start)
    {
        if (strlen(port_start) >= port_size)
        {
            return -1; /* Port too long */
        }
        strncpy(port, port_start, port_size - 1);
        port[port_size - 1] = '\0';
    }
    else
    {
        port[0] = '\0';
    }

    return 0;
}

/**
 * Find parameter in query string (case-insensitive)
 * @param query_string Query string to search in
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
 * Parse query parameter value from query string (case-insensitive parameter names)
 * @param query_string Query string (without leading ?)
 * @param param_name Parameter name to search for (case-insensitive)
 * @param value_buf Buffer to store parameter value
 * @param value_size Size of value buffer
 * @return 0 if parameter found, -1 if not found or error
 */
static int parse_query_param(const char *query_string, const char *param_name,
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
 * Parse URL components from UDPxy format URL
 * @param url_part URL part after /rtp/ or /udp/
 * @param components Output structure for parsed components
 * @return 0 on success, -1 on error
 */
static int parse_url_components(char *url_part, struct url_components *components)
{
    char *query_start, *at_pos;
    char main_part[HTTP_URL_MAIN_PART_SIZE];
    char fcc_value[HTTP_URL_FCC_VALUE_SIZE];

    /* Initialize components */
    memset(components, 0, sizeof(*components));

    /* URL decode the input */
    if (url_decode(url_part) != 0)
    {
        return -1;
    }

    /* Split URL and query string */
    query_start = strchr(url_part, '?');
    if (query_start)
    {
        *query_start = '\0'; /* Terminate main part */
        query_start++;       /* Point to query string */

        /* Parse FCC parameter from query string */
        if (parse_query_param(query_start, "fcc", fcc_value, sizeof(fcc_value)) == 0)
        {
            /* Check for empty FCC value */
            if (fcc_value[0] == '\0')
            {
                return -1; /* Empty FCC parameter */
            }
            if (parse_address_port(fcc_value, components->fcc_addr,
                                   sizeof(components->fcc_addr),
                                   components->fcc_port,
                                   sizeof(components->fcc_port)) != 0)
            {
                return -1;
            }
            components->has_fcc = 1;
        }
    }

    /* Copy main part for parsing */
    if (strlen(url_part) >= sizeof(main_part))
    {
        return -1; /* URL too long */
    }
    strncpy(main_part, url_part, sizeof(main_part) - 1);
    main_part[sizeof(main_part) - 1] = '\0';

    /* Check if main part is empty (missing address) */
    if (main_part[0] == '\0')
    {
        return -1; /* Missing address */
    }

    /* Check for source address (format: source@multicast) */
    at_pos = strrchr(main_part, '@');
    if (at_pos)
    {
        *at_pos = '\0'; /* Split at @ */

        /* Check for empty source (malformed source) */
        if (main_part[0] == '\0')
        {
            return -1; /* Empty source address */
        }

        /* Check for empty multicast (malformed multicast) */
        if (*(at_pos + 1) == '\0')
        {
            return -1; /* Empty multicast address */
        }

        /* Parse source address */
        if (parse_address_port(main_part, components->source_addr,
                               sizeof(components->source_addr),
                               components->source_port,
                               sizeof(components->source_port)) != 0)
        {
            return -1;
        }
        components->has_source = 1;

        /* Parse multicast address */
        if (parse_address_port(at_pos + 1, components->multicast_addr,
                               sizeof(components->multicast_addr),
                               components->multicast_port,
                               sizeof(components->multicast_port)) != 0)
        {
            return -1;
        }
    }
    else
    {
        /* No source, only multicast address */
        if (parse_address_port(main_part, components->multicast_addr,
                               sizeof(components->multicast_addr),
                               components->multicast_port,
                               sizeof(components->multicast_port)) != 0)
        {
            return -1;
        }
    }

    /* Set default port if not specified */
    if (components->multicast_port[0] == '\0')
    {
        strcpy(components->multicast_port, "1234");
    }

    return 0;
}

/**
 * Parses URL in UDPxy format, i.e. /rtp/<maddr>:port
 * returns a pointer to statically allocated service struct if success,
 * NULL otherwise.
 */
struct services_s *parse_udpxy_url(char *url)
{
    static struct services_s serv;
    static struct addrinfo res_ai, msrc_res_ai, fcc_res_ai;
    static struct sockaddr_storage res_addr, msrc_res_addr, fcc_res_addr;

    struct url_components components;
    struct addrinfo hints, *res = NULL, *msrc_res = NULL, *fcc_res = NULL;
    char *url_part;
    char working_url[HTTP_URL_BUFFER_SIZE];
    int r = 0, rr = 0, rrr = 0;

    /* Free previously allocated memory to prevent leaks */
    if (serv.msrc)
    {
        free(serv.msrc);
        serv.msrc = NULL;
    }

    /* Validate input */
    if (!url || strlen(url) >= sizeof(working_url))
    {
        logger(LOG_ERROR, "Invalid or too long URL");
        /* Clean up any previously allocated msrc */
        if (serv.msrc)
        {
            free(serv.msrc);
            serv.msrc = NULL;
        }
        return NULL;
    }

    /* Copy URL to avoid modifying original */
    strncpy(working_url, url, sizeof(working_url) - 1);
    working_url[sizeof(working_url) - 1] = '\0';

    /* Determine service type */
    if (strncmp(working_url, "/rtp/", 5) == 0)
    {
        serv.service_type = SERVICE_MRTP;
        url_part = working_url + 5;
    }
    else if (strncmp(working_url, "/udp/", 5) == 0)
    {
        serv.service_type = SERVICE_MUDP;
        url_part = working_url + 5;
    }
    else if (strncmp(working_url, "/rtsp/", 6) == 0)
    {
        serv.service_type = SERVICE_RTSP;
        url_part = working_url + 6;
    }
    else
    {
        logger(LOG_ERROR, "URL must start with /rtp/, /udp/, or /rtsp/");
        return NULL;
    }

    /* Handle RTSP URL parsing separately */
    if (serv.service_type == SERVICE_RTSP)
    {
        return parse_rtsp_url(url);
    }

    /* Parse URL components for non-RTSP services */
    if (parse_url_components(url_part, &components) != 0)
    {
        logger(LOG_ERROR, "Failed to parse URL components");
        /* Clean up any previously allocated msrc */
        if (serv.msrc)
        {
            free(serv.msrc);
            serv.msrc = NULL;
        }
        return NULL;
    }

    logger(LOG_DEBUG, "Parsed URL: mcast=%s:%s",
           components.multicast_addr, components.multicast_port);
    if (components.has_source)
    {
        logger(LOG_DEBUG, " src=%s:%s", components.source_addr, components.source_port);
    }
    if (components.has_fcc)
    {
        logger(LOG_DEBUG, " fcc=%s:%s", components.fcc_addr, components.fcc_port);
    }

    /* Resolve addresses */
    memset(&hints, 0, sizeof(hints));
    hints.ai_socktype = SOCK_DGRAM;

    /* Resolve multicast address */
    r = getaddrinfo(components.multicast_addr, components.multicast_port, &hints, &res);
    if (r != 0)
    {
        logger(LOG_ERROR, "Cannot resolve multicast address %s:%s. GAI: %s",
               components.multicast_addr, components.multicast_port, gai_strerror(r));
        /* Clean up any previously allocated msrc */
        if (serv.msrc)
        {
            free(serv.msrc);
            serv.msrc = NULL;
        }
        return NULL;
    }

    /* Resolve source address if present */
    if (components.has_source)
    {
        const char *src_port = components.source_port[0] ? components.source_port : NULL;
        rr = getaddrinfo(components.source_addr, src_port, &hints, &msrc_res);
        if (rr != 0)
        {
            logger(LOG_ERROR, "Cannot resolve source address %s. GAI: %s",
                   components.source_addr, gai_strerror(rr));
            freeaddrinfo(res);
            /* Clean up any previously allocated msrc */
            if (serv.msrc)
            {
                free(serv.msrc);
                serv.msrc = NULL;
            }
            return NULL;
        }
    }

    /* Resolve FCC address if present */
    if (components.has_fcc)
    {
        const char *fcc_port = components.fcc_port[0] ? components.fcc_port : NULL;
        rrr = getaddrinfo(components.fcc_addr, fcc_port, &hints, &fcc_res);
        if (rrr != 0)
        {
            logger(LOG_ERROR, "Cannot resolve FCC address %s. GAI: %s",
                   components.fcc_addr, gai_strerror(rrr));
            freeaddrinfo(res);
            if (msrc_res)
                freeaddrinfo(msrc_res);
            /* Clean up any previously allocated msrc */
            if (serv.msrc)
            {
                free(serv.msrc);
                serv.msrc = NULL;
            }
            return NULL;
        }
    }

    /* Warn about ambiguous addresses */
    if (res->ai_next != NULL)
    {
        logger(LOG_ERROR, "Warning: multicast address is ambiguous.");
    }
    if (msrc_res && msrc_res->ai_next != NULL)
    {
        logger(LOG_ERROR, "Warning: source address is ambiguous.");
    }
    if (fcc_res && fcc_res->ai_next != NULL)
    {
        logger(LOG_ERROR, "Warning: FCC address is ambiguous.");
    }

    /* Copy results into static structures */
    memcpy(&res_addr, res->ai_addr, res->ai_addrlen);
    memcpy(&res_ai, res, sizeof(struct addrinfo));
    res_ai.ai_addr = (struct sockaddr *)&res_addr;
    res_ai.ai_canonname = NULL;
    res_ai.ai_next = NULL;
    serv.addr = &res_ai;

    /* Set up source address */
    serv.msrc_addr = NULL;
    serv.msrc = NULL;
    if (components.has_source)
    {
        memcpy(&msrc_res_addr, msrc_res->ai_addr, msrc_res->ai_addrlen);
        memcpy(&msrc_res_ai, msrc_res, sizeof(struct addrinfo));
        msrc_res_ai.ai_addr = (struct sockaddr *)&msrc_res_addr;
        msrc_res_ai.ai_canonname = NULL;
        msrc_res_ai.ai_next = NULL;
        serv.msrc_addr = &msrc_res_ai;

        /* Create source string for compatibility */
        char source_str[HTTP_SOURCE_STRING_SIZE];
        if (components.source_port[0])
        {
            snprintf(source_str, sizeof(source_str), "%s:%s",
                     components.source_addr, components.source_port);
        }
        else
        {
            strncpy(source_str, components.source_addr, sizeof(source_str) - 1);
            source_str[sizeof(source_str) - 1] = '\0';
        }
        serv.msrc = strdup(source_str);
        if (!serv.msrc)
        {
            logger(LOG_ERROR, "Failed to allocate memory for source string");
            freeaddrinfo(res);
            if (msrc_res)
                freeaddrinfo(msrc_res);
            if (fcc_res)
                freeaddrinfo(fcc_res);
            return NULL;
        }
    }
    else
    {
        serv.msrc = strdup("");
        if (!serv.msrc)
        {
            logger(LOG_ERROR, "Failed to allocate memory for empty source string");
            freeaddrinfo(res);
            if (msrc_res)
                freeaddrinfo(msrc_res);
            if (fcc_res)
                freeaddrinfo(fcc_res);
            return NULL;
        }
    }

    /* Set up FCC address */
    serv.fcc_addr = NULL;
    if (components.has_fcc)
    {
        memcpy(&fcc_res_addr, fcc_res->ai_addr, fcc_res->ai_addrlen);
        memcpy(&fcc_res_ai, fcc_res, sizeof(struct addrinfo));
        fcc_res_ai.ai_addr = (struct sockaddr *)&fcc_res_addr;
        fcc_res_ai.ai_canonname = NULL;
        fcc_res_ai.ai_next = NULL;
        serv.fcc_addr = &fcc_res_ai;
    }

    /* Free temporary addrinfo structures */
    freeaddrinfo(res);
    if (msrc_res)
        freeaddrinfo(msrc_res);
    if (fcc_res)
        freeaddrinfo(fcc_res);

    return &serv;
}

/*
 * Parse RTSP URL from HTTP request
 * Format: /rtsp/server:port/path?query&playseek=...
 */
static struct services_s *parse_rtsp_url(const char *http_url)
{
    struct services_s *result;
    char working_url[HTTP_URL_BUFFER_SIZE];
    char *url_part, *playseek_param = NULL;
    char *query_start, *playseek_start, *playseek_end;

    /* Validate input */
    if (!http_url || strlen(http_url) >= sizeof(working_url))
    {
        logger(LOG_ERROR, "Invalid or too long RTSP URL");
        return NULL;
    }

    /* Copy URL to avoid modifying original */
    strncpy(working_url, http_url, sizeof(working_url) - 1);
    working_url[sizeof(working_url) - 1] = '\0';

    /* Extract URL part after /rtsp/ */
    if (strncmp(working_url, "/rtsp/", 6) != 0)
    {
        logger(LOG_ERROR, "Invalid RTSP URL format");
        return NULL;
    }
    url_part = working_url + 6;

    /* Check if URL part is empty */
    if (strlen(url_part) == 0)
    {
        logger(LOG_ERROR, "RTSP URL part is empty");
        return NULL;
    }

    /* Find and extract playseek parameter, then remove it from URL */
    query_start = strchr(url_part, '?');
    if (query_start)
    {
        playseek_start = strstr(query_start, "playseek=");
        if (playseek_start)
        {
            playseek_start += 9; /* Skip "playseek=" */
            playseek_end = strchr(playseek_start, '&');
            if (!playseek_end)
            {
                playseek_end = playseek_start + strlen(playseek_start);
            }

            /* Extract playseek parameter */
            size_t param_len = playseek_end - playseek_start;
            playseek_param = malloc(param_len + 1);
            if (!playseek_param)
            {
                logger(LOG_ERROR, "Failed to allocate memory for playseek parameter");
                return NULL;
            }
            {
                strncpy(playseek_param, playseek_start, param_len);
                playseek_param[param_len] = '\0';

                /* URL decode playseek parameter */
                char *decoded = malloc(param_len + 1);
                if (!decoded)
                {
                    logger(LOG_ERROR, "Failed to allocate memory for decoded playseek parameter");
                    free(playseek_param);
                    return NULL;
                }
                {
                    int decoded_len = 0;
                    for (size_t i = 0; i < param_len; i++)
                    {
                        if (playseek_param[i] == '%' && i + 2 < param_len)
                        {
                            /* URL decode hex characters */
                            int hex_val;
                            if (sscanf(playseek_param + i + 1, "%2x", &hex_val) == 1)
                            {
                                decoded[decoded_len++] = hex_val;
                                i += 2;
                            }
                            else
                            {
                                decoded[decoded_len++] = playseek_param[i];
                            }
                        }
                        else
                        {
                            decoded[decoded_len++] = playseek_param[i];
                        }
                    }
                    decoded[decoded_len] = '\0';
                    free(playseek_param);
                    playseek_param = decoded;
                }
            }

            /* Remove playseek parameter from URL */
            char *playseek_param_start = strstr(query_start, "playseek=");
            char *param_to_remove_start = playseek_param_start;

            /* Check if playseek is the first parameter or not */
            if (playseek_param_start > query_start + 1)
            {
                /* playseek is not the first parameter, include preceding '&' */
                param_to_remove_start = playseek_param_start - 1; /* Point to '&' before playseek */
            }

            /* Find the end of the playseek parameter value */
            char *param_value_end = strchr(playseek_param_start, '&');
            if (param_value_end)
            {
                /* There are parameters after playseek */
                if (playseek_param_start == query_start + 1)
                {
                    /* playseek is first parameter, keep '?' and move other params */
                    memmove(query_start + 1, param_value_end + 1, strlen(param_value_end + 1) + 1);
                }
                else
                {
                    /* playseek is not first, remove including preceding '&' */
                    memmove(param_to_remove_start, param_value_end, strlen(param_value_end) + 1);
                }
            }
            else
            {
                /* playseek is the last/only parameter */
                if (playseek_param_start == query_start + 1)
                {
                    /* Remove entire query string */
                    *query_start = '\0';
                }
                else
                {
                    /* Remove just the playseek parameter and preceding '&' */
                    *param_to_remove_start = '\0';
                }
            }
        }
    }

    /* Allocate service structure */
    result = malloc(sizeof(struct services_s));
    if (!result)
    {
        logger(LOG_ERROR, "Failed to allocate memory for RTSP service");
        if (playseek_param)
            free(playseek_param);
        return NULL;
    }

    memset(result, 0, sizeof(struct services_s));
    result->service_type = SERVICE_RTSP;

    /* Build full RTSP URL */
    char rtsp_url[HTTP_URL_BUFFER_SIZE];
    /* Check if URL will fit in buffer (7 = strlen("rtsp://")) */
    if (strlen(url_part) + 7 >= sizeof(rtsp_url))
    {
        logger(LOG_ERROR, "RTSP URL too long: %zu bytes", strlen(url_part) + 7);
        if (playseek_param)
            free(playseek_param);
        free(result);
        return NULL;
    }
    snprintf(rtsp_url, sizeof(rtsp_url), "rtsp://%.1000s", url_part);

    /* Store RTSP URL and playseek parameter */
    result->rtsp_url = strdup(rtsp_url);
    if (!result->rtsp_url)
    {
        logger(LOG_ERROR, "Failed to allocate memory for RTSP URL");
        if (playseek_param)
            free(playseek_param);
        free(result);
        return NULL;
    }

    result->playseek_param = playseek_param;
    result->url = strdup(http_url); /* Store original HTTP URL for reference */
    if (!result->url)
    {
        logger(LOG_ERROR, "Failed to allocate memory for HTTP URL");
        if (playseek_param)
            free(playseek_param);
        free(result->rtsp_url);
        free(result);
        return NULL;
    }

    logger(LOG_DEBUG, "Parsed RTSP URL: %s", result->rtsp_url);
    if (result->playseek_param)
    {
        logger(LOG_DEBUG, "Parsed playseek parameter: %s", result->playseek_param);
    }

    return result;
}

/**
 * Free service structure allocated by parse functions
 * This function safely handles both dynamic and static service structures
 */
void free_service(struct services_s *service)
{
    if (!service)
    {
        return;
    }

    /* Check if this is a dynamically allocated RTSP service structure */
    if (service->service_type == SERVICE_RTSP && service->rtsp_url)
    {
        /* Free allocated strings from RTSP parsing */
        if (service->rtsp_url)
        {
            free(service->rtsp_url);
            service->rtsp_url = NULL;
        }

        if (service->playseek_param)
        {
            free(service->playseek_param);
            service->playseek_param = NULL;
        }

        if (service->url)
        {
            free(service->url);
            service->url = NULL;
        }

        /* Free the service structure itself */
        free(service);
    }
    else
    {
        /* This is a static service structure from parse_udpxy_url() */

        /* Free allocated strings from UDP/RTP parsing if any */
        if (service->msrc)
        {
            free(service->msrc);
            service->msrc = NULL;
        }

        /* Do NOT free the service structure itself as it's static */
    }
}

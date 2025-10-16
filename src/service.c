#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include "service.h"
#include "rtp2httpd.h"
#include "http.h"

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

static int parse_url_components(char *url_part, struct url_components *components)
{
    char *query_start, *at_pos;
    char main_part[HTTP_URL_MAIN_PART_SIZE];
    char fcc_value[HTTP_URL_FCC_VALUE_SIZE];

    /* Initialize components */
    memset(components, 0, sizeof(*components));

    /* URL decode the input */
    if (http_url_decode(url_part) != 0)
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
        if (http_parse_query_param(query_start, "fcc", fcc_value, sizeof(fcc_value)) == 0)
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

service_t *service_create_from_udpxy_url(char *url)
{
    service_t *serv = NULL;
    struct addrinfo *res_ai = NULL, *msrc_res_ai = NULL, *fcc_res_ai = NULL;
    struct sockaddr_storage *res_addr = NULL, *msrc_res_addr = NULL, *fcc_res_addr = NULL;

    struct url_components components;
    struct addrinfo hints, *res = NULL, *msrc_res = NULL, *fcc_res = NULL;
    char *url_part;
    char working_url[HTTP_URL_BUFFER_SIZE];
    int r = 0, rr = 0, rrr = 0;

    /* Validate input */
    if (!url || strlen(url) >= sizeof(working_url))
    {
        logger(LOG_ERROR, "Invalid or too long URL");
        return NULL;
    }

    /* Allocate service structure */
    serv = calloc(1, sizeof(service_t));
    if (!serv)
    {
        logger(LOG_ERROR, "Failed to allocate memory for service structure");
        return NULL;
    }

    /* Copy URL to avoid modifying original */
    strncpy(working_url, url, sizeof(working_url) - 1);
    working_url[sizeof(working_url) - 1] = '\0';

    /* Determine service type */
    if (strncmp(working_url, "/rtp/", 5) == 0)
    {
        serv->service_type = SERVICE_MRTP;
        url_part = working_url + 5;
    }
    else if (strncmp(working_url, "/udp/", 5) == 0)
    {
        serv->service_type = SERVICE_MUDP;
        url_part = working_url + 5;
    }
    else if (strncmp(working_url, "/rtsp/", 6) == 0)
    {
        serv->service_type = SERVICE_RTSP;
        url_part = working_url + 6;
    }
    else
    {
        free(serv);
        return NULL;
    }

    /* Handle RTSP URL parsing separately */
    if (serv->service_type == SERVICE_RTSP)
    {
        free(serv);
        return service_create_from_rtsp_url(url);
    }

    /* Parse URL components for non-RTSP services */
    if (parse_url_components(url_part, &components) != 0)
    {
        logger(LOG_ERROR, "Failed to parse URL components");
        free(serv);
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
        free(serv);
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
            free(serv);
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
            free(serv);
            return NULL;
        }
    }

    /* Warn about ambiguous addresses */
    if (res->ai_next != NULL)
    {
        logger(LOG_WARN, "Multicast address is ambiguous (multiple results)");
    }
    if (msrc_res && msrc_res->ai_next != NULL)
    {
        logger(LOG_WARN, "Source address is ambiguous (multiple results)");
    }
    if (fcc_res && fcc_res->ai_next != NULL)
    {
        logger(LOG_WARN, "FCC address is ambiguous (multiple results)");
    }

    /* Allocate and copy multicast address structures */
    res_addr = malloc(sizeof(struct sockaddr_storage));
    res_ai = malloc(sizeof(struct addrinfo));
    if (!res_addr || !res_ai)
    {
        logger(LOG_ERROR, "Failed to allocate memory for address structures");
        freeaddrinfo(res);
        if (msrc_res)
            freeaddrinfo(msrc_res);
        if (fcc_res)
            freeaddrinfo(fcc_res);
        free(res_addr);
        free(res_ai);
        free(serv);
        return NULL;
    }

    memcpy(res_addr, res->ai_addr, res->ai_addrlen);
    memcpy(res_ai, res, sizeof(struct addrinfo));
    res_ai->ai_addr = (struct sockaddr *)res_addr;
    res_ai->ai_canonname = NULL;
    res_ai->ai_next = NULL;
    serv->addr = res_ai;

    /* Set up source address */
    serv->msrc_addr = NULL;
    serv->msrc = NULL;
    if (components.has_source)
    {
        msrc_res_addr = malloc(sizeof(struct sockaddr_storage));
        msrc_res_ai = malloc(sizeof(struct addrinfo));
        if (!msrc_res_addr || !msrc_res_ai)
        {
            logger(LOG_ERROR, "Failed to allocate memory for source address structures");
            freeaddrinfo(res);
            freeaddrinfo(msrc_res);
            if (fcc_res)
                freeaddrinfo(fcc_res);
            free(msrc_res_addr);
            free(msrc_res_ai);
            free(res_addr);
            free(res_ai);
            free(serv);
            return NULL;
        }

        memcpy(msrc_res_addr, msrc_res->ai_addr, msrc_res->ai_addrlen);
        memcpy(msrc_res_ai, msrc_res, sizeof(struct addrinfo));
        msrc_res_ai->ai_addr = (struct sockaddr *)msrc_res_addr;
        msrc_res_ai->ai_canonname = NULL;
        msrc_res_ai->ai_next = NULL;
        serv->msrc_addr = msrc_res_ai;

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
        serv->msrc = strdup(source_str);
        if (!serv->msrc)
        {
            logger(LOG_ERROR, "Failed to allocate memory for source string");
            freeaddrinfo(res);
            freeaddrinfo(msrc_res);
            if (fcc_res)
                freeaddrinfo(fcc_res);
            free(msrc_res_addr);
            free(msrc_res_ai);
            free(res_addr);
            free(res_ai);
            free(serv);
            return NULL;
        }
    }
    else
    {
        serv->msrc = strdup("");
        if (!serv->msrc)
        {
            logger(LOG_ERROR, "Failed to allocate memory for empty source string");
            freeaddrinfo(res);
            if (msrc_res)
                freeaddrinfo(msrc_res);
            if (fcc_res)
                freeaddrinfo(fcc_res);
            free(res_addr);
            free(res_ai);
            free(serv);
            return NULL;
        }
    }

    /* Set up FCC address */
    serv->fcc_addr = NULL;
    if (components.has_fcc)
    {
        fcc_res_addr = malloc(sizeof(struct sockaddr_storage));
        fcc_res_ai = malloc(sizeof(struct addrinfo));
        if (!fcc_res_addr || !fcc_res_ai)
        {
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
            if (serv->msrc)
                free(serv->msrc);
            free(serv);
            return NULL;
        }

        memcpy(fcc_res_addr, fcc_res->ai_addr, fcc_res->ai_addrlen);
        memcpy(fcc_res_ai, fcc_res, sizeof(struct addrinfo));
        fcc_res_ai->ai_addr = (struct sockaddr *)fcc_res_addr;
        fcc_res_ai->ai_canonname = NULL;
        fcc_res_ai->ai_next = NULL;
        serv->fcc_addr = fcc_res_ai;
    }

    /* Free temporary addrinfo structures */
    freeaddrinfo(res);
    if (msrc_res)
        freeaddrinfo(msrc_res);
    if (fcc_res)
        freeaddrinfo(fcc_res);

    return serv;
}
static int is_valid_playseek_format(const char *playseek_value)
{
    size_t len;
    size_t digit_count;
    char *dash_pos;

    if (!playseek_value || strlen(playseek_value) == 0)
    {
        return 0;
    }

    /* Check for dash separator indicating time range */
    dash_pos = strchr(playseek_value, '-');

    if (dash_pos)
    {
        /* Time range format: begin-end */
        size_t begin_len = dash_pos - playseek_value;
        const char *end_part = dash_pos + 1;
        size_t end_len = strlen(end_part);

        /* Validate begin part */
        if (begin_len == 0)
        {
            return 0; /* Empty begin part */
        }

        digit_count = 0;
        for (size_t i = 0; i < begin_len; i++)
        {
            if (playseek_value[i] >= '0' && playseek_value[i] <= '9')
            {
                digit_count++;
            }
        }

        /* Begin part must be all digits and either <= 10 (Unix timestamp) or exactly 14 (yyyyMMddHHmmss) */
        if (digit_count != begin_len || (begin_len > 10 && begin_len != 14))
        {
            return 0;
        }

        /* Validate end part (can be empty for open-ended range) */
        if (end_len > 0)
        {
            digit_count = 0;
            for (size_t i = 0; i < end_len; i++)
            {
                if (end_part[i] >= '0' && end_part[i] <= '9')
                {
                    digit_count++;
                }
            }

            /* End part must be all digits and either <= 10 (Unix timestamp) or exactly 14 (yyyyMMddHHmmss) */
            if (digit_count != end_len || (end_len > 10 && end_len != 14))
            {
                return 0;
            }
        }

        return 1; /* Valid time range format */
    }
    else
    {
        /* Single time value (no dash) */
        len = strlen(playseek_value);
        digit_count = 0;

        for (size_t i = 0; i < len; i++)
        {
            if (playseek_value[i] >= '0' && playseek_value[i] <= '9')
            {
                digit_count++;
            }
        }

        /* Must be all digits and either <= 10 (Unix timestamp) or exactly 14 (yyyyMMddHHmmss) */
        if (digit_count == len && (len <= 10 || len == 14))
        {
            return 1;
        }

        return 0;
    }
}
service_t *service_create_from_rtsp_url(const char *http_url)
{
    service_t *result;
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

    /* Check if URL starts with rtsp:// or /rtsp/ and extract the part after prefix */
    if (strncmp(working_url, "rtsp://", 7) == 0)
    {
        /* Direct RTSP URL format: rtsp://server:port/path?query */
        url_part = working_url + 7; /* Skip "rtsp://" */
    }
    else if (strncmp(working_url, "/rtsp/", 6) == 0)
    {
        /* HTTP request format: /rtsp/server:port/path?query */
        url_part = working_url + 6; /* Skip "/rtsp/" */
    }
    else
    {
        logger(LOG_ERROR, "Invalid RTSP URL format (must start with rtsp:// or /rtsp/)");
        return NULL;
    }

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
        char *first_playseek_value = NULL;
        char *selected_playseek_value = NULL;
        char *search_pos = query_start;

        /* Iterate through all playseek parameters to find the first valid one */
        while ((playseek_start = strstr(search_pos, "playseek=")) != NULL)
        {
            /* Ensure we're at a parameter boundary (after ? or &) */
            if (playseek_start > query_start && *(playseek_start - 1) != '?' && *(playseek_start - 1) != '&')
            {
                search_pos = playseek_start + 9;
                continue;
            }

            playseek_start += 9; /* Skip "playseek=" */
            playseek_end = strchr(playseek_start, '&');
            if (!playseek_end)
            {
                playseek_end = playseek_start + strlen(playseek_start);
            }

            /* Extract this playseek parameter value */
            size_t param_len = playseek_end - playseek_start;
            char *current_value = malloc(param_len + 1);
            if (!current_value)
            {
                logger(LOG_ERROR, "Failed to allocate memory for playseek parameter");
                if (first_playseek_value)
                    free(first_playseek_value);
                if (selected_playseek_value)
                    free(selected_playseek_value);
                return NULL;
            }

            strncpy(current_value, playseek_start, param_len);
            current_value[param_len] = '\0';

            /* URL decode the parameter value */
            char *decoded = malloc(param_len + 1);
            if (!decoded)
            {
                logger(LOG_ERROR, "Failed to allocate memory for decoded playseek parameter");
                free(current_value);
                if (first_playseek_value)
                    free(first_playseek_value);
                if (selected_playseek_value)
                    free(selected_playseek_value);
                return NULL;
            }

            int decoded_len = 0;
            for (size_t i = 0; i < param_len; i++)
            {
                if (current_value[i] == '%' && i + 2 < param_len)
                {
                    /* URL decode hex characters */
                    int hex_val;
                    if (sscanf(current_value + i + 1, "%2x", &hex_val) == 1)
                    {
                        decoded[decoded_len++] = hex_val;
                        i += 2;
                    }
                    else
                    {
                        decoded[decoded_len++] = current_value[i];
                    }
                }
                else
                {
                    decoded[decoded_len++] = current_value[i];
                }
            }
            decoded[decoded_len] = '\0';
            free(current_value);

            /* Store the first playseek value as fallback */
            if (!first_playseek_value)
            {
                first_playseek_value = strdup(decoded);
            }

            /* Check if this value has valid format */
            if (!selected_playseek_value && is_valid_playseek_format(decoded))
            {
                selected_playseek_value = strdup(decoded);
                logger(LOG_DEBUG, "Found valid playseek parameter: %s", selected_playseek_value);
            }

            free(decoded);

            /* Move search position forward */
            search_pos = playseek_end;
        }

        /* Determine which playseek value to use */
        if (selected_playseek_value)
        {
            playseek_param = selected_playseek_value;
            if (first_playseek_value)
                free(first_playseek_value);
        }
        else if (first_playseek_value)
        {
            /* No valid format found, use first playseek as fallback */
            playseek_param = first_playseek_value;
            logger(LOG_DEBUG, "No valid playseek format found, using first value as fallback: %s", playseek_param);
        }

        /* Remove all playseek parameters from URL */
        if (playseek_param)
        {
            char *remove_pos = query_start;
            while ((playseek_start = strstr(remove_pos, "playseek=")) != NULL)
            {
                /* Ensure we're at a parameter boundary */
                if (playseek_start > query_start && *(playseek_start - 1) != '?' && *(playseek_start - 1) != '&')
                {
                    remove_pos = playseek_start + 9;
                    continue;
                }

                char *param_to_remove_start = playseek_start;

                /* Check if playseek is the first parameter or not */
                if (playseek_start > query_start + 1)
                {
                    /* playseek is not the first parameter, include preceding '&' */
                    param_to_remove_start = playseek_start - 1; /* Point to '&' before playseek */
                }

                /* Find the end of the playseek parameter value */
                char *param_value_end = strchr(playseek_start, '&');
                if (param_value_end)
                {
                    /* There are parameters after playseek */
                    if (playseek_start == query_start + 1)
                    {
                        /* playseek is first parameter, keep '?' and move other params */
                        memmove(query_start + 1, param_value_end + 1, strlen(param_value_end + 1) + 1);
                    }
                    else
                    {
                        /* playseek is not first, remove including preceding '&' */
                        memmove(param_to_remove_start, param_value_end, strlen(param_value_end) + 1);
                    }
                    /* Continue from the same position since we moved content */
                    remove_pos = param_to_remove_start;
                }
                else
                {
                    /* playseek is the last/only parameter */
                    if (playseek_start == query_start + 1)
                    {
                        /* Remove entire query string */
                        *query_start = '\0';
                    }
                    else
                    {
                        /* Remove just the playseek parameter and preceding '&' */
                        *param_to_remove_start = '\0';
                    }
                    break; /* No more parameters to process */
                }
            }
        }
    }

    /* Allocate service structure */
    result = malloc(sizeof(service_t));
    if (!result)
    {
        logger(LOG_ERROR, "Failed to allocate memory for RTSP service");
        if (playseek_param)
            free(playseek_param);
        return NULL;
    }

    memset(result, 0, sizeof(service_t));
    result->service_type = SERVICE_RTSP;
    result->user_agent = NULL;

    /* Build full RTSP URL */
    char rtsp_url[HTTP_URL_BUFFER_SIZE];
    /* url_part already has prefix stripped, so always prepend rtsp:// */
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

service_t *service_create_from_rtsp_with_query_merge(const service_t *configured_service,
                                                     const char *request_url)
{
    char merged_url[2048];
    char *query_start, *rtsp_query;

    /* Validate inputs */
    if (!configured_service || !request_url)
    {
        logger(LOG_ERROR, "Invalid parameters for RTSP query merge");
        return NULL;
    }

    /* Check if this is an RTSP service */
    if (configured_service->service_type != SERVICE_RTSP)
    {
        logger(LOG_ERROR, "Service is not RTSP type");
        return NULL;
    }

    /* Check if configured service has rtsp_url */
    if (!configured_service->rtsp_url)
    {
        logger(LOG_ERROR, "Configured RTSP service has no rtsp_url");
        return NULL;
    }

    /* Find query parameters in request URL */
    query_start = strchr(request_url, '?');
    if (!query_start)
    {
        /* No query params in request, no merge needed */
        return NULL;
    }

    /* Find query parameters in configured service's rtsp_url */
    rtsp_query = strchr(configured_service->rtsp_url, '?');

    if (rtsp_query)
    {
        /* Service URL already has query params - merge them */
        size_t base_len = rtsp_query - configured_service->rtsp_url;
        if (base_len >= sizeof(merged_url))
        {
            logger(LOG_ERROR, "RTSP URL too long for merging");
            return NULL;
        }

        /* Copy base URL (without query) */
        strncpy(merged_url, configured_service->rtsp_url, base_len);
        merged_url[base_len] = '\0';

        /* Append merged query params */
        if (strlen(merged_url) + strlen(rtsp_query) + strlen(query_start) < sizeof(merged_url))
        {
            strcat(merged_url, rtsp_query);      /* Existing params with '?' */
            strcat(merged_url, "&");             /* Separator */
            strcat(merged_url, query_start + 1); /* New params without '?' */
        }
        else
        {
            logger(LOG_ERROR, "Merged RTSP URL too long");
            return NULL;
        }
    }
    else
    {
        /* Service URL has no query params - just append request params */
        size_t url_len = strlen(configured_service->rtsp_url);
        size_t query_len = strlen(query_start);
        if (url_len + query_len >= sizeof(merged_url))
        {
            logger(LOG_ERROR, "RTSP URL too long for merging");
            return NULL;
        }
        memcpy(merged_url, configured_service->rtsp_url, url_len);
        memcpy(merged_url + url_len, query_start, query_len);
        merged_url[url_len + query_len] = '\0';
    }

    /* Create new service from merged URL */
    logger(LOG_DEBUG, "Creating RTSP service with merged URL: %s", merged_url);
    return service_create_from_rtsp_url(merged_url);
}

void service_free(service_t *service)
{
    if (!service)
    {
        return;
    }

    /* Free RTSP-specific fields */
    if (service->service_type == SERVICE_RTSP)
    {
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

        if (service->user_agent)
        {
            free(service->user_agent);
            service->user_agent = NULL;
        }
    }

    /* Free common fields */
    if (service->url)
    {
        free(service->url);
        service->url = NULL;
    }

    if (service->msrc)
    {
        free(service->msrc);
        service->msrc = NULL;
    }

    /* Free address structures and their embedded sockaddr */
    if (service->addr)
    {
        if (service->addr->ai_addr)
        {
            free(service->addr->ai_addr);
        }
        free(service->addr);
        service->addr = NULL;
    }

    if (service->msrc_addr)
    {
        if (service->msrc_addr->ai_addr)
        {
            free(service->msrc_addr->ai_addr);
        }
        free(service->msrc_addr);
        service->msrc_addr = NULL;
    }

    if (service->fcc_addr)
    {
        if (service->fcc_addr->ai_addr)
        {
            free(service->fcc_addr->ai_addr);
        }
        free(service->fcc_addr);
        service->fcc_addr = NULL;
    }

    /* Free the service structure itself */
    free(service);
}

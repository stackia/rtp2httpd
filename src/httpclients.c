/*
 *  RTP2HTTP Proxy - Multicast RTP stream to UNICAST HTTP translator
 *
 *  Copyright (C) 2008-2010 Ondrej Caletka <o.caletka@sh.cvut.cz>
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License version 2
 *  as published by the Free Software Foundation.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with this program (see the file COPYING included with this
 *  distribution); if not, write to the Free Software Foundation, Inc.,
 *  59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

#define _GNU_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/socket.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <signal.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "rtp2httpd.h"

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif /* HAVE_CONFIG_H */

#define BUFLEN 100
#define UDPBUFLEN 2000

static const char unimplemented[] =
"<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
"<html><head>\r\n"
"<title>501 Method Not Implemented</title>\r\n"
"</head><body>\r\n"
"<h1>501 Method Not Implemented</h1>\r\n"
"<p>Sorry, only GET is supported.</p>\r\n"
"<hr>\r\n"
"<address>Server " PACKAGE " version " VERSION "</address>\r\n"
"</body></html>\r\n";

static const char badrequest[] =
"<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
"<html><head>\r\n"
"<title>400 Bad Request</title>\r\n"
"</head><body>\r\n"
"<h1>400 Bad Request</h1>\r\n"
"<p>Your browser sent a request that this server could not understand.<br />\r\n"
"</p>\r\n"
"<hr>\r\n"
"<address>Server " PACKAGE " version " VERSION "</address>\r\n"
"</body></html>\r\n";

static const char serviceNotFound[] =
"<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
"<html><head>\r\n"
"<title>404 Service not found!</title>\r\n"
"</head><body>\r\n"
"<h1>404 Service not found!</h1>\r\n"
"<p>Sorry, this service was not configured.</p>\r\n"
"<hr>\r\n"
"<address>Server " PACKAGE " version " VERSION "</address>\r\n"
"</body></html>\r\n";

static const char serviceUnavailable[] =
"<!DOCTYPE HTML PUBLIC \"-//IETF//DTD HTML 2.0//EN\">\r\n"
"<html><head>\r\n"
"<title>503 Service Unavaliable</title>\r\n"
"</head><body>\r\n"
"<h1>503 Service Unavaliable</h1>\r\n"
"<p>Sorry, there are too many connections at this time.\r\n"
"Try again later.</p>\r\n"
"<hr>\r\n"
"<address>Server " PACKAGE " version " VERSION "</address>\r\n"
"</body></html>\r\n";

static const char *responseCodes[] = {
	"HTTP/1.1 200 OK\r\n",			/* 0 */
	"HTTP/1.1 404 Not Found\r\n",		/* 1 */
	"HTTP/1.1 400 Bad Request\r\n",		/* 2 */
	"HTTP/1.1 501 Not Implemented\r\n",	/* 3 */
	"HTTP/1.1 503 Service Unavailable\r\n",	/* 4 */
};

#define STATUS_200 0
#define STATUS_404 1
#define STATUS_400 2
#define STATUS_501 3
#define STATUS_503 4

static const char *contentTypes[] = {
	"Content-Type: application/octet-stream\r\n",	/* 0 */
	"Content-Type: text/html\r\n",		/* 1 */
	"Content-Type: text/html; charset=utf-8\r\n",	/* 2 */
	"Content-Type: video/mpeg\r\n",		/* 3 */
	"Content-Type: audio/mpeg\r\n",		/* 4 */
};

#define CONTENT_OSTREAM 0
#define CONTENT_HTML 1
#define CONTENT_HTMLUTF 2
#define CONTENT_MPEGV 3
#define CONTENT_MPEGA 4

static const char staticHeaders[] =
"Server: " PACKAGE "/" VERSION "\r\n"
"\r\n";

/*
 * Linked list of allowed services
 */

struct services_s *services = NULL;

#define RECV_STATE_INIT 0
#define RECV_STATE_FCC_REQUESTED 1
#define RECV_STATE_MCAST_REQUESTED 2
#define RECV_STATE_MCAST_ACCEPTED 3

#define FCC_PK_LEN_REQ 40
#define FCC_PK_LEN_TERM 16

/*
 * Ensures that all data are written to the socket
 */
static void writeToClient(int s,const uint8_t *buf, const size_t buflen) {
	ssize_t actual;
	size_t written=0;
	while (written<buflen) {
		actual = write(s, buf+written, buflen-written);
		if (actual <= 0) {
			exit(RETVAL_WRITE_FAILED);
		}
		written += actual;
	}
}

/*
 * Send a HTTP/1.x response header
 * @params s socket
 * @params status index to responseCodes[] array
 * @params type index to contentTypes[] array
 */
static void headers(int s, int status, int type) {
	writeToClient(s, (uint8_t*) responseCodes[status],
			strlen(responseCodes[status]));
	writeToClient(s, (uint8_t*) contentTypes[type],
			strlen(contentTypes[type]));
	writeToClient(s, (uint8_t*) staticHeaders,
			sizeof(staticHeaders)-1);
}


void sigpipe_handler(int signum) {
	exit(RETVAL_WRITE_FAILED);
}

/**
 * Parses URL in UDPxy format, i.e. /rtp/<maddr>:port
 * returns a pointer to statically alocated service struct if success,
 * NULL otherwise.
 */

static struct services_s* udpxy_parse(char* url) {
	static struct services_s serv;
	static struct addrinfo res_ai, msrc_res_ai, fcc_res_ai;
	static struct sockaddr_storage res_addr, msrc_res_addr, fcc_res_addr;

	char *addrstr, *portstr, *msrc="", *msaddr="", *msport="", *fccaddr, *fccport;
	int i, r, rr, rrr;
	char c;
	struct addrinfo hints, *res, *msrc_res, *fcc_res;


	if (strncmp("/rtp/", url, 5) == 0)
		serv.service_type = SERVICE_MRTP;
	else if (strncmp("/udp/", url, 5) == 0)
		serv.service_type = SERVICE_MUDP;
	else
		return NULL;
	addrstr = rindex(url, '/');
	if (!addrstr)
		return NULL;
	/* Decode URL encoded strings */
	for (i=0; i<(strlen(addrstr)-2); i++) {
		if (addrstr[i] == '%' &&
		    sscanf(addrstr+i+1, "%2hhx", (unsigned char *) &c) >0 ) {
			addrstr[i] = c;
			memmove(addrstr+i+1, addrstr+i+3, 1+strlen(addrstr+i+3));
		}
	}
	logger(LOG_DEBUG, "decoded addr: %s\n", addrstr);
	fccaddr = rindex(addrstr, '?');
	if (fccaddr) {
		*fccaddr = '\0';
		fccaddr++;
		fccaddr = strcasestr(fccaddr, "fcc=");
		if (fccaddr) {
			fccaddr += 4;
			fccport = rindex(fccaddr, ':');
			if (fccport) {
				*fccport = '\0';
				fccport++;
			}
		}
	} else {
		fccaddr = "";
	}
	if (!fccport) {
		fccport = "";
	}
	if (addrstr[1] == '[') {
		portstr = index(addrstr, ']');
		addrstr += 2;
		if (portstr) {
			*portstr = '\0';
			portstr = rindex(++portstr, ':');
		}
	} else {
		portstr = rindex(addrstr++, ':');
	}

	if (strstr(addrstr, "@") != NULL) {
		char *split;
		char *current;
		int cnt = 0;
		split = strtok(addrstr, "@");
		while (split != NULL) {
			current = split;
			if (cnt == 0) msrc = current;
			split = strtok(NULL, "@");
			if (cnt > 0 && split != NULL) {
				strcat(msrc, "@");
				strcat(msrc, current);
			}
			if (cnt > 0 && split == NULL) addrstr = current;
			cnt++;
		}

		cnt = 0;
		msaddr = msrc;
		split = strtok(msrc, ":");
		while (split != NULL) {
			current = split;
			if (cnt == 0) msaddr = current;
			split = strtok(NULL, ":");
			if (cnt > 0 && split != NULL) {
				strcat(msaddr, ":");
				strcat(msaddr, current);
			}
			if (cnt > 0 && split == NULL) msport = current;
			cnt++;
		}
	}

	if (portstr) {
		*portstr = '\0';
		portstr++;
	} else
		portstr = "1234";

	logger(LOG_DEBUG, "addrstr: %s portstr: %s msrc: %s fccaddr: %s fccport: %s\n", addrstr, portstr, msrc, fccaddr, fccport);

	memset(&hints, 0, sizeof(hints));
	hints.ai_socktype = SOCK_DGRAM;
	r = getaddrinfo(addrstr, portstr, &hints, &res);
	rr = 0;
	rrr = 0;
	if (strcmp(msrc, "") != 0 && msrc != NULL) {
		rr = getaddrinfo(msrc, 0, &hints, &msrc_res);
	}
	if (strcmp(fccaddr, "") != 0 && fccaddr != NULL) {
		rrr = getaddrinfo(fccaddr, fccport, &hints, &fcc_res);
	}
	if (r | rr | rrr) {
		if (r) {
			logger(LOG_ERROR, "Cannot resolve Multicast address. GAI: %s\n",
				   gai_strerror(r));
		}
		if (rr) {
			logger(LOG_ERROR, "Cannot resolve Multicast source address. GAI: %s\n",
				   gai_strerror(rr));
		}
		if (rrr) {
			logger(LOG_ERROR, "Cannot resolve FCC server address. GAI: %s\n",
				   gai_strerror(rrr));
		}

		free(msrc); msrc = NULL;
		return NULL;
	}
	if (res->ai_next != NULL) {
		logger(LOG_ERROR, "Warning: maddr is ambiguos.\n");
	}
	if (strcmp(msrc, "") != 0 && msrc != NULL) {
		if (msrc_res->ai_next != NULL) {
			logger(LOG_ERROR, "Warning: msrc is ambiguos.\n");
		}
	}
  if (strcmp(fccaddr, "") != 0 && fccaddr != NULL) {
		if (fcc_res->ai_next != NULL) {
			logger(LOG_ERROR, "Warning: fcc is ambiguos.\n");
		}
	}

	/* Copy result into statically allocated structs */
	memcpy(&res_addr, res->ai_addr, res->ai_addrlen);
	memcpy(&res_ai, res, sizeof(struct addrinfo));
	res_ai.ai_addr = (struct sockaddr*) &res_addr;
	res_ai.ai_canonname = NULL;
	res_ai.ai_next = NULL;
	serv.addr = &res_ai;

  serv.msrc_addr = NULL;
	if (strcmp(msrc, "") != 0 && msrc != NULL) {
		/* Copy result into statically allocated structs */
		memcpy(&msrc_res_addr, msrc_res->ai_addr, msrc_res->ai_addrlen);
		memcpy(&msrc_res_ai, msrc_res, sizeof(struct addrinfo));
		msrc_res_ai.ai_addr = (struct sockaddr*) &msrc_res_addr;
		msrc_res_ai.ai_canonname = NULL;
		msrc_res_ai.ai_next = NULL;
		serv.msrc_addr = &msrc_res_ai;
	}

	serv.msrc = strdup(msrc);

	serv.fcc_addr = NULL;
	if (strcmp(fccaddr, "") != 0 && fccaddr != NULL) {
		/* Copy result into statically allocated structs */
		memcpy(&fcc_res_addr, fcc_res->ai_addr, fcc_res->ai_addrlen);
		memcpy(&fcc_res_ai, fcc_res, sizeof(struct addrinfo));
		fcc_res_ai.ai_addr = (struct sockaddr*) &fcc_res_addr;
		fcc_res_ai.ai_canonname = NULL;
		fcc_res_ai.ai_next = NULL;
		serv.fcc_addr = &fcc_res_ai;
	}

	return &serv;
}

static int join_mcast_group(struct services_s *service) {
	struct group_req gr;
	struct group_source_req gsr;
	int sock, r, level;
	int on = 1;

	sock = socket(service->addr->ai_family, service->addr->ai_socktype,
			service->addr->ai_protocol);
        r = setsockopt(sock, SOL_SOCKET,
                        SO_REUSEADDR, &on, sizeof(on));
        if (r) {
                logger(LOG_ERROR, "SO_REUSEADDR "
                "failed: %s\n", strerror(errno));
        }

	r = bind(sock,(struct sockaddr *) service->addr->ai_addr, service->addr->ai_addrlen);
	if (r) {
		logger(LOG_ERROR, "Cannot bind: %s\n",
				strerror(errno));
		exit(RETVAL_RTP_FAILED);
	}

	memcpy(&(gr.gr_group), service->addr->ai_addr, service->addr->ai_addrlen);

	switch (service->addr->ai_family) {
		case AF_INET:
			level = SOL_IP;
			gr.gr_interface = 0;
			break;

		case AF_INET6:
			level = SOL_IPV6;
			gr.gr_interface = ((const struct sockaddr_in6 *)
				(service->addr->ai_addr))->sin6_scope_id;
			break;
		default:
			logger(LOG_ERROR, "Address family don't support mcast.\n");
			exit(RETVAL_SOCK_READ_FAILED);
	}

	if (strcmp(service->msrc, "") != 0 && service->msrc != NULL) {
		gsr.gsr_group = gr.gr_group;
		gsr.gsr_interface = gr.gr_interface;
		memcpy(&(gsr.gsr_source), service->msrc_addr->ai_addr, service->msrc_addr->ai_addrlen);
		r = setsockopt(sock, level,
			MCAST_JOIN_SOURCE_GROUP, &gsr, sizeof(gsr));
	} else {
		r = setsockopt(sock, level,
			MCAST_JOIN_GROUP, &gr, sizeof(gr));
	}

	if (r) {
		logger(LOG_ERROR, "Cannot join mcast group: %s\n",
				strerror(errno));
		exit(RETVAL_RTP_FAILED);
	}

	return sock;
}

static uint8_t* build_fcc_request_pk(struct addrinfo *maddr, uint16_t fcc_client_nport) {
	struct sockaddr_in *maddr_sin = (struct sockaddr_in *)
	maddr->ai_addr;

	static uint8_t pk[FCC_PK_LEN_REQ];
	memset(&pk, 0, sizeof(pk));
	uint8_t *p = pk;
	*(p++) = 0x82; // Version 2, Padding 0, FMT 2
	*(p++) = 205; // Type: Generic RTP Feedback (205)
	*(uint16_t*)p = htons(sizeof(pk)/4 - 1); // Length
	p += 2;
	p += 4; // Sender SSRC
	*(uint32_t*)p = maddr_sin->sin_addr.s_addr; // Media source SSRC
	p += 4;

	// FCI
	p += 4; // Version 0, Reserved 3 bytes
	*(uint16_t*)p = fcc_client_nport; // FCC client port
	p += 2;
	*(uint16_t*)p = maddr_sin->sin_port; // Mcast group port
	p += 2;
	*(uint32_t*)p = maddr_sin->sin_addr.s_addr; // Mcast group IP
	p += 4;

	return pk;
}

static int get_gw_ip(in_addr_t *addr) {
	long destination, gateway;
	char buf[4096];
	FILE * file;

	memset(buf, 0, sizeof(buf));

	file = fopen("/proc/net/route", "r");
	if (!file) {
		return -1;
	}

	while (fgets(buf, sizeof(buf), file)) {
		if (sscanf(buf, "%*s %lx %lx", &destination, &gateway) == 2) {
			if (destination == 0) { /* default */
				*addr = gateway;
				fclose(file);
				return 0;
			}
		}
	}

	/* default route not found */
	if (file)
		fclose(file);
	return -1;
}

static uint16_t nat_pmp(uint16_t nport, uint32_t lifetime) {
	struct sockaddr_in gw_addr = { .sin_family = AF_INET, .sin_port = htons(5351) };
	uint8_t pk[12];
	uint8_t buf[16];
	struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };

	if (get_gw_ip(&gw_addr.sin_addr.s_addr) < 0) return 0;
	int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof tv);
	pk[0] = 0; // Version
	pk[1] = 1; // UDP
	*(uint16_t*)(pk+2) = 0; // Reserved
	*(uint16_t*)(pk+4) = nport; // Private port
	*(uint16_t*)(pk+6) = 0; // Public port
	*(uint32_t*)(pk+8) = htonl(lifetime);
  sendto(sock, pk, sizeof(pk), 0, &gw_addr, sizeof(gw_addr));
	if (recv(sock, buf, sizeof(buf), 0) > 0) {
		if (*(uint16_t*)(buf+2) == 0) { // Result code
		  close(sock);
			return *(uint16_t*)(buf+10); // Mapped public port
		}
	}
	close(sock);
	return 0;
}

static uint8_t* build_fcc_term_pk(struct addrinfo *maddr, uint16_t seqn) {
	struct sockaddr_in *maddr_sin = (struct sockaddr_in *)maddr->ai_addr;

	static uint8_t pk[FCC_PK_LEN_TERM];
	memset(&pk, 0, sizeof(pk));
	uint8_t *p = pk;
	*(p++) = 0x85; // Version 2, Padding 0, FMT 5
	*(p++) = 205; // Type: Generic RTP Feedback (205)
	*(uint16_t*)p = htons(sizeof(pk)/4 - 1); // Length
	p += 2;
	p += 4; // Sender SSRC
	*(uint32_t*)p = maddr_sin->sin_addr.s_addr; // Media source SSRC
	p += 4;

	// FCI
	*(p++) = seqn ? 0 : 1; // Stop bit, 0 = normal, 1 = force
	p++; // Reserved
	*(uint16_t*)p = htons(seqn); // First multicast packet sequence
	p += 2;

	return pk;
}

static int get_rtp_payload(uint8_t *buf, int recv_len, uint8_t **payload, int *size) {
	int payloadstart, payloadlength;

	if (recv_len < 12 || (buf[0]&0xC0) != 0x80) {
		/*malformed RTP/UDP/IP packet*/
		logger(LOG_DEBUG,"Malformed RTP packet received\n");
		return -1;
	}

	payloadstart = 12; /* basic RTP header length */
	payloadstart += (buf[0]&0x0F) * 4; /*CRSC headers*/
	if (buf[0]&0x10) { /*Extension header*/
		payloadstart += 4 + 4*ntohs(*((uint16_t *)(buf+payloadstart+2)));
	}
	payloadlength = recv_len - payloadstart;
	if (buf[0]&0x20) { /*Padding*/
		payloadlength -= buf[recv_len];
		/*last octet indicate padding length*/
	}
	if(payloadlength<0) {
		logger(LOG_DEBUG,"Malformed RTP packet received\n");
		return -1;
	}

	*payload = buf+payloadstart;
	*size = payloadlength;
	return 0;
}

static void write_rtp_payload_to_client(int client, int recv_len, uint8_t *buf, uint16_t *oldseqn, uint16_t *notfirst) {
	int payloadlength;
	uint8_t *payload;
	uint16_t seqn;

	get_rtp_payload(buf, recv_len, &payload, &payloadlength);

	seqn = ntohs(*(uint16_t *)(buf+2));
	if (*notfirst && seqn==*oldseqn) {
		logger(LOG_DEBUG,"Duplicated RTP packet "
			"received (seqn %d)\n", seqn);
		return;
	}
	if (*notfirst && (seqn != ((*oldseqn+1)&0xFFFF))) {
		logger(LOG_DEBUG,"Congestion - expected %d, "
			"received %d\n", (*oldseqn+1)&0xFFFF, seqn);
	}
	*oldseqn=seqn;
	*notfirst=1;

	writeToClient(client, payload, payloadlength);
}

static ssize_t sendto_triple(int __fd, const void *__buf, size_t __n,
	int __flags, __CONST_SOCKADDR_ARG __addr, socklen_t __addr_len) {
	static uint8_t i;
	for (i = 0; i < 3; i++) {
		if (sendto(__fd, __buf, __n, __flags, __addr, __addr_len) < 0) {
			return -1;
		}
	}
	return __n;
}

static void fcc_cleanup(int fcc_sock, struct sockaddr_in *fcc_server, struct services_s *service, uint16_t mapped_pub_port, struct sockaddr_in *fcc_client) {
	if (fcc_sock)
		sendto_triple(fcc_sock, build_fcc_term_pk(service->addr, 0), FCC_PK_LEN_TERM, 0, fcc_server, sizeof(*fcc_server));
	if (mapped_pub_port)
		nat_pmp(fcc_client->sin_port, 0);
}

static void startRTPstream(int client, struct services_s *service){
	int recv_state = RECV_STATE_INIT;
	int mcast_sock = 0, fcc_sock = 0, max_sock;
	int r;
	struct sockaddr_in *fcc_server;
	struct sockaddr_in fcc_client;
	struct sockaddr_in peer_addr;
	socklen_t slen = sizeof(peer_addr);
	uint8_t buf[UDPBUFLEN];
	uint8_t *mcast_pending_buf = NULL, *mcast_pbuf_c, *rtp_payload, mcast_pbuf_full;
	uint mcast_pbuf_len;
	int actualr;
	uint16_t mapped_pub_port = 0, media_port = 0, seqn, mcast_pbuf_lsqen, notfirst=0, fcc_term_sent = 0, fcc_term_seqn = 0;
	int payloadlength;
	fd_set rfds;
	struct timeval timeout;

	void sig_handler(int signum) {
		fcc_cleanup(fcc_sock, fcc_server, service, mapped_pub_port, &fcc_client);
		if (signum) exit(RETVAL_CLEAN);
	}

	void exit_handler() {
		sig_handler(0);
	}

	atexit(exit_handler);
	signal(SIGTERM, sig_handler);
	signal(SIGINT, sig_handler);
	signal(SIGPIPE, sig_handler);

	while(1) {
		if (recv_state == RECV_STATE_INIT) {
			if (service->service_type == SERVICE_MRTP && service->fcc_addr) {
				struct sockaddr_in sin;
				if (!fcc_sock) {
					fcc_sock = socket(AF_INET, service->fcc_addr->ai_socktype, service->fcc_addr->ai_protocol);
					sin.sin_family = AF_INET;
					sin.sin_addr.s_addr = INADDR_ANY;
					sin.sin_port = 0;
					r = bind(fcc_sock, (struct sockaddr *)&sin, sizeof(sin));
					if (r) {
						logger(LOG_ERROR, "Cannot bind: %s\n", strerror(errno));
						exit(RETVAL_RTP_FAILED);
					}
					slen = sizeof(fcc_client);
					getsockname(fcc_sock, (struct sockaddr *)&fcc_client, &slen);
					mapped_pub_port = nat_pmp(fcc_client.sin_port, 86400);
					logger(LOG_DEBUG, "NAT PMP result: %u\n", ntohs(mapped_pub_port));
					fcc_server = (struct sockaddr_in*) service->fcc_addr->ai_addr;
				}
				r = sendto_triple(fcc_sock, build_fcc_request_pk(service->addr, mapped_pub_port ? mapped_pub_port : fcc_client.sin_port), FCC_PK_LEN_REQ, 0, fcc_server, sizeof(*fcc_server));
				if (r < 0){
					logger(LOG_ERROR, "Unable to send FCC req message: %s\n", strerror(errno));
					exit(RETVAL_RTP_FAILED);
    		}
				logger(LOG_DEBUG, "FCC server requested.\n");
				recv_state = RECV_STATE_FCC_REQUESTED;
			} else {
				mcast_sock = join_mcast_group(service);
				recv_state = RECV_STATE_MCAST_ACCEPTED;
			}
		} else {
			FD_ZERO(&rfds);
			max_sock = client;
			FD_SET(client, &rfds); /* Will be set if connection to client lost.*/
			if (fcc_sock && recv_state != RECV_STATE_MCAST_ACCEPTED) {
				FD_SET(fcc_sock, &rfds);
				if (fcc_sock > max_sock) max_sock = fcc_sock;
			}
			if (mcast_sock && recv_state != RECV_STATE_FCC_REQUESTED) {
				FD_SET(mcast_sock, &rfds);
				if (mcast_sock > max_sock) max_sock = mcast_sock;
			}
			timeout.tv_sec = 5;
			timeout.tv_usec = 0;

			/* We use select to get rid of recv stuck if
			* multicast group is unoperated.
			*/
			r=select(max_sock+1, &rfds, NULL, NULL, &timeout);
			if (r<0 && errno==EINTR) {
				continue;
			}
			if (r==0) { /* timeout reached */
				exit(RETVAL_SOCK_READ_FAILED);
			}
			if (FD_ISSET(client, &rfds)) { /* client written stg, or conn. lost	 */
				exit(RETVAL_WRITE_FAILED);
			} else if (fcc_sock && FD_ISSET(fcc_sock, &rfds)) {
				actualr = recvfrom(fcc_sock, buf, sizeof(buf), 0, &peer_addr, &slen);
				if (actualr < 0){
					logger(LOG_ERROR, "FCC recv failed: %s\n", strerror(errno));
					continue;
				}
				if (peer_addr.sin_addr.s_addr != fcc_server->sin_addr.s_addr) {
					continue;
				}
				if (peer_addr.sin_port == fcc_server->sin_port) { // RTCP signal command
					if (buf[1] != 205) {
						logger(LOG_DEBUG, "Unrecognized FCC payload type: %u\n", buf[1]);
						continue;
					}
					if (buf[0] == 0x83) { // FMT 3
						if (buf[12] != 0) { // Result not success
							logger(LOG_DEBUG, "FCC (FMT 3) gives an error result code: %u\n", buf[12]);
							mcast_sock = join_mcast_group(service);
							recv_state = RECV_STATE_MCAST_ACCEPTED;
							continue;
						}
						uint16_t new_signal_port = *(uint16_t*)(buf+14);
						int signal_port_changed = 0, media_port_changed = 0;
						if (new_signal_port && new_signal_port != fcc_server->sin_port) {
							logger(LOG_DEBUG, "FCC (FMT 3) gives a new signal port: %u\n", ntohs(new_signal_port));
							fcc_server->sin_port = new_signal_port;
							signal_port_changed = 1;
						}
						uint16_t new_media_port = *(uint16_t*)(buf+16);
						if (new_media_port && new_media_port != media_port) {
							media_port = new_media_port;
							logger(LOG_DEBUG, "FCC (FMT 3) gives a new media port: %u\n", ntohs(new_media_port));
							media_port_changed = 1;
						}
						uint32_t new_fcc_ip = *(uint32_t*)(buf+20);
						if (new_fcc_ip && new_fcc_ip != fcc_server->sin_addr.s_addr) {
							fcc_server->sin_addr.s_addr = new_fcc_ip;
							logger(LOG_DEBUG, "FCC (FMT 3) gives a new FCC ip: %s\n", inet_ntoa(fcc_server->sin_addr));
							signal_port_changed = 1;
							media_port_changed = 1;
						}
						if (buf[13] == 3) { // Redirect to new FCC server
							logger(LOG_DEBUG, "FCC (FMT 3) requests a redirection to a new server\n");
							recv_state = RECV_STATE_INIT;
						} else if (buf[13] != 2) { // Join mcast group instantly
							logger(LOG_DEBUG, "FCC (FMT 3) requests immediate mcast join, code: %u\n", buf[13]);
							mcast_sock = join_mcast_group(service);
							recv_state = RECV_STATE_MCAST_ACCEPTED;
						} else {
							// Send empty packet to make NAT happy
							if (!mapped_pub_port && media_port_changed && media_port) {
								struct sockaddr_in sintmp = *fcc_server;
								sintmp.sin_port = media_port;
								sendto_triple(fcc_sock, NULL, 0, 0, &sintmp, sizeof(sintmp));
								logger(LOG_DEBUG, "Tried to setup NAT passthrough for media port %u\n", media_port);
							}
							if (!mapped_pub_port && signal_port_changed) {
								sendto_triple(fcc_sock, NULL, 0, 0, fcc_server, sizeof(*fcc_server));
								logger(LOG_DEBUG, "Tried to setup NAT passthrough for signal port %u\n", fcc_server->sin_port);
							}
							logger(LOG_DEBUG, "FCC server accepted the req.\n");
						}
					} else if (buf[0] == 0x84) { // FMT 4
						logger(LOG_DEBUG, "FCC (FMT 4) indicates we can now join mcast\n");
						mcast_sock = join_mcast_group(service);
						recv_state = RECV_STATE_MCAST_REQUESTED;
					}
				} else if (peer_addr.sin_port == media_port) { // RTP media packet
					write_rtp_payload_to_client(client, actualr, buf, &seqn, &notfirst);
					if (fcc_term_sent && seqn >= fcc_term_seqn - 1) {
						recv_state = RECV_STATE_MCAST_ACCEPTED;
					}
				}
			} else if (mcast_sock && FD_ISSET(mcast_sock, &rfds)) {
				actualr = recv(mcast_sock, buf, sizeof(buf), 0);
				if (actualr < 0){
					logger(LOG_DEBUG, "Mcast recv fail: %s", strerror(errno));
					continue;
				}
				if (service->service_type == SERVICE_MUDP) {
					writeToClient(client, buf, sizeof(buf));
					continue;
				}
				if (recv_state == RECV_STATE_MCAST_ACCEPTED) {
					if (mcast_pending_buf) {
						writeToClient(client, mcast_pending_buf, mcast_pbuf_len);
						free(mcast_pending_buf); mcast_pending_buf = NULL;
						seqn = mcast_pbuf_lsqen;
						logger(LOG_DEBUG, "Flushed mcast pending buffer to client. Term seqn: %u, mcast pending buffer last sqen: %u\n", fcc_term_seqn, mcast_pbuf_lsqen);
					}
					write_rtp_payload_to_client(client, actualr, buf, &seqn, &notfirst);
				} else if (recv_state == RECV_STATE_MCAST_REQUESTED) {
					mcast_pbuf_lsqen = ntohs(*(uint16_t *)(buf+2));
					if (!fcc_term_sent) {
						fcc_term_seqn = mcast_pbuf_lsqen;
						r = sendto_triple(fcc_sock, build_fcc_term_pk(service->addr, fcc_term_seqn + 2), FCC_PK_LEN_TERM, 0, fcc_server, sizeof(*fcc_server));
						if (r < 0){
							logger(LOG_ERROR, "Unable to send FCC termination message: %s\n", strerror(errno));
						}
						mcast_pbuf_len = (max(fcc_term_seqn - seqn, 10) + 10) * 2000;
						mcast_pending_buf = malloc(mcast_pbuf_len);
						mcast_pbuf_c = mcast_pending_buf;
						mcast_pbuf_full = 0;
						fcc_term_sent = 1;
						logger(LOG_DEBUG, "FCC term message sent. Mcast pending buffer size: %u\n", mcast_pbuf_len);
					}
					if (mcast_pbuf_full) continue;
					if (get_rtp_payload(buf, actualr, &rtp_payload, &payloadlength) < 0) {
						continue;
					}
					if (mcast_pbuf_c + payloadlength > mcast_pending_buf + mcast_pbuf_len) {
						logger(LOG_ERROR, "Mcast pending buffer is full, video quality may suffer.\n", strerror(errno));
						mcast_pbuf_full = 1;
						continue;
					}
					memcpy(mcast_pbuf_c, rtp_payload, payloadlength);
					mcast_pbuf_c += payloadlength;
				}
			}
		}
	}

	/*SHOULD NEVER REACH THIS*/
	return;
}

/*
 * Service for connected client.
 * Run in forked thread.
 */
void clientService(int s) {
	char buf[BUFLEN];
	FILE *client;
	int numfields;
	char *method, *url, httpver;
	char *hostname;
	char *urlfrom;
	struct services_s *servi;

	signal(SIGPIPE, &sigpipe_handler);

	client = fdopen(s, "r");
	/*read only one line*/
	if (fgets(buf, sizeof(buf), client) == NULL) {
		exit(RETVAL_READ_FAILED);
	}
	numfields = sscanf(buf,"%ms %ms %c", &method, &url, &httpver);
	if(numfields<2) {
		logger(LOG_DEBUG, "Non-HTTP input.\n");
	}
	logger(LOG_INFO,"request: %s %s \n", method, url);

	if(numfields == 3) { /* Read and discard all headers before replying */
		while(fgets(buf, sizeof(buf), client) != NULL &&
		      strcmp("\r\n", buf) != 0) {
			if (strncasecmp("Host: ", buf, 6) == 0) {
				hostname = strpbrk(buf+6, ":\r\n");
				if (hostname)
					hostname = strndup(buf+6, hostname-buf-6);
					logger(LOG_DEBUG, "Host header: %s\n", hostname);
				}
			}
		}

	if (strcmp(method, "GET") != 0 && strcmp(method, "HEAD") != 0) {
		if (numfields == 3)
			headers(s, STATUS_501, CONTENT_HTML);
		writeToClient(s, (uint8_t*) unimplemented, sizeof(unimplemented)-1);
		exit(RETVAL_UNKNOWN_METHOD);
	}

	urlfrom = rindex(url, '/');
	if (urlfrom == NULL || (conf_hostname && strcasecmp(conf_hostname, hostname)!=0)) {
		if (numfields == 3)
			headers(s, STATUS_400, CONTENT_HTML);
		writeToClient(s, (uint8_t*) badrequest, sizeof(badrequest)-1);
		exit(RETVAL_BAD_REQUEST);
	}

	for (servi = services; servi; servi=servi->next) {
		if (strcmp(urlfrom+1, servi->url) == 0)
			break;
	}

	if (servi == NULL && conf_udpxy)
		servi = udpxy_parse(url);

	free(url); url=NULL;

	if (servi == NULL) {
		if (numfields == 3)
			headers(s, STATUS_404, CONTENT_HTML);
		writeToClient(s, (uint8_t*) serviceNotFound, sizeof(serviceNotFound)-1);
		exit(RETVAL_CLEAN);
	}

	if (clientcount > conf_maxclients) { /*Too much clients*/
		if (numfields == 3)
			headers(s, STATUS_503, CONTENT_HTML);
		writeToClient(s, (uint8_t*) serviceUnavailable, sizeof(serviceUnavailable)-1);
		exit(RETVAL_CLEAN);
	}

	if (strcmp(method, "HEAD") == 0) {
		if (numfields == 3)
			headers(s, STATUS_200, CONTENT_OSTREAM);
		exit(RETVAL_CLEAN);
	}
	free(method); method=NULL;

	if (numfields == 3)
		headers(s, STATUS_200, CONTENT_OSTREAM);
	startRTPstream(s, servi);
	/* SHOULD NEVER REACH HERE */
	exit(RETVAL_CLEAN);
}

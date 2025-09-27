
bin_PROGRAMS = rtp2httpd

rtp2httpd_SOURCES = rtp2httpd.c httpclients.c configuration.c \
		    http.c rtp.c multicast.c fcc.c stream.c

noinst_HEADERS = rtp2httpd.h http.h rtp.h multicast.h fcc.h stream.h

AM_CFLAGS= -DSYSCONFDIR=\"@sysconfdir@\"


# Main program
bin_PROGRAMS = rtp2httpd

# Program sources
rtp2httpd_SOURCES = \
	rtp2httpd.c \
	httpclients.c \
	configuration.c \
	http.c \
	rtp.c \
	multicast.c \
	fcc.c \
	stream.c \
	rtsp.c

# Private headers (not installed)
noinst_HEADERS = \
	rtp2httpd.h \
	configuration.h \
	httpclients.h \
	http.h \
	rtp.h \
	multicast.h \
	fcc.h \
	stream.h \
	rtsp.h

# Compiler flags
AM_CPPFLAGS = -DSYSCONFDIR=\"@sysconfdir@\"
AM_CFLAGS = @WARN_CFLAGS@ @SECURITY_CFLAGS@

# Link with required libraries
rtp2httpd_LDADD = 

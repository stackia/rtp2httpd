
# Main program
bin_PROGRAMS = rtp2httpd

# Program sources
rtp2httpd_SOURCES = \
	rtp2httpd.c \
	configuration.c \
	http.c \
	service.c \
	rtp.c \
	multicast.c \
	fcc.c \
	stream.c \
	rtsp.c \
	snapshot.c \
	timezone.c \
	status.c \
	connection.c \
	worker.c \
	buffer_pool.c \
	zerocopy.c

# Private headers (not installed)
noinst_HEADERS = \
	rtp2httpd.h \
	configuration.h \
	http.h \
	service.h \
	rtp.h \
	multicast.h \
	fcc.h \
	stream.h \
	rtsp.h \
	snapshot.h \
	timezone.h \
	status.h \
	status_page.h \
	connection.h \
	worker.h \
	buffer_pool.h \
	zerocopy.h

# Compiler flags
AM_CPPFLAGS = -DSYSCONFDIR=\"@sysconfdir@\"
AM_CFLAGS = @OPT_CFLAGS@ @WARN_CFLAGS@ @SECURITY_CFLAGS@

# Linker flags
AM_LDFLAGS = @SECURITY_LDFLAGS@

# Link with required libraries
rtp2httpd_LDADD = -lpthread -lrt

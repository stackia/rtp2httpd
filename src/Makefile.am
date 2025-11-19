
# Main program
bin_PROGRAMS = rtp2httpd

# Program sources
rtp2httpd_SOURCES = \
	rtp2httpd.c \
	configuration.c \
	http.c \
	http_fetch.c \
	service.c \
	rtp.c \
	multicast.c \
	fcc.c \
	fcc_telecom.c \
	fcc_huawei.c \
	stream.c \
	rtsp.c \
	snapshot.c \
	timezone.c \
	status.c \
	connection.c \
	worker.c \
	buffer_pool.c \
	zerocopy.c \
	m3u.c \
	epg.c \
	md5.c \
	hashmap.c \
	embedded_web.c \
	utils.c

# Private headers (not installed)
noinst_HEADERS = \
	rtp2httpd.h \
	configuration.h \
	http.h \
	http_fetch.h \
	service.h \
	rtp.h \
	multicast.h \
	fcc.h \
	fcc_telecom.h \
	fcc_huawei.h \
	stream.h \
	rtsp.h \
	snapshot.h \
	timezone.h \
	status.h \
	connection.h \
	worker.h \
	buffer_pool.h \
	zerocopy.h \
	m3u.h \
	epg.h \
	md5.h \
	hashmap.h \
	embedded_web.h \
	embedded_web_data.h \
	utils.h

# Compiler flags
AM_CPPFLAGS = -DSYSCONFDIR=\"@sysconfdir@\" -include config.h
AM_CFLAGS = @OPT_CFLAGS@ @WARN_CFLAGS@ @SECURITY_CFLAGS@

# Linker flags
AM_LDFLAGS = @SECURITY_LDFLAGS@

# Link with required libraries
rtp2httpd_LDADD = -lpthread -lrt

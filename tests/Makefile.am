if HAVE_CHECK

# Test programs to run
TESTS = check_http check_rtsp_logic check_rtsp_integration check_timezone \
        check_status check_httpclients check_stream check_rtp check_fcc
check_PROGRAMS = check_http check_rtsp_logic check_rtsp_integration check_timezone \
                 check_status check_httpclients check_stream check_rtp check_fcc

# HTTP Test program sources and flags
check_http_SOURCES = check_http.c \
                     test_mocks.c \
                     $(top_srcdir)/src/http.c
check_http_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_http_LDADD = @CHECK_LIBS@

noinst_HEADERS = mock_rtsp.h

# RTSP Logic Test program sources and flags (pure logic, no mocks)
check_rtsp_logic_SOURCES = check_rtsp_logic.c \
                           test_mocks.c \
                           test_rtsp_mocks.c \
                           $(top_srcdir)/src/rtsp.c \
                           $(top_srcdir)/src/timezone.c
check_rtsp_logic_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_rtsp_logic_LDADD = @CHECK_LIBS@

# RTSP Integration Test program sources and flags
check_rtsp_integration_SOURCES = check_rtsp_integration.c \
                                 test_rtsp_mocks.c \
                                 test_mocks.c \
                                 $(top_srcdir)/src/rtsp.c \
                                 $(top_srcdir)/src/timezone.c
check_rtsp_integration_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_rtsp_integration_LDADD = @CHECK_LIBS@

# Timezone Test program sources and flags
check_timezone_SOURCES = check_timezone.c \
                         $(top_srcdir)/src/timezone.c
# Status module tests
check_status_SOURCES = check_status.c \
                       test_mocks.c \
                       $(top_srcdir)/src/status.c \
                       $(top_srcdir)/src/http.c
check_status_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_status_LDADD = @CHECK_LIBS@

# HTTP clients routing tests
check_httpclients_SOURCES = check_httpclients.c \
                            test_mocks.c \
                            $(top_srcdir)/src/httpclients.c \
                            $(top_srcdir)/src/status.c \
                            $(top_srcdir)/src/http.c
check_httpclients_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_httpclients_LDADD = @CHECK_LIBS@

# Stream related tests (minimal, now includes runtime error path test)
check_stream_SOURCES = check_stream.c \
                       test_mocks.c \
                       $(top_srcdir)/src/stream.c \
                       $(top_srcdir)/src/rtp.c \
                       $(top_srcdir)/src/status.c \
                       $(top_srcdir)/src/http.c
check_stream_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_stream_LDADD = @CHECK_LIBS@
# RTP tests
check_rtp_SOURCES = check_rtp.c \
                     test_mocks.c \
                     $(top_srcdir)/src/rtp.c \
                     $(top_srcdir)/src/http.c
check_rtp_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_rtp_LDADD = @CHECK_LIBS@

# FCC tests
check_fcc_SOURCES = check_fcc.c \
                     test_mocks.c \
                     $(top_srcdir)/src/fcc.c \
                     $(top_srcdir)/src/rtp.c \
                     $(top_srcdir)/src/http.c
check_fcc_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_fcc_LDADD = @CHECK_LIBS@




check_timezone_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src
check_timezone_LDADD = @CHECK_LIBS@

# Test environment setup
TESTS_ENVIRONMENT = \
	SRCDIR='$(srcdir)' \
	BUILDDIR='$(builddir)' \
	top_srcdir='$(top_srcdir)' \
	top_builddir='$(top_builddir)'

# Clean up generated test files
CLEANFILES = *.log *.trs test-suite.log

# Additional compiler flags
AM_CFLAGS = -DSYSCONFDIR=\"@sysconfdir@\"

else

# If Check is not available, create empty targets
check-local:
	@echo "Check framework not available, skipping tests"

endif # HAVE_CHECK

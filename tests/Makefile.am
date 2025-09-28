if HAVE_CHECK

# Test programs to run
TESTS = check_http check_rtsp_logic check_rtsp_integration
check_PROGRAMS = check_http check_rtsp_logic check_rtsp_integration

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
                           $(top_srcdir)/src/rtsp.c
check_rtsp_logic_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_rtsp_logic_LDADD = @CHECK_LIBS@

# RTSP Integration Test program sources and flags
check_rtsp_integration_SOURCES = check_rtsp_integration.c \
                                 test_rtsp_mocks.c \
                                 test_mocks.c \
                                 $(top_srcdir)/src/rtsp.c
check_rtsp_integration_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src -DMOCK_NETWORK_FUNCTIONS
check_rtsp_integration_LDADD = @CHECK_LIBS@

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

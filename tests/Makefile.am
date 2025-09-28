if HAVE_CHECK

# Test programs to run
TESTS = check_http
check_PROGRAMS = check_http

# Test program sources and flags
check_http_SOURCES = check_http.c \
                     test_mocks.c \
                     $(top_srcdir)/src/http.c
check_http_CPPFLAGS = @CHECK_CFLAGS@ -I$(top_srcdir)/src
check_http_LDADD = @CHECK_LIBS@

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

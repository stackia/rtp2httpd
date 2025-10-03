if HAVE_CHECK


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

SUBDIRS = src

if HAVE_CHECK
SUBDIRS += tests
endif # HAVE_CHECK

# Configuration files
dist_sysconf_DATA = rtp2httpd.conf

# Documentation
dist_doc_DATA = README.md TESTING.md
EXTRA_DIST = AUTHORS LICENSE rtp2httpd.pc.in

# pkg-config support
pkgconfigdir = $(libdir)/pkgconfig
pkgconfig_DATA = rtp2httpd.pc

# Clean up generated files
CLEANFILES = 
DISTCLEANFILES = 
MAINTAINERCLEANFILES = 

# Configure automake behavior
ACLOCAL_AMFLAGS = -I m4

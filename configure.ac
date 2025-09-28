#                                               -*- Autoconf -*-
# Process this file with autoconf to produce a configure script.

AC_PREREQ([2.69])
AC_INIT([rtp2httpd-modern],[1.0.0],[jsq2627@gmail.com],[rtp2httpd-modern],[https://github.com/stackia/rtp2httpd])
AC_CONFIG_SRCDIR([src/rtp2httpd.h])
AC_CONFIG_HEADERS([src/config.h])
AM_INIT_AUTOMAKE([subdir-objects parallel-tests color-tests foreign -Wall -Werror])

# Checks for programs.
AC_PROG_CC
AC_PROG_INSTALL

# Check for compiler warning flags
if test "x$GCC" = "xyes"; then
    WARN_CFLAGS="-Wall -Wextra -Wno-unused-parameter"
fi
AC_SUBST([WARN_CFLAGS])

# Checks for libraries.
# Check for Check framework for unit testing
PKG_CHECK_MODULES([CHECK], [check >= 0.9.4], 
    [have_check=yes], 
    [have_check=no
     AC_MSG_WARN([Check framework not found, unit tests will be disabled])])
AM_CONDITIONAL([HAVE_CHECK], [test "x$have_check" = "xyes"])

# Checks for header files.
AC_CHECK_HEADERS([arpa/inet.h fcntl.h netdb.h netinet/in.h stdlib.h string.h strings.h sys/socket.h unistd.h])

# Checks for typedefs, structures, and compiler characteristics.
AC_C_INLINE
AC_TYPE_PID_T
AC_TYPE_SIZE_T
AC_TYPE_UINT16_T
AC_TYPE_UINT8_T

# Checks for library functions.
AC_FUNC_FORK
AC_CHECK_FUNCS([memmove memset select socket strcasecmp strdup strerror strndup getopt_long getaddrinfo getnameinfo])

AC_CONFIG_FILES([Makefile
                 src/Makefile
                 tests/Makefile
                 rtp2httpd.pc])
AC_OUTPUT

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
    WARN_CFLAGS="-std=c99 -Wall -Wextra -Wno-unused-parameter"
    WARN_CFLAGS="$WARN_CFLAGS -Wformat=2 -Wformat-security"
    WARN_CFLAGS="$WARN_CFLAGS -Wstrict-prototypes -Wmissing-prototypes"
    WARN_CFLAGS="$WARN_CFLAGS -Wold-style-definition -Wpointer-arith"
    WARN_CFLAGS="$WARN_CFLAGS -Wcast-align -Wcast-qual -Wshadow"
    WARN_CFLAGS="$WARN_CFLAGS -Wwrite-strings -Wredundant-decls"
fi
AC_SUBST([WARN_CFLAGS])

# Security and hardening flags
if test "x$GCC" = "xyes"; then
    SECURITY_CFLAGS="-D_FORTIFY_SOURCE=2 -fstack-protector-strong"
    AC_SUBST([SECURITY_CFLAGS])
fi
AC_USE_SYSTEM_EXTENSIONS

# Checks for libraries.
# Check for Check framework for unit testing
PKG_CHECK_MODULES([CHECK], [check >= 0.9.4], 
    [have_check=yes], 
    [have_check=no
     AC_MSG_WARN([Check framework not found, unit tests will be disabled])])
AM_CONDITIONAL([HAVE_CHECK], [test "x$have_check" = "xyes"])

# Checks for header files.
AC_CHECK_HEADERS([arpa/inet.h ctype.h errno.h fcntl.h getopt.h netdb.h net/if.h netinet/in.h netinet/tcp.h signal.h stdarg.h stdint.h stdlib.h string.h strings.h sys/select.h sys/socket.h sys/time.h sys/types.h sys/wait.h time.h unistd.h])

# Checks for typedefs, structures, and compiler characteristics.
AC_C_INLINE
AC_TYPE_PID_T
AC_TYPE_SIZE_T
AC_TYPE_UINT16_T
AC_TYPE_UINT8_T

# Checks for library functions.
AC_FUNC_FORK
AC_CHECK_FUNCS([getaddrinfo getnameinfo getopt_long memmove memset select socket strcasecmp strdup strerror strndup])

AC_CONFIG_FILES([Makefile
                 src/Makefile
                 tests/Makefile
                 rtp2httpd.pc])
AC_OUTPUT

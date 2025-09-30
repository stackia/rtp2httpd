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

# Enable system extensions
AC_USE_SYSTEM_EXTENSIONS

# Check for compiler warning flags
if test "x$GCC" = "xyes"; then
    # Basic warning flags (no performance impact)
    WARN_CFLAGS="-std=c99 -Wall -Wextra -Wno-unused-parameter"
    WARN_CFLAGS="$WARN_CFLAGS -Wformat=2 -Wformat-security"
    WARN_CFLAGS="$WARN_CFLAGS -Wstrict-prototypes -Wmissing-prototypes"
    WARN_CFLAGS="$WARN_CFLAGS -Wold-style-definition -Wpointer-arith"
    WARN_CFLAGS="$WARN_CFLAGS -Wcast-align -Wcast-qual -Wshadow"
    WARN_CFLAGS="$WARN_CFLAGS -Wwrite-strings -Wredundant-decls"

    # Additional useful warnings for embedded systems
    WARN_CFLAGS="$WARN_CFLAGS -Wnull-dereference"
    WARN_CFLAGS="$WARN_CFLAGS -Wundef -Wvla"

    # GCC-specific warnings (check GCC version >= 6.0)
    AC_MSG_CHECKING([for GCC version >= 6.0])
    GCC_VERSION=$(${CC} -dumpversion | cut -d. -f1)
    if test "${GCC_VERSION}" -ge 6 2>/dev/null; then
        AC_MSG_RESULT([yes (${GCC_VERSION})])
        WARN_CFLAGS="$WARN_CFLAGS -Wduplicated-cond"
        WARN_CFLAGS="$WARN_CFLAGS -Wlogical-op -Wjump-misses-init"

        # GCC 7+ specific warnings
        if test "${GCC_VERSION}" -ge 7 2>/dev/null; then
            WARN_CFLAGS="$WARN_CFLAGS -Wduplicated-branches"
        fi
    else
        AC_MSG_RESULT([no (${GCC_VERSION})])
    fi
fi
AC_SUBST([WARN_CFLAGS])

# Security and hardening flags (optimized for embedded systems)
if test "x$GCC" = "xyes"; then
    # Essential security flags with minimal performance impact
    # _FORTIFY_SOURCE=2: Buffer overflow detection (~1-2% overhead, essential for network services)
    # fstack-protector-strong: Stack canary protection (~1-3% overhead, prevents buffer overflows)
    SECURITY_CFLAGS="-D_FORTIFY_SOURCE=2 -fstack-protector-strong"

    # Explicitly disable PIE for embedded systems (5-10% performance overhead)
    # Modern GCC enables PIE by default, but it's less useful on embedded systems
    SECURITY_CFLAGS="$SECURITY_CFLAGS -fno-PIE"

    AC_SUBST([SECURITY_CFLAGS])

    # Linker hardening flags (minimal performance impact)
    # -Wl,-z,relro: Read-only relocations (no runtime overhead, hardens GOT)
    # -no-pie: Disable position independent executable (better performance on embedded)
    # Note: Removed -Wl,-z,now (increases startup time, lazy binding acceptable for embedded)
    SECURITY_LDFLAGS="-no-pie -Wl,-z,relro"
    AC_SUBST([SECURITY_LDFLAGS])
fi

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

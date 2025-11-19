#                                               -*- Autoconf -*-
# Process this file with autoconf to produce a configure script.

AC_PREREQ([2.69])
m4_define([release_version], m4_esyscmd_s([echo ${RELEASE_VERSION:-1.0.0-snapshot}]))
AC_INIT([rtp2httpd],[release_version],[jsq2627@gmail.com],[rtp2httpd],[https://github.com/stackia/rtp2httpd])
AC_CONFIG_SRCDIR([src/rtp2httpd.h])
AC_CONFIG_HEADERS([src/config.h])
AM_INIT_AUTOMAKE([subdir-objects parallel-tests color-tests foreign -Wall -Werror])

# Checks for programs.
# Prevent AC_PROG_CC from adding default -g -O2 flags
: ${CFLAGS=""}
AC_PROG_CC
AC_PROG_INSTALL

# Enable system extensions
AC_USE_SYSTEM_EXTENSIONS
AC_DEFINE([_DEFAULT_SOURCE], [1], [Enable default glibc features])

# Check for compiler warning flags
if test "x$GCC" = "xyes"; then
    # Basic warning flags (no performance impact)
    WARN_CFLAGS="-std=c11 -Wall -Wextra -Wunused"
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

# Performance optimization flags
AC_ARG_ENABLE([optimization],
    [AS_HELP_STRING([--enable-optimization@<:@=LEVEL@:>@],
        [enable compiler optimizations (default: -O2, options: -O0, -O1, -O2, -O3, -Os)])],
    [opt_level=$enableval],
    [opt_level="-O2"])

if test "x$GCC" = "xyes"; then
    # Set optimization level
    case "$opt_level" in
        no|-O0)
            OPT_CFLAGS="-O0"
            AC_MSG_NOTICE([Optimization disabled (-O0)])
            ;;
        -O1)
            OPT_CFLAGS="-O1"
            AC_MSG_NOTICE([Using optimization level -O1])
            ;;
        yes|-O2)
            OPT_CFLAGS="-O2"
            AC_MSG_NOTICE([Using optimization level -O2 (default)])
            ;;
        -O3)
            OPT_CFLAGS="-O3"
            AC_MSG_NOTICE([Using optimization level -O3 (maximum speed)])
            ;;
        -Os)
            OPT_CFLAGS="-Os"
            AC_MSG_NOTICE([Using optimization level -Os (size optimization)])
            ;;
        *)
            OPT_CFLAGS="$opt_level"
            AC_MSG_NOTICE([Using custom optimization: $opt_level])
            ;;
    esac

    # Additional performance optimizations for -O3
    if test "x$opt_level" = "x-O3"; then
        # Link-Time Optimization (LTO) - enables cross-file optimizations
        OPT_CFLAGS="$OPT_CFLAGS -flto=auto"
        OPT_LDFLAGS="-flto"

        # Function inlining optimizations
        OPT_CFLAGS="$OPT_CFLAGS -finline-functions -finline-limit=600"

        # Loop optimizations
        OPT_CFLAGS="$OPT_CFLAGS -funroll-loops -ftree-vectorize"

        # Fast math (safe for media streaming, not for precise calculations)
        # Benefit: 5-10% improvement in floating point operations
        OPT_CFLAGS="$OPT_CFLAGS -ffast-math"

        # Omit frame pointer for better register usage (x86/x64)
        OPT_CFLAGS="$OPT_CFLAGS -fomit-frame-pointer"

        AC_MSG_NOTICE([Enabled advanced optimizations: LTO, loop unrolling, vectorization])
    fi

    AC_SUBST([OPT_CFLAGS])
    AC_SUBST([OPT_LDFLAGS])
fi

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

    # Add optimization flags to linker if LTO is enabled
    if test "x$OPT_LDFLAGS" != "x"; then
        SECURITY_LDFLAGS="$SECURITY_LDFLAGS $OPT_LDFLAGS"
    fi

    AC_SUBST([SECURITY_LDFLAGS])
fi

# Checks for libraries.
# Check for pthread (required for multi-threading)
AC_SEARCH_LIBS([pthread_create], [pthread], [],
    [AC_MSG_ERROR([pthread library is required but not found])])

# Check for rt library (required for clock_gettime, etc.)
AC_SEARCH_LIBS([clock_gettime], [rt], [],
    [AC_MSG_ERROR([rt library is required but not found])])

# Check for Check framework for unit testing
PKG_CHECK_MODULES([CHECK], [check >= 0.9.4],
    [have_check=yes],
    [have_check=no
     AC_MSG_WARN([Check framework not found, unit tests will be disabled])])
AM_CONDITIONAL([HAVE_CHECK], [test "x$have_check" = "xyes"])

# Checks for header files.
AC_CHECK_HEADERS([arpa/inet.h ctype.h errno.h fcntl.h getopt.h netdb.h net/if.h netinet/in.h netinet/tcp.h signal.h stdarg.h stdint.h stdlib.h string.h strings.h sys/epoll.h sys/socket.h sys/time.h sys/types.h sys/wait.h time.h unistd.h])

# Checks for typedefs, structures, and compiler characteristics.
AC_C_INLINE
AC_TYPE_PID_T
AC_TYPE_OFF_T
AC_TYPE_SIZE_T
AC_TYPE_OFF_T
AC_TYPE_UINT16_T
AC_TYPE_UINT8_T

# Checks for library functions.
AC_FUNC_FORK
AC_CHECK_FUNCS([epoll_create1 epoll_ctl epoll_wait getaddrinfo getnameinfo getopt_long memmove memset socket strcasecmp strdup strerror strndup])

AC_CONFIG_FILES([Makefile
                 src/Makefile
                 tests/Makefile
                 rtp2httpd.pc])
AC_OUTPUT

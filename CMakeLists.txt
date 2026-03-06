cmake_minimum_required(VERSION 3.14)

# Extract version from environment or use default
if(DEFINED ENV{RELEASE_VERSION} AND NOT "$ENV{RELEASE_VERSION}" STREQUAL "")
  set(PROJECT_VERSION_STRING $ENV{RELEASE_VERSION})
else()
  set(PROJECT_VERSION_STRING "1.0.0-snapshot")
endif()

project(rtp2httpd
  VERSION 1.0.0
  LANGUAGES C
  DESCRIPTION "RTP to HTTP streaming daemon"
)

# ── C standard ──────────────────────────────────────────────────────
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

# ── Platform detection ──────────────────────────────────────────────
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(PLATFORM_LINUX TRUE)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  set(PLATFORM_MACOS TRUE)
endif()

# ── Source files ────────────────────────────────────────────────────
set(COMMON_SOURCES
  src/rtp2httpd.c
  src/supervisor.c
  src/configuration.c
  src/http.c
  src/http_fetch.c
  src/service.c
  src/rtp.c
  src/rtp_reorder.c
  src/rtp_fec.c
  src/rs_fec.c
  src/multicast.c
  src/fcc.c
  src/fcc_telecom.c
  src/fcc_huawei.c
  src/stream.c
  src/rtsp.c
  src/http_proxy.c
  src/http_proxy_rewrite.c
  src/stun.c
  src/snapshot.c
  src/timezone.c
  src/status.c
  src/connection.c
  src/worker.c
  src/buffer_pool.c
  src/zerocopy.c
  src/m3u.c
  src/epg.c
  src/md5.c
  src/hashmap.c
  src/embedded_web.c
  src/utils.c
)

# Platform-specific poller backend
if(PLATFORM_LINUX)
  list(APPEND COMMON_SOURCES src/poller_epoll.c)
elseif(PLATFORM_MACOS)
  list(APPEND COMMON_SOURCES src/poller_kqueue.c)
endif()

# ── Build target ────────────────────────────────────────────────────
add_executable(rtp2httpd ${COMMON_SOURCES})

target_include_directories(rtp2httpd PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

# ── Install directories (needed before compile definitions) ────────
include(GNUInstallDirs)

# ── Compile definitions ────────────────────────────────────────────
target_compile_definitions(rtp2httpd PRIVATE
  SYSCONFDIR="${CMAKE_INSTALL_FULL_SYSCONFDIR}"
  PACKAGE="${PROJECT_NAME}"
  PACKAGE_VERSION="${PROJECT_VERSION_STRING}"
  VERSION="${PROJECT_VERSION_STRING}"
)

if(PLATFORM_LINUX)
  # _GNU_SOURCE implies _DEFAULT_SOURCE on glibc
  target_compile_definitions(rtp2httpd PRIVATE _GNU_SOURCE)
endif()

# ── Compiler warnings ──────────────────────────────────────────────
set(WARN_FLAGS
  -Wall -Wextra -Wunused
  -Wformat=2 -Wformat-security
  -Wstrict-prototypes -Wmissing-prototypes
  -Wold-style-definition -Wpointer-arith
  -Wcast-align -Wcast-qual -Wshadow
  -Wwrite-strings -Wredundant-decls
  -Wnull-dereference
  -Wundef -Wvla
)

# GCC-specific warnings
if(CMAKE_C_COMPILER_ID STREQUAL "GNU")
  if(CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "6.0")
    list(APPEND WARN_FLAGS -Wduplicated-cond -Wlogical-op -Wjump-misses-init)
  endif()
  if(CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "7.0")
    list(APPEND WARN_FLAGS -Wduplicated-branches)
  endif()
endif()

target_compile_options(rtp2httpd PRIVATE ${WARN_FLAGS})

# ── Build type default ──────────────────────────────────────────────
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE "Release" CACHE STRING "Build type" FORCE)
endif()

# ── Aggressive optimizations (opt-in) ──────────────────────────────
option(ENABLE_AGGRESSIVE_OPT "Enable aggressive optimizations (LTO, fast-math)" OFF)

if(ENABLE_AGGRESSIVE_OPT)
  target_compile_options(rtp2httpd PRIVATE
    -finline-functions -funroll-loops -ftree-vectorize
    -ffast-math -fomit-frame-pointer
  )
  if(CMAKE_C_COMPILER_ID STREQUAL "GNU")
    target_compile_options(rtp2httpd PRIVATE -flto=auto -finline-limit=600)
    target_link_options(rtp2httpd PRIVATE -flto)
  endif()
endif()

# ── Security hardening (Linux) ──────────────────────────────────────
if(PLATFORM_LINUX)
  target_compile_options(rtp2httpd PRIVATE -fstack-protector-strong)
  # _FORTIFY_SOURCE requires optimization >= -O1
  if(NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_definitions(rtp2httpd PRIVATE _FORTIFY_SOURCE=2)
  endif()
endif()

# ── Libraries ───────────────────────────────────────────────────────
find_package(Threads REQUIRED)
target_link_libraries(rtp2httpd PRIVATE Threads::Threads)

if(PLATFORM_LINUX)
  # rt library for clock_gettime (not needed on macOS)
  target_link_libraries(rtp2httpd PRIVATE rt)
endif()

# ── Installation ────────────────────────────────────────────────────
install(TARGETS rtp2httpd
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

install(FILES rtp2httpd.conf
  DESTINATION ${CMAKE_INSTALL_SYSCONFDIR}
)

# ── Summary ─────────────────────────────────────────────────────────
message(STATUS "")
message(STATUS "rtp2httpd build configuration:")
message(STATUS "  Platform:       ${CMAKE_SYSTEM_NAME}")
message(STATUS "  Compiler:       ${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}")
message(STATUS "  Build type:     ${CMAKE_BUILD_TYPE}")
message(STATUS "  Aggressive opt: ${ENABLE_AGGRESSIVE_OPT}")
message(STATUS "  Install prefix: ${CMAKE_INSTALL_PREFIX}")
message(STATUS "")

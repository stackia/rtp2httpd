#ifndef PLATFORM_COMPAT_H
#define PLATFORM_COMPAT_H

/**
 * Platform compatibility layer.
 *
 * Provides unified access to APIs that differ across operating systems.
 * Include this header instead of platform-specific headers.
 */

#include <stddef.h> /* NULL */

/* ── MSG_NOSIGNAL ────────────────────────────────────────────────────
 * Linux/FreeBSD have MSG_NOSIGNAL as a per-send flag.
 * macOS uses the SO_NOSIGPIPE socket option instead (set once on socket).
 * We define MSG_NOSIGNAL to 0 on macOS so existing send()/sendmsg() calls
 * compile unchanged; the actual SIGPIPE suppression is done via
 * platform_set_nosigpipe() which callers must invoke after socket creation.
 */
#ifdef __APPLE__
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
#include <sys/socket.h>
static inline void platform_set_nosigpipe(int fd) {
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
}
#else /* Linux / FreeBSD / other */
static inline void platform_set_nosigpipe(int fd) { (void)fd; }
#endif

/* ── sendfile() ──────────────────────────────────────────────────────
 * Linux:   ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count)
 * macOS:   int sendfile(int fd, int s, off_t offset, off_t *len, ...)
 * FreeBSD: int sendfile(int fd, int s, off_t offset, size_t nbytes,
 *                       struct sf_hdtr *, off_t *sbytes, int flags)
 *
 * We provide a wrapper with the Linux-style signature.
 */
#ifdef __APPLE__
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/uio.h>
static inline ssize_t platform_sendfile(int out_fd, int in_fd, off_t *offset, size_t count) {
  off_t len = (off_t)count;
  off_t off = offset ? *offset : 0;
  /* macOS sendfile: sendfile(in_fd, out_fd, offset, &len, NULL, 0) */
  int r = sendfile(in_fd, out_fd, off, &len, NULL, 0);
  if (r < 0 && len == 0) {
    return -1;
  }
  if (offset) {
    *offset += len;
  }
  return (ssize_t)len;
}
#elif defined(__FreeBSD__)
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/uio.h>
static inline ssize_t platform_sendfile(int out_fd, int in_fd, off_t *offset, size_t count) {
  off_t sbytes = 0;
  off_t off = offset ? *offset : 0;
  /* FreeBSD sendfile: sendfile(in_fd, out_fd, offset, count, NULL, &sbytes, 0)
   */
  int r = sendfile(in_fd, out_fd, off, count, NULL, &sbytes, 0);
  if (r < 0 && sbytes == 0) {
    return -1;
  }
  if (offset) {
    *offset += sbytes;
  }
  return (ssize_t)sbytes;
}
#else /* Linux */
#include <sys/sendfile.h>
static inline ssize_t platform_sendfile(int out_fd, int in_fd, off_t *offset, size_t count) {
  return sendfile(out_fd, in_fd, offset, count);
}
#endif

/* ── SO_RCVBUFFORCE ──────────────────────────────────────────────────
 * Linux-only socket option that can exceed rmem_max with CAP_NET_ADMIN.
 */
#ifndef SO_RCVBUFFORCE
#define SO_RCVBUFFORCE SO_RCVBUF
#endif

/* ── SO_ZEROCOPY / MSG_ZEROCOPY ──────────────────────────────────────
 * Linux 4.14+ only. Define to invalid values on other platforms so
 * the detection code gracefully falls through to regular send.
 */
#ifndef SO_ZEROCOPY
#define SO_ZEROCOPY 60
#endif
#ifndef MSG_ZEROCOPY
#define MSG_ZEROCOPY 0x4000000
#endif

/* ── MSG_ERRQUEUE ────────────────────────────────────────────────────
 * Linux-only. Used for MSG_ZEROCOPY completion notifications.
 */
#ifndef MSG_ERRQUEUE
#define MSG_ERRQUEUE 0x2000
#endif

/* ── SO_BINDTODEVICE ─────────────────────────────────────────────────
 * Linux-only. On macOS, IP_BOUND_IF is a rough equivalent.
 */
#ifdef __APPLE__
#include <net/if.h>
#include <netinet/in.h>
#include <string.h>
static inline int platform_bind_to_device(int sock, const char *ifname) {
  unsigned int ifindex = if_nametoindex(ifname);
  if (ifindex == 0)
    return -1;
  return setsockopt(sock, IPPROTO_IP, IP_BOUND_IF, &ifindex, sizeof(ifindex));
}
#elif defined(__FreeBSD__)
#include "utils.h"
#include <net/if.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
static inline int platform_bind_to_device(int sock, const char *ifname) {
  unsigned int ifindex = if_nametoindex(ifname);
  if (ifindex == 0)
    return -1;
  struct ip_mreqn mreqn;
  memset(&mreqn, 0, sizeof(mreqn));
  mreqn.imr_ifindex = (int)ifindex;
  if (setsockopt(sock, IPPROTO_IP, IP_MULTICAST_IF, &mreqn, sizeof(mreqn)) < 0) {
    logger(LOG_ERROR, "Platform Compat: Failed to bind devices because FreeBSD does not support binding unicast socket "
                      "to network devices.");
    return -1;
  }
  return 0;
}
#else /* Linux */
#include <net/if.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
static inline int platform_bind_to_device(int sock, const char *ifname) {
  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
  return setsockopt(sock, SOL_SOCKET, SO_BINDTODEVICE, &ifr, sizeof(ifr));
}
#endif

/* ── prctl / PR_SET_PDEATHSIG ────────────────────────────────────────
 * Linux: prctl(PR_SET_PDEATHSIG, sig) ensures child dies when parent exits.
 * macOS: No direct equivalent. We use a no-op; the supervisor already
 *        monitors children via waitpid() and re-checks getppid().
 */
#ifdef __linux__
#include <sys/prctl.h>
static inline void platform_set_parent_death_signal(int sig) { prctl(PR_SET_PDEATHSIG, sig); }
#else
static inline void platform_set_parent_death_signal(int sig) { (void)sig; }
#endif

/* ── ip_mreqn ────────────────────────────────────────────────────────
 * Linux has ip_mreqn (extends ip_mreq with interface index).
 * macOS only has ip_mreq. We use ip_mreq when ip_mreqn is unavailable,
 * falling back to using the interface index via IP_MULTICAST_IF with a
 * simple in_addr.
 */

/* ── IPOPT_RA ────────────────────────────────────────────────────────
 * Router Alert IP option value. Always defined on Linux, may be
 * missing on macOS.
 */
#ifndef IPOPT_RA
#define IPOPT_RA 0x94 /* Router Alert (20 | 0x80) */
#endif

/* ── SOL_IP / SOL_IPV6 ───────────────────────────────────────────────
 * Linux uses SOL_IP and SOL_IPV6 as aliases for IPPROTO_IP / IPPROTO_IPV6.
 * macOS/BSD only have the IPPROTO_* variants.
 */
#ifndef SOL_IP
#define SOL_IP IPPROTO_IP
#endif
#ifndef SOL_IPV6
#define SOL_IPV6 IPPROTO_IPV6
#endif

/* ── IP_RECVERR / IPV6_RECVERR ──────────────────────────────────────
 * Linux-only. Used for MSG_ZEROCOPY completion notifications.
 * Define to harmless values on other platforms; the zerocopy
 * completion code is already guarded by #ifdef __linux__.
 */
#ifndef IP_RECVERR
#define IP_RECVERR 11
#endif
#ifndef IPV6_RECVERR
#define IPV6_RECVERR 25
#endif

/* ── clock_gettime ───────────────────────────────────────────────────
 * Available on both Linux and macOS (10.12+). No compatibility shim needed.
 */

#endif /* PLATFORM_COMPAT_H */

#ifndef PLATFORM_COMPAT_H
#define PLATFORM_COMPAT_H

/**
 * Platform compatibility layer.
 *
 * Provides unified access to APIs that differ across operating systems.
 * Include this header instead of platform-specific headers.
 */

#include <errno.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stddef.h> /* NULL */
#include <string.h>
#include <sys/socket.h>

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

/* ── multicast group membership ─────────────────────────────────────
 * Linux uses RFC 3678 group_req / group_source_req so an interface index of 0
 * means "kernel chooses according to routing".
 *
 * macOS/FreeBSD are stricter around RFC 3678 joins in practice.  For IPv4,
 * use the legacy ip_mreq / ip_mreq_source APIs, where INADDR_ANY gives the
 * same default-route behavior.  IPv6 has no IP_ADD_MEMBERSHIP equivalent, so
 * use the native ipv6_mreq join/leave API for ASM groups.
 */
#if defined(__APPLE__) || defined(__FreeBSD__)
#include <ifaddrs.h>
#endif

static inline int platform_mcast_modern_group_op(int sock, int family, const struct sockaddr *group,
                                                 socklen_t group_len, const struct sockaddr *source,
                                                 socklen_t source_len, unsigned int ifindex, int is_join) {
#if defined(MCAST_JOIN_GROUP) && defined(MCAST_LEAVE_GROUP) && defined(MCAST_JOIN_SOURCE_GROUP) &&                     \
    defined(MCAST_LEAVE_SOURCE_GROUP)
  int level;

  if (family == AF_INET) {
    level = SOL_IP;
  } else if (family == AF_INET6) {
    level = SOL_IPV6;
  } else {
    errno = EAFNOSUPPORT;
    return -1;
  }

  if (!group || group_len > sizeof(struct sockaddr_storage)) {
    errno = EINVAL;
    return -1;
  }

  if (source) {
    struct group_source_req gsr;
    int op;

    if (source_len > sizeof(gsr.gsr_source)) {
      errno = EINVAL;
      return -1;
    }

    memset(&gsr, 0, sizeof(gsr));
    gsr.gsr_interface = ifindex;
    memcpy(&gsr.gsr_group, group, group_len);
    memcpy(&gsr.gsr_source, source, source_len);
    op = is_join ? MCAST_JOIN_SOURCE_GROUP : MCAST_LEAVE_SOURCE_GROUP;
    return setsockopt(sock, level, op, &gsr, sizeof(gsr));
  } else {
    struct group_req gr;
    int op;

    memset(&gr, 0, sizeof(gr));
    gr.gr_interface = ifindex;
    memcpy(&gr.gr_group, group, group_len);
    op = is_join ? MCAST_JOIN_GROUP : MCAST_LEAVE_GROUP;
    return setsockopt(sock, level, op, &gr, sizeof(gr));
  }
#else
  (void)sock;
  (void)family;
  (void)group;
  (void)group_len;
  (void)source;
  (void)source_len;
  (void)ifindex;
  (void)is_join;
  errno = EOPNOTSUPP;
  return -1;
#endif
}

#if defined(__APPLE__) || defined(__FreeBSD__)
static inline int platform_ipv4_addr_for_ifindex(unsigned int ifindex, struct in_addr *addr) {
  struct ifaddrs *ifaddr, *ifa;
  int result = -1;

  if (!addr) {
    errno = EINVAL;
    return -1;
  }

  if (ifindex == 0) {
    addr->s_addr = htonl(INADDR_ANY);
    return 0;
  }

  if (getifaddrs(&ifaddr) < 0) {
    return -1;
  }

  errno = EADDRNOTAVAIL;
  for (ifa = ifaddr; ifa; ifa = ifa->ifa_next) {
    if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET)
      continue;
    if (if_nametoindex(ifa->ifa_name) != ifindex)
      continue;

    *addr = ((struct sockaddr_in *)(void *)ifa->ifa_addr)->sin_addr;
    result = 0;
    break;
  }

  freeifaddrs(ifaddr);
  return result;
}

static inline int platform_mcast_ipv4_legacy_group_op(int sock, const struct sockaddr *group,
                                                      const struct sockaddr *source, unsigned int ifindex,
                                                      int is_join) {
  const struct sockaddr_in *group4 = (const struct sockaddr_in *)(const void *)group;

  if (!group || group->sa_family != AF_INET) {
    errno = EAFNOSUPPORT;
    return -1;
  }

  if (source) {
#if defined(IP_ADD_SOURCE_MEMBERSHIP) && defined(IP_DROP_SOURCE_MEMBERSHIP)
    const struct sockaddr_in *source4 = (const struct sockaddr_in *)(const void *)source;
    struct ip_mreq_source mreq;
    int op;

    if (source->sa_family != AF_INET) {
      errno = EAFNOSUPPORT;
      return -1;
    }

    memset(&mreq, 0, sizeof(mreq));
    mreq.imr_multiaddr = group4->sin_addr;
    mreq.imr_sourceaddr = source4->sin_addr;
    if (platform_ipv4_addr_for_ifindex(ifindex, &mreq.imr_interface) < 0)
      return -1;

    op = is_join ? IP_ADD_SOURCE_MEMBERSHIP : IP_DROP_SOURCE_MEMBERSHIP;
    return setsockopt(sock, IPPROTO_IP, op, &mreq, sizeof(mreq));
#else
    errno = EOPNOTSUPP;
    return -1;
#endif
  } else {
    struct ip_mreq mreq;
    int op;

    memset(&mreq, 0, sizeof(mreq));
    mreq.imr_multiaddr = group4->sin_addr;
    if (platform_ipv4_addr_for_ifindex(ifindex, &mreq.imr_interface) < 0)
      return -1;

    op = is_join ? IP_ADD_MEMBERSHIP : IP_DROP_MEMBERSHIP;
    return setsockopt(sock, IPPROTO_IP, op, &mreq, sizeof(mreq));
  }
}

static inline int platform_mcast_ipv6_legacy_group_op(int sock, const struct sockaddr *group,
                                                      const struct sockaddr *source, socklen_t source_len,
                                                      unsigned int ifindex, int is_join) {
  const struct sockaddr_in6 *group6 = (const struct sockaddr_in6 *)(const void *)group;
  struct ipv6_mreq mreq;
  int op;

  if (!group || group->sa_family != AF_INET6) {
    errno = EAFNOSUPPORT;
    return -1;
  }

  if (source) {
    return platform_mcast_modern_group_op(sock, AF_INET6, group, sizeof(*group6), source, source_len, ifindex, is_join);
  }

  memset(&mreq, 0, sizeof(mreq));
  mreq.ipv6mr_multiaddr = group6->sin6_addr;
  mreq.ipv6mr_interface = ifindex ? ifindex : group6->sin6_scope_id;
  op = is_join ? IPV6_JOIN_GROUP : IPV6_LEAVE_GROUP;
  return setsockopt(sock, IPPROTO_IPV6, op, &mreq, sizeof(mreq));
}
#endif

static inline int platform_mcast_group_op(int sock, int family, const struct sockaddr *group, socklen_t group_len,
                                          const struct sockaddr *source, socklen_t source_len, unsigned int ifindex,
                                          int is_join) {
#if defined(__APPLE__) || defined(__FreeBSD__)
  (void)group_len;
  if (!group) {
    errno = EINVAL;
    return -1;
  }

  if (family == AF_INET) {
    return platform_mcast_ipv4_legacy_group_op(sock, group, source, ifindex, is_join);
  }
  if (family == AF_INET6) {
    return platform_mcast_ipv6_legacy_group_op(sock, group, source, source_len, ifindex, is_join);
  }

  errno = EAFNOSUPPORT;
  return -1;
#else
  return platform_mcast_modern_group_op(sock, family, group, group_len, source, source_len, ifindex, is_join);
#endif
}

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

/* ── TCP keepalive ──────────────────────────────────────────────────
 * Configure TCP keepalive for early dead-peer detection on TCP
 * client sockets.  Supports fine-grained control on all three target
 * platforms:
 *   - Linux / FreeBSD: TCP_KEEPIDLE, TCP_KEEPINTVL, TCP_KEEPCNT
 *   - macOS:           TCP_KEEPALIVE (idle), TCP_KEEPINTVL, TCP_KEEPCNT
 *
 * If fine-grained options are unavailable (older kernel / unusual
 * platform) the function silently falls back to bare SO_KEEPALIVE
 * with system-default timing — still strictly better than nothing.
 *
 * Call from connection_create() for every TCP client socket.
 */
#include <netinet/tcp.h>
static inline void platform_set_tcp_keepalive(int fd, int idle_sec, int interval_sec, int count) {
  int keepalive = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive)) < 0)
    return;

  /* macOS uses TCP_KEEPALIVE for the idle timer; Linux/FreeBSD use
   * TCP_KEEPIDLE.  Both control the same thing in seconds — just a
   * naming difference. */
#ifdef __APPLE__
  if (idle_sec > 0)
    (void)setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, &idle_sec, sizeof(idle_sec));
#elif defined(TCP_KEEPIDLE)
  if (idle_sec > 0)
    (void)setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle_sec, sizeof(idle_sec));
#endif

#if defined(TCP_KEEPINTVL)
  if (interval_sec > 0)
    (void)setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval_sec, sizeof(interval_sec));
#endif

#if defined(TCP_KEEPCNT)
  if (count > 0)
    (void)setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof(count));
#endif
}

/* ── clock_gettime ───────────────────────────────────────────────────
 * Available on both Linux and macOS (10.12+). No compatibility shim needed.
 */

#endif /* PLATFORM_COMPAT_H */

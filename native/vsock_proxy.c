/*
 * vsock_proxy.c — bridges AWS Nitro vsock traffic for TypeScript apps.
 *
 * Usage:
 *   ./vsock_proxy <unix_socket_path> <vsock_port>
 *   ./vsock_proxy egress <listen_addr> <listen_port> <host_vsock_port>
 *
 * Ingress mode accepts vsock connections from the parent instance and relays
 * them byte-for-byte to an application listening on a Unix domain socket.
 *
 * Egress mode accepts TCP connections on loopback and relays them byte-for-byte
 * to a host vsock proxy running on the parent instance CID. Enclave code can
 * reach external services through ordinary HTTPS URLs: TypeScript writes an
 * /etc/hosts entry that resolves each configured domain to a generated
 * 127.77.x.x address, and this helper listens on that address at port 443.
 *
 * The explicit loopback alias setup below is important. In a minimal enclave
 * rootfs, binding a generated 127.77.x.x address is not enough by itself: the
 * address must be present on lo so the kernel treats it as a real local
 * destination. We add a /32 alias with RTM_NEWADDR before bind(), then fail
 * loudly if the enclave cannot configure its own loopback interface.
 *
 * Each accepted connection is handled in a detached pthread so accept() is
 * never blocked by an in-flight request.
 *
 * Build: gcc -O2 -Wall -o vsock_proxy vsock_proxy.c -lpthread
 * Note:  linux/vm_sockets.h is Linux-only; build inside the enclave image.
 */

#include <errno.h>
#include <arpa/inet.h>
#include <linux/rtnetlink.h>
#include <linux/vm_sockets.h>
#include <netinet/in.h>
#include <net/if.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define BUF_SIZE 65536
#define NITRO_PARENT_CID 3

static const char *g_unix_path = NULL;

struct conn {
  int left_fd;
  int right_fd;
};

/*
 * Small fixed-size request buffer for RTM_NEWADDR. We only ever add one IPv4
 * /32 loopback address, so 256 bytes is enough for the IFA_LOCAL and
 * IFA_ADDRESS attributes plus alignment padding.
 */
struct nl_req {
  struct nlmsghdr hdr;
  struct ifaddrmsg addr;
  char attrs[256];
};

static int parse_port(const char *raw, const char *label, unsigned int *out) {
  char *end = NULL;
  errno = 0;
  unsigned long value = strtoul(raw, &end, 10);
  if (errno != 0 || end == raw || *end != '\0' || value == 0 || value > 65535) {
    fprintf(stderr, "Invalid %s: %s\n", label, raw);
    return -1;
  }

  *out = (unsigned int)value;
  return 0;
}

/* Appends one rtnetlink attribute to an in-progress netlink message. */
static int add_netlink_attr(
  struct nlmsghdr *hdr,
  size_t max_len,
  int type,
  const void *data,
  size_t data_len
) {
  size_t attr_len = RTA_LENGTH(data_len);
  size_t next_len = NLMSG_ALIGN(hdr->nlmsg_len) + RTA_ALIGN(attr_len);
  if (next_len > max_len) {
    fprintf(stderr, "netlink attribute buffer too small\n");
    return -1;
  }

  struct rtattr *attr =
    (struct rtattr *)(((char *)hdr) + NLMSG_ALIGN(hdr->nlmsg_len));
  attr->rta_type = type;
  attr->rta_len = attr_len;
  memcpy(RTA_DATA(attr), data, data_len);
  hdr->nlmsg_len = next_len;
  return 0;
}

/*
 * The scratch enclave rootfs cannot rely on distro network setup having run.
 * Bring lo up before installing additional 127/8 aliases. If lo is already up,
 * avoid the setter ioctl so this remains harmless in richer test containers.
 */
static int bring_loopback_up(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    perror("socket(AF_INET)");
    return -1;
  }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);

  if (ioctl(fd, SIOCGIFFLAGS, &ifr) < 0) {
    perror("ioctl SIOCGIFFLAGS lo");
    close(fd);
    return -1;
  }

  if ((ifr.ifr_flags & IFF_UP) == 0) {
    ifr.ifr_flags |= IFF_UP;
    if (ioctl(fd, SIOCSIFFLAGS, &ifr) < 0) {
      perror("ioctl SIOCSIFFLAGS lo");
      close(fd);
      return -1;
    }
  }

  close(fd);
  return 0;
}

/*
 * Make a generated 127.x.x.x listen address routable inside the enclave.
 *
 * Linux treats 127/8 as loopback by convention, but a minimal Nitro/scratch
 * environment may only have 127.0.0.1 configured. Binding an unconfigured
 * address is not enough for local clients to connect reliably; the address must
 * be attached to lo. We add the exact address as a host-scoped /32 so multiple
 * outbound domains can each own a stable loopback endpoint without broadening
 * routing beyond what the generated hosts file expects.
 */
static int add_loopback_address(const char *listen_addr) {
  if (strcmp(listen_addr, "127.0.0.1") == 0) return 0;

  struct in_addr addr;
  if (inet_pton(AF_INET, listen_addr, &addr) != 1) {
    fprintf(stderr, "Invalid listen_addr: %s\n", listen_addr);
    return -1;
  }

  unsigned char first_octet = ((unsigned char *)&addr.s_addr)[0];
  if (first_octet != 127) return 0;

  if (bring_loopback_up() < 0) return -1;

  unsigned int ifindex = if_nametoindex("lo");
  if (ifindex == 0) {
    perror("if_nametoindex lo");
    return -1;
  }

  int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);
  if (fd < 0) {
    perror("socket(AF_NETLINK)");
    return -1;
  }

  struct nl_req req;
  memset(&req, 0, sizeof(req));
  req.hdr.nlmsg_len = NLMSG_LENGTH(sizeof(struct ifaddrmsg));
  req.hdr.nlmsg_type = RTM_NEWADDR;
  req.hdr.nlmsg_flags = NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL | NLM_F_ACK;
  req.addr.ifa_family = AF_INET;
  req.addr.ifa_prefixlen = 32;
  req.addr.ifa_scope = RT_SCOPE_HOST;
  req.addr.ifa_index = ifindex;

  if (
    add_netlink_attr(
      &req.hdr,
      sizeof(req),
      IFA_LOCAL,
      &addr.s_addr,
      sizeof(addr.s_addr)
    ) < 0 ||
    add_netlink_attr(
      &req.hdr,
      sizeof(req),
      IFA_ADDRESS,
      &addr.s_addr,
      sizeof(addr.s_addr)
    ) < 0
  ) {
    close(fd);
    return -1;
  }

  struct sockaddr_nl nladdr;
  memset(&nladdr, 0, sizeof(nladdr));
  nladdr.nl_family = AF_NETLINK;

  if (
    sendto(
      fd,
      &req,
      req.hdr.nlmsg_len,
      0,
      (struct sockaddr *)&nladdr,
      sizeof(nladdr)
    ) < 0
  ) {
    perror("sendto RTM_NEWADDR");
    close(fd);
    return -1;
  }

  char buf[4096];
  ssize_t len = recv(fd, buf, sizeof(buf), 0);
  if (len < 0) {
    perror("recv RTM_NEWADDR ack");
    close(fd);
    return -1;
  }

  struct nlmsghdr *hdr = (struct nlmsghdr *)buf;
  if (hdr->nlmsg_type == NLMSG_ERROR) {
    struct nlmsgerr *err = (struct nlmsgerr *)NLMSG_DATA(hdr);
    /* EEXIST is expected after restarts or if a previous bridge added it. */
    if (err->error != 0 && err->error != -EEXIST) {
      errno = -err->error;
      perror("RTM_NEWADDR");
      close(fd);
      return -1;
    }
  }

  close(fd);
  return 0;
}

static int send_all(int fd, const char *buf, ssize_t len) {
  ssize_t sent = 0;
  while (sent < len) {
    ssize_t n = send(fd, buf + sent, (size_t)(len - sent), 0);
    if (n <= 0) return -1;
    sent += n;
  }
  return 0;
}

/* Bidirectional relay until either side closes or errors. */
static void relay(int a, int b) {
  char buf[BUF_SIZE];
  fd_set rfds;
  int maxfd = a > b ? a : b;

  for (;;) {
    FD_ZERO(&rfds);
    FD_SET(a, &rfds);
    FD_SET(b, &rfds);

    if (select(maxfd + 1, &rfds, NULL, NULL, NULL) <= 0) break;

    if (FD_ISSET(a, &rfds)) {
      ssize_t n = recv(a, buf, BUF_SIZE, 0);
      if (n <= 0 || send_all(b, buf, n) < 0) break;
    }
    if (FD_ISSET(b, &rfds)) {
      ssize_t n = recv(b, buf, BUF_SIZE, 0);
      if (n <= 0 || send_all(a, buf, n) < 0) break;
    }
  }
}

static void *handle_conn(void *arg) {
  struct conn *c = arg;
  relay(c->left_fd, c->right_fd);
  close(c->left_fd);
  close(c->right_fd);
  free(c);
  return NULL;
}

static void spawn_relay(int left_fd, int right_fd) {
  struct conn *c = malloc(sizeof(*c));
  if (!c) {
    close(left_fd);
    close(right_fd);
    return;
  }
  c->left_fd = left_fd;
  c->right_fd = right_fd;

  pthread_t tid;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&tid, &attr, handle_conn, c) != 0) {
    close(left_fd);
    close(right_fd);
    free(c);
  }
  pthread_attr_destroy(&attr);
}

static int run_ingress(const char *unix_path, const char *raw_vsock_port) {
  g_unix_path = unix_path;
  unsigned int port = 0;
  if (parse_port(raw_vsock_port, "vsock_port", &port) < 0) return 1;

  int srv = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (srv < 0) {
    perror("socket(AF_VSOCK)");
    return 1;
  }

  struct sockaddr_vm vaddr;
  memset(&vaddr, 0, sizeof(vaddr));
  vaddr.svm_family = AF_VSOCK;
  vaddr.svm_port   = port;
  vaddr.svm_cid    = VMADDR_CID_ANY;

  if (bind(srv, (struct sockaddr *)&vaddr, sizeof(vaddr)) < 0) {
    perror("bind vsock");
    return 1;
  }
  if (listen(srv, 16) < 0) {
    perror("listen vsock");
    return 1;
  }

  fprintf(stdout, "[vsock_proxy] port %u → %s\n", port, g_unix_path);
  fflush(stdout);

  for (;;) {
    int client = accept(srv, NULL, NULL);
    if (client < 0) continue;

    int ufd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (ufd < 0) {
      close(client);
      continue;
    }

    struct sockaddr_un uaddr;
    memset(&uaddr, 0, sizeof(uaddr));
    uaddr.sun_family = AF_UNIX;
    strncpy(uaddr.sun_path, g_unix_path, sizeof(uaddr.sun_path) - 1);

    if (connect(ufd, (struct sockaddr *)&uaddr, sizeof(uaddr)) < 0) {
      close(client);
      close(ufd);
      continue;
    }

    spawn_relay(client, ufd);
  }

  return 0;
}

static int connect_parent_vsock(unsigned int host_vsock_port) {
  int vfd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (vfd < 0) {
    perror("socket(AF_VSOCK)");
    return -1;
  }

  struct sockaddr_vm vaddr;
  memset(&vaddr, 0, sizeof(vaddr));
  vaddr.svm_family = AF_VSOCK;
  vaddr.svm_cid = NITRO_PARENT_CID;
  vaddr.svm_port = host_vsock_port;

  if (connect(vfd, (struct sockaddr *)&vaddr, sizeof(vaddr)) < 0) {
    perror("connect parent vsock");
    close(vfd);
    return -1;
  }

  return vfd;
}

static int run_egress(
  const char *listen_addr,
  const char *raw_listen_port,
  const char *raw_host_vsock_port
) {
  unsigned int listen_port = 0;
  unsigned int host_vsock_port = 0;
  if (parse_port(raw_listen_port, "listen_port", &listen_port) < 0) return 1;
  if (parse_port(raw_host_vsock_port, "host_vsock_port", &host_vsock_port) < 0) {
    return 1;
  }

  /*
   * Configure the alias before bind(). Do not rely on IP_FREEBIND here: it can
   * create a visible listener while leaving the address absent from lo in the
   * minimal enclave network namespace.
   */
  if (add_loopback_address(listen_addr) < 0) return 1;

  int srv = socket(AF_INET, SOCK_STREAM, 0);
  if (srv < 0) {
    perror("socket(AF_INET)");
    return 1;
  }

  int reuse = 1;
  if (setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0) {
    perror("setsockopt SO_REUSEADDR");
    close(srv);
    return 1;
  }

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)listen_port);
  if (inet_pton(AF_INET, listen_addr, &addr.sin_addr) != 1) {
    fprintf(stderr, "Invalid listen_addr: %s\n", listen_addr);
    close(srv);
    return 1;
  }

  if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    perror("bind tcp");
    close(srv);
    return 1;
  }
  if (listen(srv, 16) < 0) {
    perror("listen tcp");
    close(srv);
    return 1;
  }

  fprintf(
    stdout,
    "[vsock_proxy] %s:%u → parent:%u\n",
    listen_addr,
    listen_port,
    host_vsock_port
  );
  fflush(stdout);

  for (;;) {
    int client = accept(srv, NULL, NULL);
    if (client < 0) continue;

    int vfd = connect_parent_vsock(host_vsock_port);
    if (vfd < 0) {
      close(client);
      continue;
    }

    spawn_relay(client, vfd);
  }

  return 0;
}

static void print_usage(const char *bin) {
  fprintf(stderr, "Usage:\n");
  fprintf(stderr, "  %s <unix_path> <vsock_port>\n", bin);
  fprintf(stderr, "  %s egress <listen_addr> <listen_port> <host_vsock_port>\n", bin);
}

int main(int argc, char *argv[]) {
  signal(SIGPIPE, SIG_IGN);

  if (argc == 3) {
    return run_ingress(argv[1], argv[2]);
  }

  if (argc == 5 && strcmp(argv[1], "egress") == 0) {
    return run_egress(argv[2], argv[3], argv[4]);
  }

  print_usage(argv[0]);
  return 1;
}

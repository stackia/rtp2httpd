# Build stage
FROM --platform=$BUILDPLATFORM debian:bullseye-slim AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM

# Install build dependencies
RUN set -ex; \
  apt-get update; \
  apt-get install -y \
  ca-certificates \
  curl \
  gnupg; \
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
  apt-get install -y \
  autoconf \
  automake \
  pkg-config \
  nodejs; \
  case "$TARGETPLATFORM" in \
  "$BUILDPLATFORM") apt-get install -y build-essential ;; \
  "linux/arm64") \
  dpkg --add-architecture arm64 && \
  apt-get install -y \
  crossbuild-essential-arm64 \
  gcc-aarch64-linux-gnu ;; \
  "linux/arm/v7") \
  dpkg --add-architecture armhf && \
  apt-get install -y \
  crossbuild-essential-armhf \
  gcc-arm-linux-gnueabihf ;; \
  "linux/amd64") \
  dpkg --add-architecture amd64 && \
  apt-get install -y \
  crossbuild-essential-amd64 \
  gcc-x86-64-linux-gnu ;; \
  *) echo "Unsupported platform combination: $BUILDPLATFORM -> $TARGETPLATFORM" && exit 1 ;; \
  esac && \
  rm -rf /var/lib/apt/lists/*

# Copy source code
WORKDIR /workdir
COPY . .

RUN set -ex; \
  cd web-ui; \
  npm ci; \
  npm run build; \
  cd ..; \
  node scripts/embed_status_page.js web-ui/dist/index.html src/status_page.h; \
  rm -rf web-ui/node_modules web-ui/dist

RUN case "$TARGETPLATFORM" in \
  "$BUILDPLATFORM") ARCH_FLAGS="" ;; \
  "linux/amd64")  ARCH_FLAGS="--host=x86_64-linux-gnu" ;; \
  "linux/arm64")  ARCH_FLAGS="--host=aarch64-linux-gnu" ;; \
  "linux/arm/v7") ARCH_FLAGS="--host=arm-linux-gnueabihf" ;; \
  esac && \
  echo "Building with ARCH_FLAGS=$ARCH_FLAGS" && \
  autoreconf -fi && \
  ./configure ${ARCH_FLAGS} && \
  make

# Runtime stage
FROM debian:bullseye-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
  libgcc1 \
  && rm -rf /var/lib/apt/lists/*

# Copy the built binary and config
COPY --from=builder /workdir/src/rtp2httpd /usr/local/bin/
COPY --from=builder /workdir/rtp2httpd.conf /usr/local/etc/

# Expose the default port
EXPOSE 5140

# Important: This application requires MSG_ZEROCOPY support which needs locked memory.
# Docker containers must be run with --ulimit memlock=-1:-1 to allow MSG_ZEROCOPY to work.
#
# Example:
#   docker run --network=host --ulimit memlock=-1:-1 --rm ghcr.io/stackia/rtp2httpd:latest
#
# Without this ulimit setting, you will experience ENOBUFS errors and clients won't receive data.

# Run the application
ENTRYPOINT ["/usr/local/bin/rtp2httpd"]

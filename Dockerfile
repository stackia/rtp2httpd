# Build stage
FROM --platform=$BUILDPLATFORM debian:bullseye-slim AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM

# Install build dependencies
RUN set -ex; \
  apt-get update; \
  apt-get install -y \
  autoconf \
  automake \
  pkg-config; \
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

RUN case "$TARGETPLATFORM" in \
  "$BUILDPLATFORM") ARCH_FLAGS="" ;; \
  "linux/amd64")  ARCH_FLAGS="--host=x86_64-linux-gnu" ;; \
  "linux/arm64")  ARCH_FLAGS="--host=aarch64-linux-gnu" ;; \
  "linux/arm/v7") ARCH_FLAGS="--host=arm-linux-gnueabihf" ;; \
  esac && \
  echo "Building with ARCH_FLAGS=$ARCH_FLAGS" && \
  autoreconf -fi && \
  ./configure --enable-optimization=-O3 ${ARCH_FLAGS} && \
  make

# Runtime stage
FROM debian:bullseye-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
  libgcc1 curl \
  && rm -rf /var/lib/apt/lists/*

# Copy the built binary and config
COPY --from=builder /workdir/src/rtp2httpd /usr/local/bin/
COPY --from=builder /workdir/rtp2httpd.conf /usr/local/etc/

# Expose the default port
EXPOSE 5140

# Important: When using --zerocopy-on-send option, you must add --ulimit memlock=-1:-1
# MSG_ZEROCOPY requires locked memory pages. Without this ulimit, you will get ENOBUFS errors.
#
# Basic usage (default, no zero-copy):
#   docker run --network=host --rm ghcr.io/stackia/rtp2httpd:latest
#
# With zero-copy enabled:
#   docker run --network=host --ulimit memlock=-1:-1 --rm \
#     ghcr.io/stackia/rtp2httpd:latest --zerocopy-on-send

# Run the application
ENTRYPOINT ["/usr/local/bin/rtp2httpd"]

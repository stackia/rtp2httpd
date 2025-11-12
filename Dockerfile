# Build stage
FROM --platform=$BUILDPLATFORM alpine:3 AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG RELEASE_VERSION

# Install build dependencies
RUN set -ex; \
  apk add --no-cache \
  autoconf \
  automake \
  pkgconfig \
  make \
  libc-dev \
  linux-headers; \
  case "$TARGETPLATFORM" in \
  "$BUILDPLATFORM") apk add --no-cache gcc ;; \
  "linux/arm64") \
  apk add --no-cache \
  gcc-aarch64-none-elf \
  binutils-aarch64-none-elf || \
  apk add --no-cache gcc ;; \
  "linux/arm/v7") \
  apk add --no-cache \
  gcc-arm-none-eabi \
  binutils-arm-none-eabi || \
  apk add --no-cache gcc ;; \
  "linux/amd64") \
  apk add --no-cache gcc ;; \
  *) echo "Unsupported platform combination: $BUILDPLATFORM -> $TARGETPLATFORM" && exit 1 ;; \
  esac

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
  echo "Building with RELEASE_VERSION=$RELEASE_VERSION" && \
  RELEASE_VERSION=${RELEASE_VERSION} autoreconf -fi && \
  ./configure --enable-optimization=-O3 ${ARCH_FLAGS} && \
  make

# Runtime stage
FROM alpine:3

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

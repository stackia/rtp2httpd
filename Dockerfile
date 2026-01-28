# Build stage
FROM alpine:3.22 AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG RELEASE_VERSION

# Install build dependencies
RUN apk add --no-cache \
  autoconf \
  automake \
  pkgconfig \
  make \
  gcc \
  musl-dev \
  linux-headers

# Copy source code
WORKDIR /workdir
COPY . .

# Build natively on target platform (using QEMU when cross-building)
RUN echo "Building for $TARGETPLATFORM" && \
  echo "RELEASE_VERSION=$RELEASE_VERSION" && \
  RELEASE_VERSION=${RELEASE_VERSION} autoreconf -fi && \
  ./configure --enable-optimization=-O3 && \
  make

# Runtime stage
FROM alpine:3.22

# Copy the built binary and config
COPY --from=builder /workdir/src/rtp2httpd /usr/local/bin/
COPY --from=builder /workdir/rtp2httpd.conf /usr/local/etc/

# Expose the default port
EXPOSE 5140

# Recommended options:
#   --cap-add=NET_ADMIN: Allow setting larger UDP receive buffers (bypassing rmem_max via SO_RCVBUFFORCE)
#   --ulimit memlock=-1:-1: Required for zero-copy (MSG_ZEROCOPY needs locked memory pages)
#
# Usage:
#   docker run --network=host --cap-add=NET_ADMIN --ulimit memlock=-1:-1 --rm \
#     ghcr.io/stackia/rtp2httpd:latest

# Run the application
ENTRYPOINT ["/usr/local/bin/rtp2httpd"]

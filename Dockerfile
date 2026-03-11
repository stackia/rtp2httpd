# Build stage
FROM alpine:3.22 AS builder

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG RELEASE_VERSION

# Install build dependencies
RUN apk add --no-cache \
  cmake \
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
  RELEASE_VERSION="${RELEASE_VERSION}" cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_AGGRESSIVE_OPT=ON \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DCMAKE_INSTALL_SYSCONFDIR=/usr/local/etc && \
  cmake --build build -j$(getconf _NPROCESSORS_ONLN)

# Runtime stage
FROM alpine:3.22

# Copy the built binary and config
COPY --from=builder /workdir/build/rtp2httpd /usr/local/bin/
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

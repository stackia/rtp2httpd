# Build stage
FROM alpine:3 AS builder

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

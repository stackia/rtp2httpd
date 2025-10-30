#!/bin/bash
# Build script for static-linked musl binary
# This script automatically downloads musl toolchain and builds rtp2httpd with static linking

set -e  # Exit on error

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Toolchain configuration (can be overridden by environment variables)
TOOLCHAIN_RELEASE="20250929"
TOOLCHAIN_PREFIX="${TOOLCHAIN_PREFIX:-x86_64-unknown-linux-musl}"
TOOLCHAIN_BASE_URL="https://github.com/cross-tools/musl-cross/releases/download"

# Derived paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"
TOOLCHAIN_ROOT="${PROJECT_ROOT}/toolchain"
TOOLCHAIN_DIR="${TOOLCHAIN_ROOT}/${TOOLCHAIN_PREFIX}"
TOOLCHAIN_ARCHIVE="${TOOLCHAIN_PREFIX}.tar.xz"
TOOLCHAIN_URL="${TOOLCHAIN_BASE_URL}/${TOOLCHAIN_RELEASE}/${TOOLCHAIN_ARCHIVE}"
SYSROOT="${TOOLCHAIN_DIR}/${TOOLCHAIN_PREFIX}/sysroot"

# Build configuration
BUILD_DIR="build-${TOOLCHAIN_PREFIX}-static"

echo_step "Toolchain Configuration"
echo_info "Release: ${TOOLCHAIN_RELEASE}"
echo_info "Prefix: ${TOOLCHAIN_PREFIX}"
echo_info "Target directory: ${TOOLCHAIN_DIR}"
echo ""

# Download and extract toolchain if needed
if [ -f "${TOOLCHAIN_DIR}/bin/${TOOLCHAIN_PREFIX}-gcc" ]; then
    echo_info "Toolchain already exists, skipping download"
else
    echo_step "Downloading Toolchain"

    # Create toolchain directory
    mkdir -p "${TOOLCHAIN_ROOT}"

    # Download toolchain
    echo_info "Downloading from: ${TOOLCHAIN_URL}"
    if command -v wget &> /dev/null; then
        wget -O "${TOOLCHAIN_ROOT}/${TOOLCHAIN_ARCHIVE}" "${TOOLCHAIN_URL}"
    elif command -v curl &> /dev/null; then
        curl -L -o "${TOOLCHAIN_ROOT}/${TOOLCHAIN_ARCHIVE}" "${TOOLCHAIN_URL}"
    else
        echo_error "Neither wget nor curl found. Please install one of them."
        exit 1
    fi

    # Extract toolchain
    echo_info "Extracting toolchain..."
    tar -xf "${TOOLCHAIN_ROOT}/${TOOLCHAIN_ARCHIVE}" -C "${TOOLCHAIN_ROOT}"

    # Remove archive to save space
    echo_info "Cleaning up archive..."
    rm -f "${TOOLCHAIN_ROOT}/${TOOLCHAIN_ARCHIVE}"

    echo_info "Toolchain downloaded and extracted successfully"
fi

# Verify toolchain
echo ""
echo_step "Verifying Toolchain"
if [ ! -f "${TOOLCHAIN_DIR}/bin/${TOOLCHAIN_PREFIX}-gcc" ]; then
    echo_error "GCC not found: ${TOOLCHAIN_DIR}/bin/${TOOLCHAIN_PREFIX}-gcc"
    exit 1
fi

echo_info "GCC version:"
${TOOLCHAIN_DIR}/bin/${TOOLCHAIN_PREFIX}-gcc --version | head -1

# Add toolchain to PATH
export PATH="${TOOLCHAIN_DIR}/bin:${PATH}"

# Verify static libraries exist
echo_info "Checking for static libraries..."
if [ ! -f "${SYSROOT}/usr/lib/libc.a" ]; then
    echo_error "Static libc.a not found in sysroot"
    exit 1
fi
if [ ! -f "${SYSROOT}/usr/lib/libpthread.a" ]; then
    echo_error "Static libpthread.a not found in sysroot"
    exit 1
fi
echo_info "✓ Static libraries found: libc.a, libpthread.a"

# Clean previous build
echo ""
echo_step "Preparing Build"
if [ -d "$BUILD_DIR" ]; then
    echo_warn "Removing previous build directory: $BUILD_DIR"
    rm -rf "$BUILD_DIR"
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo ""
echo_step "Configuring Build"
echo_info "Build directory: $(pwd)"
echo_info "Optimization level: -O3 (optimize for performance)"
if [ -n "$RELEASE_VERSION" ]; then
    echo_info "Version: $RELEASE_VERSION"
fi

# Configure with static linking
# Key flags:
# -static: Create fully static binary
# -O3: Optimize for performance
# --sysroot: Use musl sysroot
# -ffunction-sections -fdata-sections: Allow linker to remove unused code
# -Wl,--gc-sections: Remove unused sections
# -Wl,-s: Strip symbols (smaller binary)
RELEASE_VERSION="${RELEASE_VERSION}" "${PROJECT_ROOT}/configure" \
    --host=${TOOLCHAIN_PREFIX} \
    --prefix=/usr \
    --sysconfdir=/etc \
    CC="${TOOLCHAIN_PREFIX}-gcc" \
    AR="${TOOLCHAIN_PREFIX}-ar" \
    RANLIB="${TOOLCHAIN_PREFIX}-ranlib" \
    STRIP="${TOOLCHAIN_PREFIX}-strip" \
    CFLAGS="-static --sysroot=${SYSROOT}" \
    LDFLAGS="-static --sysroot=${SYSROOT}" \
    --enable-optimization=-O3

echo ""
echo_step "Building"
make -j$(nproc)

echo ""
echo_step "Build Completed Successfully!"

# Verify the binary
BINARY="src/rtp2httpd"
if [ ! -f "$BINARY" ]; then
    echo_error "Binary not found: $BINARY"
    exit 1
fi

echo ""
echo_step "Binary Verification"
echo_info "File information:"
file "$BINARY"
echo ""

echo_info "Binary size:"
ls -lh "$BINARY" | awk '{print $5 "  " $9}'
echo ""

echo_info "Verifying static linking..."
if file "$BINARY" | grep -q "statically linked"; then
    echo_info "✓ Binary is statically linked"
else
    echo_warn "⚠ Binary may not be fully statically linked"
    echo_info "Checking dynamic dependencies:"
    ${TOOLCHAIN_PREFIX}-readelf -d "$BINARY" 2>/dev/null || ldd "$BINARY" 2>/dev/null || true
fi

echo ""
echo_info "Checking for musl libc..."
if strings "$BINARY" | grep -q "musl"; then
    echo_info "✓ Binary contains musl libc"
fi

echo ""
echo_step "=== Build Summary ==="
echo_info "Binary: $(pwd)/$BINARY"
echo_info "Size: $(stat -c%s "$BINARY" | numfmt --to=iec-i --suffix=B 2>/dev/null || stat -f%z "$BINARY" 2>/dev/null || echo "unknown")"
echo_info "Architecture: ${TOOLCHAIN_PREFIX%%-*}"
echo_info "Libc: musl (static)"
echo_info "Optimization: -O3 (performance)"
echo_info "Toolchain: ${TOOLCHAIN_PREFIX} (${TOOLCHAIN_RELEASE})"
if [ -n "$RELEASE_VERSION" ]; then
    echo_info "Version: $RELEASE_VERSION"
fi
echo ""
echo_info "To test on target device:"
echo_info "  scp $(pwd)/$BINARY root@target:/usr/bin/"
echo_info "  ssh root@target '/usr/bin/rtp2httpd --version'"


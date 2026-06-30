#!/bin/sh
set -eu

export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(dirname "$SCRIPT_DIR")
SUPPORT_DIR="$PROJECT_ROOT/ikuai-support"
PACKAGE_SRC="$SUPPORT_DIR/rtp2httpd"
STAGING_ROOT="$SUPPORT_DIR/.staging"
STAGING_PACKAGE="$STAGING_ROOT/rtp2httpd"
DIST_DIR="$SUPPORT_DIR/dist"
MANIFEST="$PACKAGE_SRC/manifest.json"
ICON_SOURCE="$PROJECT_ROOT/web-ui/public/assets/icon.png"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
VERSION=${1:-$VERSION}

if [ -z "$VERSION" ]; then
  echo "Version is required" >&2
  exit 1
fi

download_binary() {
  arch=$1
  output=$2
  binary_name="rtp2httpd-$VERSION-$arch"
  release_url="https://github.com/stackia/rtp2httpd/releases/download/v$VERSION/$binary_name"

  if command -v curl >/dev/null 2>&1; then
    curl -fL "$release_url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$output" "$release_url"
  else
    echo "curl or wget is required unless local binary paths are set" >&2
    exit 1
  fi
}

binary_path_for_arch() {
  arch=$1

  case "$arch" in
  aarch64) path=${BINARY_PATH_AARCH64:-} ;;
  x86_64) path=${BINARY_PATH_X86_64:-} ;;
  *)
    echo "Unsupported arch: $arch" >&2
    exit 1
    ;;
  esac

  if [ -z "$path" ] && [ -n "${BINARY_DIR:-}" ]; then
    for candidate in \
      "$BINARY_DIR/rtp2httpd-$VERSION-$arch" \
      "$BINARY_DIR/rtp2httpd-$arch" \
      "$BINARY_DIR/$arch/rtp2httpd"; do
      if [ -f "$candidate" ]; then
        path=$candidate
        break
      fi
    done
  fi

  printf '%s' "$path"
}

rm -rf "$STAGING_ROOT"
mkdir -p "$STAGING_PACKAGE" "$DIST_DIR"
cp -R "$PACKAGE_SRC"/. "$STAGING_PACKAGE"/
find "$STAGING_PACKAGE" -name .gitkeep -exec rm -f {} +
rm -f "$STAGING_PACKAGE/app/bin/rtp2httpd"

# Keep the staged manifest in sync with the requested version.
sed -e "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"version\": \"$VERSION\"/" \
  "$MANIFEST" > "$STAGING_PACKAGE/manifest.json"

if [ ! -f "$ICON_SOURCE" ]; then
  echo "Icon source does not exist: $ICON_SOURCE" >&2
  exit 1
fi
mkdir -p "$STAGING_PACKAGE/ui/ico"
rm -f "$STAGING_PACKAGE/ui/ico/app.png"
cp "$ICON_SOURCE" "$STAGING_PACKAGE/ui/ico/app.png"

for arch in aarch64 x86_64; do
  output="$STAGING_PACKAGE/app/bin/rtp2httpd-$arch"
  binary_path=$(binary_path_for_arch "$arch")

  if [ -n "$binary_path" ]; then
    if [ ! -f "$binary_path" ]; then
      echo "Binary path does not exist for $arch: $binary_path" >&2
      exit 1
    fi
    cp "$binary_path" "$output"
  else
    download_binary "$arch" "$output"
  fi

  chmod 755 "$output"
done

for required_arch in aarch64 x86_64; do
  if [ ! -x "$STAGING_PACKAGE/app/bin/rtp2httpd-$required_arch" ]; then
    echo "Required binary is missing: app/bin/rtp2httpd-$required_arch" >&2
    exit 1
  fi
done

chmod 755 "$STAGING_PACKAGE"/scripts/*.sh

OUTPUT="$DIST_DIR/rtp2httpd-$VERSION-ikuai.ipkg"
(
  cd "$STAGING_ROOT"
  tar -czf "$OUTPUT" rtp2httpd
)

echo "$OUTPUT"

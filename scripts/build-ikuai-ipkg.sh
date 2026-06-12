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
ARCH=${2:-x86_64}

if [ -z "$VERSION" ]; then
  echo "Version is required" >&2
  exit 1
fi

BINARY_NAME="rtp2httpd-$VERSION-$ARCH"
RELEASE_URL="https://github.com/stackia/rtp2httpd/releases/download/v$VERSION/$BINARY_NAME"

rm -rf "$STAGING_ROOT"
mkdir -p "$STAGING_PACKAGE" "$DIST_DIR"
cp -R "$PACKAGE_SRC"/. "$STAGING_PACKAGE"/
find "$STAGING_PACKAGE" -name .gitkeep -exec rm -f {} +

# Keep the staged manifest in sync with the requested version and arch.
sed -e "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"version\": \"$VERSION\"/" \
  -e "s/\"image\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"image\": \"$BINARY_NAME\"/" \
  "$MANIFEST" > "$STAGING_PACKAGE/manifest.json"

if [ ! -f "$ICON_SOURCE" ]; then
  echo "Icon source does not exist: $ICON_SOURCE" >&2
  exit 1
fi
mkdir -p "$STAGING_PACKAGE/ui/ico"
rm -f "$STAGING_PACKAGE/ui/ico/app.png"
cp "$ICON_SOURCE" "$STAGING_PACKAGE/ui/ico/app.png"

if [ -n "${BINARY_PATH:-}" ]; then
  if [ ! -f "$BINARY_PATH" ]; then
    echo "BINARY_PATH does not exist: $BINARY_PATH" >&2
    exit 1
  fi
  cp "$BINARY_PATH" "$STAGING_PACKAGE/app/bin/rtp2httpd"
else
  if command -v curl >/dev/null 2>&1; then
    curl -fL "$RELEASE_URL" -o "$STAGING_PACKAGE/app/bin/rtp2httpd"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$STAGING_PACKAGE/app/bin/rtp2httpd" "$RELEASE_URL"
  else
    echo "curl or wget is required unless BINARY_PATH is set" >&2
    exit 1
  fi
fi

chmod 755 "$STAGING_PACKAGE/app/bin/rtp2httpd"
chmod 755 "$STAGING_PACKAGE"/scripts/*.sh

OUTPUT="$DIST_DIR/rtp2httpd-$VERSION-$ARCH.ipkg"
(
  cd "$STAGING_ROOT"
  tar -czf "$OUTPUT" rtp2httpd
)

echo "$OUTPUT"

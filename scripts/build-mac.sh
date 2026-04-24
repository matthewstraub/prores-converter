#!/bin/bash
set -e

# ============================================================
# ProRes Converter — macOS Build Script
# ============================================================
# This script:
# 1. Downloads static FFmpeg/FFprobe binaries for macOS (arm64 + x64)
# 2. Builds the web app frontend (Vite)
# 3. Builds a self-contained server bundle (esbuild, all deps inlined)
# 4. Packages everything into a .dmg with electron-builder
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/electron/bin"

echo "========================================"
echo "  ProRes Converter — macOS Build"
echo "========================================"
echo ""

cd "$PROJECT_DIR"

# ---- Step 1: Check prerequisites ----
echo "→ Checking prerequisites..."

if ! command -v node &> /dev/null; then
  echo "✗ Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
  exit 1
fi

if ! command -v pnpm &> /dev/null; then
  echo "→ Installing pnpm..."
  npm install -g pnpm
fi

echo "  Node.js $(node -v)"
echo "  pnpm $(pnpm -v)"
echo ""

# ---- Step 2: Install dependencies ----
echo "→ Installing dependencies..."
pnpm install
echo ""

# ---- Step 3: Download FFmpeg static binaries ----
echo "→ Downloading FFmpeg binaries for macOS..."

FFMPEG_VERSION="7.1"

# Create bin directories
mkdir -p "$BIN_DIR/mac/arm64"
mkdir -p "$BIN_DIR/mac/x64"

# Function to download and extract FFmpeg for a given architecture
download_ffmpeg() {
  local ARCH=$1
  local TARGET_DIR="$BIN_DIR/mac/$ARCH"

  if [ -f "$TARGET_DIR/ffmpeg" ] && [ -f "$TARGET_DIR/ffprobe" ]; then
    echo "  ✓ FFmpeg binaries already exist for $ARCH, skipping download."
    return
  fi

  echo "  Downloading FFmpeg for macOS $ARCH..."

  if [ "$ARCH" = "arm64" ]; then
    # Download from evermeet.cx (trusted macOS FFmpeg builds)
    local FFMPEG_URL="https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip"
    local FFPROBE_URL="https://evermeet.cx/ffmpeg/ffprobe-${FFMPEG_VERSION}.zip"
  else
    local FFMPEG_URL="https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip"
    local FFPROBE_URL="https://evermeet.cx/ffmpeg/ffprobe-${FFMPEG_VERSION}.zip"
  fi

  local TEMP_DIR=$(mktemp -d)

  # Try evermeet.cx first, fall back to system ffmpeg wrapper
  if curl -fsSL -o "$TEMP_DIR/ffmpeg.zip" "$FFMPEG_URL" 2>/dev/null; then
    unzip -o -q "$TEMP_DIR/ffmpeg.zip" -d "$TARGET_DIR"
    curl -fsSL -o "$TEMP_DIR/ffprobe.zip" "$FFPROBE_URL"
    unzip -o -q "$TEMP_DIR/ffprobe.zip" -d "$TARGET_DIR"
  else
    echo "  ⚠ Could not download from evermeet.cx, using system ffmpeg wrapper..."
    echo '#!/bin/bash' > "$TARGET_DIR/ffmpeg"
    echo 'exec /opt/homebrew/bin/ffmpeg "$@" 2>/dev/null || exec /usr/local/bin/ffmpeg "$@" 2>/dev/null || exec ffmpeg "$@"' >> "$TARGET_DIR/ffmpeg"
    echo '#!/bin/bash' > "$TARGET_DIR/ffprobe"
    echo 'exec /opt/homebrew/bin/ffprobe "$@" 2>/dev/null || exec /usr/local/bin/ffprobe "$@" 2>/dev/null || exec ffprobe "$@"' >> "$TARGET_DIR/ffprobe"
  fi

  chmod +x "$TARGET_DIR/ffmpeg" "$TARGET_DIR/ffprobe"
  rm -rf "$TEMP_DIR"

  echo "  ✓ FFmpeg binaries ready for $ARCH"
}

download_ffmpeg "arm64"
download_ffmpeg "x64"
echo ""

# ---- Step 4: Build the web app frontend ----
echo "→ Building web app frontend (Vite)..."
pnpm build
echo ""

# ---- Step 5: Build self-contained server bundle for Electron ----
echo "→ Building self-contained server bundle for Electron..."
node scripts/build-electron-server.mjs
# Copy the frontend build into the electron server directory
cp -r dist/public dist-electron/public
echo "  ✓ Server bundle ready in dist-electron/"
echo ""

# ---- Step 6: Build the Electron app ----
echo "→ Packaging Electron app..."

# Detect current Mac architecture for the build
CURRENT_ARCH=$(uname -m)
if [ "$CURRENT_ARCH" = "arm64" ]; then
  ELECTRON_ARCH="arm64"
else
  ELECTRON_ARCH="x64"
fi

echo "  Building for macOS $ELECTRON_ARCH..."

npx electron-builder --mac --config electron-builder.config.cjs --$ELECTRON_ARCH

echo ""
echo "========================================"
echo "  ✓ Build complete!"
echo "========================================"
echo ""
echo "  Output: $PROJECT_DIR/release/"
echo ""
ls -lh "$PROJECT_DIR/release/"*.dmg 2>/dev/null || echo "  (Check the release/ directory for output files)"
echo ""
echo "  To install: Open the .dmg and drag ProRes Converter to Applications."
echo ""

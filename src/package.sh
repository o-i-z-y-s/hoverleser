#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# hoverleser – package.sh
#
# Commands:
#   bash package.sh sign             Sign via Mozilla's AMO API (unlisted channel)
#                                    Produces dist/hoverleser-x.x.x-firefox.xpi
#                                    Requires: AMO_API_KEY and AMO_API_SECRET env vars
#                                    Get credentials at https://addons.mozilla.org/developers/addon/api/key/
#
#   bash package.sh chrome           Build dist/hoverleser-x.x.x-chrome.zip (Chrome/Chromium)
#                                    Upload the zip to the Chrome Web Store Developer Console.
#
#   bash package.sh help             Show this message
#
# Requirements:
#   sign   – Node.js 16+ and npm (to install web-ext on first run)
#   chrome – bash + zip (standard on macOS/Linux; use Git Bash on Windows)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Read version from manifest ────────────────────────────────────────────────
if command -v node &>/dev/null; then
  VERSION=$(node -e "process.stdout.write(require('./manifest.json').version)")
else
  VERSION=$(grep '"version"' manifest.json | sed 's/.*"\([0-9.]*\)".*/\1/')
fi

OUT_DIR="dist"
mkdir -p "$OUT_DIR"

# ─────────────────────────────────────────────────────────────────────────────
cmd_sign() {
  if [[ -z "${AMO_API_KEY:-}" ]] || [[ -z "${AMO_API_SECRET:-}" ]]; then
    echo ""
    echo "  Error: AMO_API_KEY and AMO_API_SECRET must be set."
    echo ""
    echo "  Get your credentials at:"
    echo "    https://addons.mozilla.org/developers/addon/api/key/"
    echo ""
    echo "  Then run:"
    echo "    AMO_API_KEY=user:12345:678 AMO_API_SECRET=abc123... bash package.sh sign"
    echo ""
    exit 1
  fi

  local FIREFOX_XPI="$SCRIPT_DIR/$OUT_DIR/hoverleser-$VERSION-firefox.xpi"

  if ! command -v web-ext &>/dev/null && [[ ! -f node_modules/.bin/web-ext ]]; then
    echo "Installing web-ext (Mozilla's official signing tool)..."
    npm install --save-dev web-ext --silent
    echo ""
  fi

  local WEBEXT
  if command -v web-ext &>/dev/null; then
    WEBEXT="web-ext"
  else
    WEBEXT="./node_modules/.bin/web-ext"
  fi

  echo "Signing hoverleser v$VERSION via Mozilla AMO (unlisted channel)..."
  echo "(This typically takes 10-60 seconds)"
  echo ""

  # web-ext sign builds from source, submits to AMO, downloads the signed xpi.
  $WEBEXT sign \
    --source-dir . \
    --artifacts-dir "$OUT_DIR" \
    --channel unlisted \
    --api-key "$AMO_API_KEY" \
    --api-secret "$AMO_API_SECRET" \
    --ignore-files \
      "package.sh" "package.bat" "package.json" "package-lock.json" \
      "node_modules/**" "dist/**" "scripts/**" "README.md" ".git/**"

  # web-ext names the output after the extension ID; rename to our convention
  local SIGNED
  SIGNED=$(find "$OUT_DIR" -maxdepth 1 -name "*.xpi" ! -name "hoverleser-*-firefox.xpi" | head -1)
  if [[ -n "$SIGNED" ]]; then
    mv "$SIGNED" "$FIREFOX_XPI"
    local size
    size=$(du -h "$FIREFOX_XPI" | cut -f1)
    echo ""
    echo "  ✓  $FIREFOX_XPI  ($size)"
  else
    echo "  ✓  Signed XPI written to $OUT_DIR/"
  fi
  echo ""
  echo "  This signed build installs in any release version of Firefox."
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
cmd_build_chrome() {
  local POLYFILL="lib/browser-polyfill.min.js"
  if [[ ! -f "$POLYFILL" ]]; then
    echo "Error: $POLYFILL not found."
    echo "See README.md (Vendored dependency section) for how to obtain and verify it."
    exit 1
  fi

  local STAGE="$SCRIPT_DIR/$OUT_DIR/.chrome-stage"
  local ZIP="$SCRIPT_DIR/$OUT_DIR/hoverleser-$VERSION-chrome.zip"
  rm -rf "$STAGE" "$ZIP"
  mkdir -p "$STAGE/icons" "$STAGE/lib"

  echo "Building hoverleser Chrome v$VERSION..."

  cp manifest.chrome.json        "$STAGE/manifest.json"
  cp background.js content.js popup.html popup.js "$STAGE/"
  cp icons/icon128.png           "$STAGE/icons/"
  cp lib/browser-polyfill.min.js "$STAGE/lib/"

  (cd "$STAGE" && zip -qr "$ZIP" .)
  rm -rf "$STAGE"

  local size
  size=$(du -h "$ZIP" | cut -f1)
  echo ""
  echo "  ✓  $ZIP  ($size)  [unsigned; submit to Chrome Web Store]"
  echo ""
  echo "  Upload at: https://chrome.google.com/webstore/devconsole"
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
cmd_help() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
}

# ─────────────────────────────────────────────────────────────────────────────
case "${1:-help}" in
  sign)   cmd_sign ;;
  chrome) cmd_build_chrome ;;
  help|--help|-h) cmd_help ;;
  *) echo "Unknown command: $1  (try: sign, chrome, help)"; exit 1 ;;
esac

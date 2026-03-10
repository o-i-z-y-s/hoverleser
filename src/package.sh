#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# hoverleser – package.sh
#
# Commands:
#   bash package.sh build            Build dist/hoverleser-<version>.xpi
#                                    (unsigned, for Firefox Dev Edition / Nightly)
#
#   bash package.sh sign             Sign via Mozilla's AMO API (unlisted channel)
#                                    Produces a signed .xpi you can distribute to
#                                    any Firefox release build.
#                                    Requires: AMO_API_KEY and AMO_API_SECRET env vars
#                                    Get credentials at https://addons.mozilla.org/developers/addon/api/key/
#
#   bash package.sh help             Show this message
#
# Requirements:
#   build  – bash + zip (standard on macOS/Linux; use Git Bash on Windows)
#   sign   – Node.js 16+ and npm (to install web-ext on first run)
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
XPI_UNSIGNED="$OUT_DIR/hoverleser-$VERSION.xpi"

mkdir -p "$OUT_DIR"

# ─────────────────────────────────────────────────────────────────────────────
cmd_build() {
  echo "Building hoverleser v$VERSION..."

  rm -f "$XPI_UNSIGNED"

  zip -q "$XPI_UNSIGNED" \
    manifest.json \
    background.js \
    content.js \
    popup.html \
    popup.js \
    icons/icon128.png

  local size
  size=$(du -h "$XPI_UNSIGNED" | cut -f1)

  echo ""
  echo "  ✓  $XPI_UNSIGNED  ($size)  [unsigned]"
  echo ""
  echo "  This unsigned build can be loaded in:"
  echo "    • Firefox Developer Edition  }"  after setting
  echo "    • Firefox Nightly            }  xpinstall.signatures.required = false"
  echo "      in about:config"
  echo ""
  echo "  To produce a signed build for regular Firefox, run:"
  echo "    AMO_API_KEY=<key> AMO_API_SECRET=<secret> bash package.sh sign"
  echo "  (see README.md for how to get API credentials)"
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
cmd_sign() {
  # Validate credentials are set
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

  # Build first if the XPI doesn't exist
  if [[ ! -f "$XPI_UNSIGNED" ]]; then
    cmd_build
  fi

  # Install web-ext locally if not already present
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
  echo "(This typically takes 10–60 seconds)"
  echo ""

  # web-ext sign works on the source directory, not the xpi.
  # It builds its own package, submits to AMO, and downloads the signed xpi.
  $WEBEXT sign \
    --source-dir . \
    --artifacts-dir "$OUT_DIR" \
    --channel unlisted \
    --api-key "$AMO_API_KEY" \
    --api-secret "$AMO_API_SECRET" \
    --ignore-files \
      "package.sh" "package.bat" "package.json" "package-lock.json" \
      "node_modules/**" "dist/**" "scripts/**" "README.md" ".git/**"

  echo ""
  # web-ext names the output file after the extension ID and version
  local SIGNED
  SIGNED=$(find "$OUT_DIR" -name "*.xpi" -newer "$XPI_UNSIGNED" | head -1)
  if [[ -n "$SIGNED" ]]; then
    echo "  ✓  Signed XPI: $SIGNED"
  else
    echo "  ✓  Signed XPI written to $OUT_DIR/"
  fi
  echo ""
  echo "  This signed build installs in any release version of Firefox."
  echo "  Upload it to GitHub Releases and link to it from your README."
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
cmd_help() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
}

# ─────────────────────────────────────────────────────────────────────────────
case "${1:-build}" in
  build) cmd_build ;;
  sign)  cmd_sign  ;;
  help|--help|-h) cmd_help ;;
  *) echo "Unknown command: $1  (try: build, sign, help)"; exit 1 ;;
esac

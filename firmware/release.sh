#!/usr/bin/env bash
# Publish a built firmware as a GitHub Release. The server pulls the .bin asset
# into its data/firmware/ volume at boot and just before the device's daily wake
# (see server/src/firmware.js), so the device OTAs it on that wake — no manual
# push to the NAS needed. Run after build.sh.
#   ./release.sh                 # release firmware/dist/firmware.bin as fw-v<N>
#   ./release.sh --draft         # extra args are forwarded to `gh release create`
#
# Requires the GitHub CLI (`gh auth login`). The tag is fw-v<N> where N is the
# integer FW_VERSION baked into the build; the server parses that integer back
# out and only serves a release newer than the copy it already has.
set -euo pipefail

DIST="$(cd "$(dirname "$0")" && pwd)/dist"
[ -f "$DIST/firmware.bin" ] || { echo "no firmware/dist/firmware.bin — run build.sh first"; exit 1; }
[ -f "$DIST/version" ]      || { echo "no firmware/dist/version — run build.sh first"; exit 1; }

VERSION=$(cat "$DIST/version")
TAG="fw-v$VERSION"

command -v gh >/dev/null || { echo "gh (GitHub CLI) not found — install it and run 'gh auth login'"; exit 1; }

if gh release view "$TAG" >/dev/null 2>&1; then
  echo ">> Release $TAG already exists — bump FW_VERSION in src/main.cpp and rebuild."
  exit 1
fi

gh release create "$TAG" "$DIST/firmware.bin" \
  --title "Firmware v$VERSION" \
  --notes "ESP32-S3 e-paper calendar firmware v$VERSION (OTA image)." \
  "$@"

echo
echo ">> Published $TAG — the server stages it on its next boot or pre-wake sync."

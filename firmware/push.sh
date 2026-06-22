#!/usr/bin/env bash
# Push a built firmware to the server's releases dir. The device OTAs on its next
# daily wake. Run after build.sh.
#   ./push.sh http://<NAS>:8090 [token]
set -euo pipefail

SERVER="${1:?usage: push.sh http://<NAS>:8090 [token]}"
TOKEN="${2:-}"
DIST="$(cd "$(dirname "$0")" && pwd)/dist"

[ -f "$DIST/firmware.bin" ] || { echo "no firmware/dist/firmware.bin — run build.sh first"; exit 1; }
VERSION=$(cat "$DIST/version")

curl -fSs --data-binary @"$DIST/firmware.bin" \
  -H "Content-Type: application/octet-stream" \
  ${TOKEN:+-H "X-FW-Token: $TOKEN"} \
  "$SERVER/api/firmware?version=$VERSION"
echo
echo ">> Pushed firmware v$VERSION to $SERVER — devices update on their next wake."

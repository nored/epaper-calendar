#!/usr/bin/env bash
# Runs inside the firmware-builder container. Compiles the firmware with
# PlatformIO and writes:
#   /out (firmware/dist):  firmware.bin + version   — app image, pushed for OTA
#   /web (webflash/):      firmware-merged.bin + manifest.json — for the flasher
set -euo pipefail

cd /work
VERSION=$(grep -oP '#define\s+FW_VERSION\s+\K[0-9]+' src/main.cpp)
echo ">> Building firmware v$VERSION"

pio run                     # downloads the esp32s3 toolchain on first run (needs internet)
B=.pio/build/esp32s3
BOOT_APP0=$(find / -name boot_app0.bin 2>/dev/null | head -1)
test -n "$BOOT_APP0" || { echo "boot_app0.bin not found"; exit 1; }

mkdir -p /out /web
cp "$B/firmware.bin" /out/firmware.bin
echo "$VERSION" > /out/version

esptool.py --chip esp32s3 merge_bin -o /web/firmware-merged.bin \
  --flash_mode keep --flash_size 16MB \
  0x0 "$B/bootloader.bin" \
  0x8000 "$B/partitions.bin" \
  0xe000 "$BOOT_APP0" \
  0x10000 "$B/firmware.bin"

cat > /web/manifest.json <<EOF
{
  "name": "E-Paper Calendar",
  "version": "$VERSION",
  "new_install_prompt_erase": false,
  "builds": [
    { "chipFamily": "ESP32-S3", "parts": [ { "path": "firmware-merged.bin", "offset": 0 } ] }
  ]
}
EOF

echo ">> Done. firmware/dist/ (firmware.bin v$VERSION, version) + webflash/ (merged, manifest)"
echo ">> OTA:   firmware/push.sh http://<NAS>:8090 [token]"
echo ">> Flash: serve webflash/ on localhost, open in Chrome (Web Serial)"

# E-paper calendar server — multi-stage.
#
# Build context is the REPO ROOT (see docker-compose.yml) so this one image can
# compile the firmware AND run the server:
#   stage 1 (firmware) compiles the ESP32-S3 OTA image from firmware/ with
#           PlatformIO and emits firmware.bin + its integer version;
#   stage 2 (server)   is the Node server, with that firmware baked in at /app/fw
#           and served at /firmware.bin.
# Net effect: a push to main rebuilds this image (Portainer) with freshly compiled
# firmware, and the device OTAs it on its next wake — no scripts, no config, no
# committed binary. The compiled image is credential-free: the device's WiFi/server
# settings live in NVS (provisioned once over USB), and firmware/src/config.h is an
# optional, guarded (#if __has_include) fallback that isn't in the repo, so the
# build needs no secrets. The firmware layer is cache-keyed on firmware/ alone, so
# server-only changes reuse the cached compile instead of rebuilding it.

# ---- stage 1: compile the firmware ----
FROM python:3.12-slim AS firmware
# Two build-time needs, both satisfied INSIDE the image (nothing on the NAS host):
#
#  1. git + build-essential + python3-dev + libffi-dev — on armhf the OMV box has
#     no prebuilt wheels for PlatformIO's Python deps (bitarray, cffi), so pip
#     compiles them from C. python:3.12-slim ships no compiler, so without these
#     `pio run` dies with "error: command 'gcc' failed: No such file or directory".
#
#  2. libc6:armel + libstdc++6:armel — the ONLY 32-bit-ARM Xtensa toolchain
#     Espressif publishes is a soft-float armv6l build (chosen for max
#     compatibility, e.g. Raspberry Pi), and PlatformIO hands it to an armv7l host.
#     Its binaries request the soft-float loader /lib/ld-linux.so.3, which a
#     hard-float (armhf) Debian image does NOT have — only /lib/ld-linux-armhf.so.3.
#     So xtensa-esp32s3-elf-g++ is present but unrunnable: "not found", exit 127.
#     The armel multiarch runtime supplies that loader plus the soft-float
#     libc/libm/libdl/libstdc++ the toolchain binaries link against (verified via
#     readelf: libc.so.6, libdl.so.2, libm.so.6, libstdc++.so.6).
RUN dpkg --add-architecture armel \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       git build-essential python3-dev libffi-dev \
       libc6:armel libstdc++6:armel \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir platformio
WORKDIR /fw
# Copy the PlatformIO project as its own layer: this stage's cache only busts when
# something under firmware/ changes, so server-only pushes skip recompilation.
COPY firmware/ ./
# esp32s3 is the only env; the toolchain (incl. 32-bit ARM host builds) and Arduino
# framework are fetched from the PlatformIO registry during this build.
RUN pio run -e esp32s3 \
  && mkdir -p /out \
  && cp .pio/build/esp32s3/firmware.bin /out/firmware.bin \
  && grep -oP '#define\s+FW_VERSION\s+\K[0-9]+' src/main.cpp > /out/version \
  && echo ">> compiled firmware v$(cat /out/version) ($(stat -c%s /out/firmware.bin) bytes)"

# ---- stage 2: the Node server ----
# Debian-based (glibc) so the prebuilt @napi-rs/canvas binary loads cleanly,
# and the correct CPU-architecture binary is fetched by `npm ci` below — so this
# image builds correctly whether your OMV box is x86_64 or ARM.
FROM node:22-slim
WORKDIR /app

# Run in Europe/Berlin. All the server's calendar/notification math uses local time
# (datetime.js) — the daily Telegram digest fires at the configured "HH:MM" evaluated
# against the process clock. A stock Node container is UTC, so without this a "07:00"
# digest would fire at 09:00 Berlin (summer). node:slim ships no zoneinfo, so TZ alone
# is silently ignored — tzdata must be installed for it to resolve. Early, stable layer
# (before npm) so it stays cached across source changes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tzdata \
  && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Berlin

# Install dependencies first for better build-cache reuse. The platform-specific
# native canvas binary is downloaded here, for THIS container's architecture.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Application source: server code, fonts, weather images, web control panel.
COPY server/ .

# Bake the freshly compiled OTA image in. firmware.js serves the newest of this
# and any manual push staged on the data volume.
COPY --from=firmware /out/ ./fw/

# Writable runtime state (config.json, cache/, status.json). Declared as a volume
# so it survives image rebuilds and container restarts.
RUN mkdir -p data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]

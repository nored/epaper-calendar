# One-shot firmware builder. NOT the running server — you invoke this on demand
# to compile the firmware and emit the OTA + web-flash artifacts. Run it via the
# docker-compose "firmware-builder" service (profile: build).
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir platformio esptool

WORKDIR /work
COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh

# The PlatformIO project (firmware/) is bind-mounted at /work at run time.
CMD ["build.sh"]

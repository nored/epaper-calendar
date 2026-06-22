# E-paper calendar server.
# Debian-based (glibc) so the prebuilt @napi-rs/canvas binary loads cleanly,
# and the correct CPU-architecture binary is fetched by `npm ci` below — so this
# image builds correctly whether your OMV box is x86_64 or ARM.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better build-cache reuse. The platform-specific
# native canvas binary is downloaded here, for THIS container's architecture.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source: server code, fonts, weather images, web control panel.
COPY . .

# Writable runtime state (config.json, cache/, status.json). Declared as a volume
# so it survives image rebuilds and container restarts.
RUN mkdir -p data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]

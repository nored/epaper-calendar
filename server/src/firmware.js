// Device OTA source. The device flashes whatever the server serves at
// /firmware.bin; "latest" is the highest integer version among two LOCAL sources,
// so the device's request path never touches the network:
//
//   1. IMAGE  — fw/firmware.bin + fw/version, compiled into the server image at
//      docker build time from firmware/src (see server/Dockerfile). This is the
//      git-push path: push to main -> Portainer rebuilds the image -> the freshly
//      compiled firmware is baked in -> the device OTAs it on its next wake. No
//      script, no config, no committed binary, no secrets (the image is
//      credential-free; the device's WiFi/server settings live in NVS).
//
//   2. VOLUME — data/firmware/firmware.bin + version, a manual override staged via
//      POST /api/firmware?version=N (firmware/push.sh), persisted on the volume.
//
// Newest integer version wins, so a manual push with a higher number beats the
// baked image and vice-versa. version 0 / file null until either source exists.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES = [
  join(__dirname, "..", "fw"),               // baked into the image at build time
  join(__dirname, "..", "data", "firmware"), // manual push, on the data volume
];

// Read one { version, file } from a firmware dir, or null if absent/unreadable.
function readSource(dir) {
  try {
    const bin = join(dir, "firmware.bin");
    const ver = join(dir, "version");
    if (!existsSync(bin) || !existsSync(ver)) return null;
    const version = parseInt(readFileSync(ver, "utf8").trim(), 10);
    if (!Number.isFinite(version) || version <= 0) return null;
    statSync(bin); // ensure readable
    return { version, file: bin };
  } catch {
    return null;
  }
}

// Latest known { version, file } across all sources — instant, no network.
export async function latestFirmware() {
  let best = { version: 0, file: null };
  for (const dir of SOURCES) {
    const s = readSource(dir);
    if (s && s.version > best.version) best = s;
  }
  return best;
}

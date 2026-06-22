// Device OTA source. The ESP32 only ever talks to this server; here we resolve
// the latest firmware from the project's GitHub Releases (tag "fw-N", asset
// "firmware.bin"), cache the binary on disk, and expose version + path. The
// server adds X-FW-Version to /frame.bin so the device updates on its daily
// fetch — no extra wakeups. Graceful no-op until a release exists.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FW_DIR = join(__dirname, "..", "data", "firmware");
const REPO = process.env.FW_REPO || "nored/epaper-calendar";
const TTL_MS = 6 * 3600 * 1000; // re-check GitHub at most every 6 h

let meta = { version: 0, file: null, checkedAt: 0 };

const parseVersion = (tag) => {
  const m = String(tag || "").match(/(\d+)\s*$/); // trailing integer of "fw-7" etc.
  return m ? parseInt(m[1], 10) : 0;
};

async function refresh() {
  if (meta.file && Date.now() - meta.checkedAt < TTL_MS) return meta;
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "epaper-server" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    meta.checkedAt = Date.now();
    if (!res.ok) return meta;

    const rel = await res.json();
    const version = parseVersion(rel.tag_name || rel.name);
    const asset = (rel.assets || []).find((a) => a.name === "firmware.bin");
    if (version <= 0 || !asset) return meta;

    const out = join(FW_DIR, `firmware-${version}.bin`);
    if (!existsSync(out)) {
      const bin = await fetch(asset.browser_download_url, { headers: { "User-Agent": "epaper-server" } });
      if (!bin.ok) return meta;
      if (!existsSync(FW_DIR)) mkdirSync(FW_DIR, { recursive: true });
      writeFileSync(out, Buffer.from(await bin.arrayBuffer()));
    }
    meta.version = version;
    meta.file = out;
  } catch (e) {
    meta.checkedAt = Date.now();
    console.error("firmware refresh failed:", e.message);
  }
  return meta;
}

// Latest known { version, file }. version 0 / file null until a release exists.
export async function latestFirmware() {
  return refresh();
}

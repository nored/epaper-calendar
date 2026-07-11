// Device OTA source. The device flashes whatever the server serves at
// /firmware.bin; "latest" is a LOCAL copy in data/firmware/ (the persistent
// volume), so the device's request path never depends on the network:
//   firmware.bin   — the app image the device flashes
//   version        — a text file containing the integer FW version
//
// Two ways to stage a build into that local copy, newest integer version wins:
//   1. Manual push  — POST the .bin to /api/firmware?version=N (firmware/push.sh).
//   2. GitHub Release — syncFirmwareFromGitHub() pulls the latest release's .bin
//      asset into the volume. The server calls it at boot and again ~90 s before
//      the device's daily wake (see scheduleWarm in server.js), so a fresh build
//      is staged locally in time for the same-wake OTA — no GitHub dependency on
//      the device's critical path, and it falls back to the cached copy if GitHub
//      is unreachable.
//
// Configure the repo via env EPAPER_FW_REPO ("owner/name") or config.firmware.repo;
// empty disables the GitHub path (manual push only). Public repos need no token;
// a private repo / rate-limit relief takes EPAPER_GH_TOKEN or config.firmware.token.

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FW_DIR = join(__dirname, "..", "data", "firmware");
const BIN = join(FW_DIR, "firmware.bin");
const VER = join(FW_DIR, "version");

// Latest known { version, file } from the LOCAL copy only — instant, no network.
// version 0 / file null until a build is staged (manual push or GitHub sync).
export async function latestFirmware() {
  try {
    if (!existsSync(BIN) || !existsSync(VER)) return { version: 0, file: null };
    const version = parseInt(readFileSync(VER, "utf8").trim(), 10);
    if (!Number.isFinite(version) || version <= 0) return { version: 0, file: null };
    statSync(BIN); // ensure readable
    return { version, file: BIN };
  } catch {
    return { version: 0, file: null };
  }
}

function ghConfig() {
  const fw = loadConfig().firmware || {};
  return {
    repo: (process.env.EPAPER_FW_REPO || fw.repo || "").trim(),
    token: (process.env.EPAPER_GH_TOKEN || fw.token || "").trim(),
    assetPattern: fw.assetPattern || "\\.bin$",
  };
}

// Release tags are "fw-vN" (or "vN", or plain "N"); the device compares integer
// FW versions, so pull the first integer out of the tag.
function parseVersion(tag) {
  const m = String(tag || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

// Don't hit GitHub more than once an hour regardless of how often we're called
// (guards restart loops); the daily pre-wake call is always far outside this.
let lastCheckMs = 0;
const MIN_CHECK_MS = 60 * 60 * 1000;

// Pull the latest GitHub release's firmware asset into the volume when it is a
// newer integer version than the local copy. Never throws to the caller — on any
// failure it logs and reports { updated: false } so the cached firmware stands.
export async function syncFirmwareFromGitHub() {
  const { repo, token, assetPattern } = ghConfig();
  const cachedVersion = async () => (await latestFirmware()).version;

  if (!repo) return { updated: false, version: await cachedVersion(), reason: "no repo configured" };

  const now = Date.now();
  if (now - lastCheckMs < MIN_CHECK_MS) return { updated: false, version: await cachedVersion(), reason: "throttled" };
  lastCheckMs = now;

  try {
    const auth = token ? { Authorization: `Bearer ${token}` } : {};
    const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "epaper-calendar", ...auth },
    });
    if (!rel.ok) throw new Error(`releases/latest HTTP ${rel.status}`);
    const data = await rel.json();

    const remoteVer = parseVersion(data.tag_name || data.name);
    if (!Number.isFinite(remoteVer) || remoteVer <= 0) throw new Error(`no integer version in tag "${data.tag_name}"`);

    const current = await latestFirmware();
    if (remoteVer <= current.version) {
      return { updated: false, version: current.version, reason: `cached v${current.version} >= release v${remoteVer}` };
    }

    const re = new RegExp(assetPattern, "i");
    const asset = (data.assets || []).find((a) => re.test(a.name));
    if (!asset) throw new Error(`release v${remoteVer} has no asset matching /${assetPattern}/`);

    const dl = await fetch(asset.browser_download_url, {
      headers: { Accept: "application/octet-stream", "User-Agent": "epaper-calendar", ...auth },
      redirect: "follow",
    });
    if (!dl.ok) throw new Error(`asset download HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (!buf.length) throw new Error("downloaded asset is empty");

    if (!existsSync(FW_DIR)) mkdirSync(FW_DIR, { recursive: true });
    // Write the image via a temp + atomic rename so a device fetching /firmware.bin
    // mid-download never gets a torn flash image; bump `version` only after the
    // image is fully in place (a stale-low version is harmless, a torn image isn't).
    const tmp = BIN + ".tmp";
    writeFileSync(tmp, buf);
    renameSync(tmp, BIN);
    writeFileSync(VER, String(remoteVer));
    console.log(`[firmware] synced v${remoteVer} from ${repo} (${buf.length} bytes, asset ${asset.name})`);
    return { updated: true, version: remoteVer, bytes: buf.length };
  } catch (e) {
    console.error(`[firmware] GitHub sync failed: ${e.message}`);
    return { updated: false, version: await cachedVersion(), error: e.message };
  }
}

// Device OTA source — a LOCAL file on the server, no GitHub, no network.
// You build the firmware on your PC (firmware/build.sh) and drop two files into
// the server's data/firmware/ dir (which lives in the persistent volume):
//   firmware.bin   — the app image the device flashes
//   version        — a text file containing the integer FW version
// The server advertises that version via X-FW-Version on /frame.bin and serves
// the binary at /firmware.bin, so the device OTAs on its daily wake.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FW_DIR = join(__dirname, "..", "data", "firmware");
const BIN = join(FW_DIR, "firmware.bin");
const VER = join(FW_DIR, "version");

// Latest known { version, file }. version 0 / file null until you stage a build.
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

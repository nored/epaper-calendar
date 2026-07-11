// HTTP server: serves the packed framebuffer to the ESP32, a live PNG preview,
// and a web control panel for configuring feeds / notes / settings.

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "./config.js";
import { buildModel } from "./data.js";
import { renderCalendar } from "./render.js";
import { packFramebuffer, snapRGBAToPanel } from "./palette.js";
import { feedTitles } from "./events.js";
import { latestFirmware, syncFirmwareFromGitHub } from "./firmware.js";
import { createReadStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_PATH = join(__dirname, "..", "data", "status.json");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/static", express.static(join(__dirname, "..", "public")));

// ---- device status persistence ----
function loadStatus() {
  if (existsSync(STATUS_PATH)) { try { return JSON.parse(readFileSync(STATUS_PATH, "utf8")); } catch {} }
  return { lastSeen: null, battery: null, wakeReason: null, lastSleepSeconds: null, count: 0 };
}
function saveStatus(s) { writeFileSync(STATUS_PATH, JSON.stringify(s, null, 2)); }
let status = loadStatus();

// Seconds until the next configured wake hour (local time).
function secondsUntilWake(cfg, battery) {
  const s = cfg.sleep || DEFAULT_CONFIG.sleep;
  if (battery != null && battery < s.lowBatteryVolts) return s.lowBatterySeconds;
  const now = new Date();
  const next = nextWake(cfg, now);
  return Math.max(s.minSeconds, Math.round((next - now) / 1000));
}

// The next wakeHour boundary (local time) strictly after `now`.
function nextWake(cfg, now) {
  const wakeHour = (cfg.sleep || DEFAULT_CONFIG.sleep).wakeHour;
  const next = new Date(now);
  next.setHours(wakeHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

// The date the DEVICE's frame should depict. The device wakes at the wakeHour
// boundary to show the new day; deep-sleep timer drift can make it wake a little
// early. If it's fetching within DRIFT minutes BEFORE the next boundary, it woke
// early for that refresh — render the upcoming day so it never shows "yesterday"
// at/after midnight. After the boundary it's naturally correct.
const DRIFT_MIN = 30;
function deviceRenderDate(cfg, now = new Date()) {
  const next = nextWake(cfg, now);
  return (next - now) <= DRIFT_MIN * 60 * 1000 ? next : now;
}

function controlUrl(req) {
  const cfg = loadConfig();
  if (cfg.controlUrl) return cfg.controlUrl;
  return `http://${req.headers.host}/`;
}

const dateDE = (d) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

async function render(req, opts = {}) {
  const cfg = loadConfig();
  const model = await buildModel(cfg, opts.date || new Date());
  return renderCalendar(model, cfg, {
    controlUrl: controlUrl(req),
    battery: opts.battery,   // only ever a real, device-reported value
  });
}

// ---- device endpoint: packed 6-color framebuffer ----
app.get("/frame.bin", async (req, res) => {
  const battery = req.query.batt ? parseFloat(req.query.batt) : null;
  const cfg = loadConfig();
  const sleepSeconds = secondsUntilWake(cfg, battery);

  status = { lastSeen: new Date().toISOString(), battery, wakeReason: req.query.reason || null, lastSleepSeconds: sleepSeconds, count: (status.count || 0) + 1 };
  saveStatus(status);

  try {
    // The device just reported its real battery. Render the day it's waking FOR
    // (snapped past midnight so early clock-drift never shows yesterday).
    const renderDate = deviceRenderDate(cfg);
    const canvas = await render(req, { battery, date: renderDate });
    const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const fb = packFramebuffer(rgba, cfg.rotate || 0);
    res.set("Content-Type", "application/octet-stream");
    res.set("X-Sleep-Seconds", String(sleepSeconds));
    // Advertise the latest firmware so the device can OTA on this same wake.
    try { res.set("X-FW-Version", String((await latestFirmware()).version)); } catch {}
    res.set("Content-Length", String(fb.length));
    res.send(fb);
    console.log(`[device] served frame.bin batt=${battery ?? "?"}V -> sleep ${sleepSeconds}s`);
  } catch (e) {
    console.error("render failed:", e);
    res.status(500).send("render error");
  }
});

// ---- release endpoint: upload a new firmware build into the releases dir ----
// You build the .bin on your PC and push it here; the device OTAs on its next
// wake. Guarded by EPAPER_FW_TOKEN if set. POST raw binary:
//   curl --data-binary @firmware.bin "http://nas:8090/api/firmware?version=2" \
//        -H "Content-Type: application/octet-stream" -H "X-FW-Token: <token>"
app.post("/api/firmware", express.raw({ type: "application/octet-stream", limit: "8mb" }), (req, res) => {
  const token = process.env.EPAPER_FW_TOKEN;
  if (token && req.get("X-FW-Token") !== token) return res.status(403).json({ error: "bad token" });
  const version = parseInt(String(req.query.version || ""), 10);
  if (!Number.isFinite(version) || version <= 0) return res.status(400).json({ error: "version (?version=N) required" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
  try {
    const dir = join(__dirname, "..", "data", "firmware");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "firmware.bin"), req.body);
    writeFileSync(join(dir, "version"), String(version));
    console.log(`[firmware] received v${version} (${req.body.length} bytes)`);
    res.json({ ok: true, version, bytes: req.body.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- device endpoint: OTA firmware image ----
app.get("/firmware.bin", async (req, res) => {
  const fw = await latestFirmware();
  if (!fw.file) return res.status(404).send("no firmware");
  res.set("Content-Type", "application/octet-stream");
  res.set("X-FW-Version", String(fw.version));
  // MUST send Content-Length: the device's HTTPClient.getSize() returns -1 for a
  // chunked response and stageOTA() bails ("unknown length"). A known length also
  // keeps HTTPClient from splicing chunk framing into the flash image.
  res.set("Content-Length", String(statSync(fw.file).size));
  createReadStream(fw.file).pipe(res);
  console.log(`[device] served firmware.bin v${fw.version}`);
});

// ---- preview for the browser ----
app.get("/preview.png", async (req, res) => {
  try {
    // Reflect the LAST real device contact (if any). No device yet -> no battery.
    const seen = status.lastSeen ? new Date(status.lastSeen) : null;
    const recent = seen && Date.now() - seen.getTime() < 3 * 86400000;
    const canvas = await render(req, {
      battery: recent ? status.battery : undefined,
    });
    // Show the TRUE on-screen result: snap to the 6 panel colours (no anti-alias).
    const ctx = canvas.getContext("2d");
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    snapRGBAToPanel(id.data);
    ctx.putImageData(id, 0, 0);
    const png = await canvas.encode("png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (e) { console.error(e); res.status(500).send("render error"); }
});

// ---- config API ----
app.get("/api/config", (_req, res) => res.json(loadConfig()));
app.post("/api/config", (req, res) => {
  try {
    const saved = saveConfig(req.body);
    // Invalidate ONLY the feed caches (keyed by feed NAME, so a changed URL must
    // refetch). Everything else is keyed by its actual inputs — weather by
    // lat/lon, holidays by state, name days by date, quote by day, horoscope by
    // sign — so those refetch naturally when the input changes. Crucially this no
    // longer wipes the daily quote on every autosave (which was hammering the
    // quotes API and causing HTTP 429).
    try {
      const cdir = join(__dirname, "..", "data", "cache");
      if (existsSync(cdir)) for (const f of readdirSync(cdir)) {
        if (f.startsWith("feed-")) rmSync(join(cdir, f), { force: true });
      }
    } catch {}
    res.json(saved);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/status", (_req, res) => res.json(status));

// Discover the distinct event titles in a feed so the UI can map each one
// (no keyword guessing). Pass ?url=...&name=...
app.get("/api/feed-titles", async (req, res) => {
  try {
    const titles = await feedTitles(String(req.query.url || ""), String(req.query.name || ""));
    res.json(titles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- control panel ----
app.get("/", (_req, res) => res.sendFile(join(__dirname, "..", "public", "index.html")));

// ---- pre-warm: prime the data caches ~90 s before each wake boundary so the
// device's midnight fetch renders instantly from warm data (and against the new
// day's weather/quote), not cold network calls on its critical path. ----
const PREWARM_LEAD_MS = 90 * 1000;
function scheduleWarm() {
  const cfg = loadConfig();
  const now = new Date();
  const boundary = nextWake(cfg, now);
  let wait = boundary.getTime() - now.getTime() - PREWARM_LEAD_MS;
  if (wait < 0) wait += 24 * 3600 * 1000; // already inside the lead window; aim for tomorrow
  setTimeout(async () => {
    try {
      const day = deviceRenderDate(cfg, new Date()); // the upcoming day
      await buildModel(cfg, day);
      console.log(`[prewarm] caches primed for ${dateDE(day)}`);
    } catch (e) { console.error("[prewarm] failed:", e.message); }
    // Stage the latest GitHub-release firmware now, before the device wakes, so
    // it OTAs the new build on this same wake (no GitHub call on its path).
    try {
      const r = await syncFirmwareFromGitHub();
      if (r.updated) console.log(`[prewarm] firmware advanced to v${r.version}`);
    } catch (e) { console.error("[prewarm] firmware sync failed:", e.message); }
    scheduleWarm(); // reschedule for the next boundary
  }, wait);
}

app.listen(PORT, () => {
  console.log(`e-paper calendar server on http://localhost:${PORT}`);
  console.log(`  device fetches:  GET /frame.bin?batt=<volts>&reason=<wake>`);
  console.log(`  control panel:   http://localhost:${PORT}/`);
  scheduleWarm();
  // Pull the latest GitHub release once at boot so a fresh deploy/restart has
  // firmware staged without waiting for the next pre-wake window.
  syncFirmwareFromGitHub()
    .then((r) => { if (r.updated) console.log(`[firmware] boot sync -> v${r.version}`); })
    .catch(() => {});
});

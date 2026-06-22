// HTTP server: serves the packed framebuffer to the ESP32, a live PNG preview,
// and a web control panel for configuring feeds / notes / settings.

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "./config.js";
import { buildModel } from "./data.js";
import { renderCalendar } from "./render.js";
import { packFramebuffer, snapRGBAToPanel } from "./palette.js";
import { feedTitles } from "./events.js";

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
  const next = new Date(now);
  next.setHours(s.wakeHour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.max(s.minSeconds, Math.round((next - now) / 1000));
}

function controlUrl(req) {
  const cfg = loadConfig();
  if (cfg.controlUrl) return cfg.controlUrl;
  return `http://${req.headers.host}/`;
}

const dateDE = (d) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

async function render(req, opts = {}) {
  const cfg = loadConfig();
  const model = await buildModel(cfg, new Date());
  return renderCalendar(model, cfg, {
    controlUrl: controlUrl(req),
    lastSync: opts.lastSync, // date string or undefined — never a clock
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
    // The device just reported its real battery + this is its real update time.
    const canvas = await render(req, { battery, lastSync: dateDE(new Date()) });
    const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const fb = packFramebuffer(rgba, cfg.rotate || 0);
    res.set("Content-Type", "application/octet-stream");
    res.set("X-Sleep-Seconds", String(sleepSeconds));
    res.set("Content-Length", String(fb.length));
    res.send(fb);
    console.log(`[device] served frame.bin batt=${battery ?? "?"}V -> sleep ${sleepSeconds}s`);
  } catch (e) {
    console.error("render failed:", e);
    res.status(500).send("render error");
  }
});

// ---- preview for the browser ----
app.get("/preview.png", async (req, res) => {
  try {
    // Reflect the LAST real device contact (if any). No device yet -> no stamp.
    const seen = status.lastSeen ? new Date(status.lastSeen) : null;
    const recent = seen && Date.now() - seen.getTime() < 3 * 86400000;
    const canvas = await render(req, {
      lastSync: seen ? dateDE(seen) : undefined,
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

app.listen(PORT, () => {
  console.log(`e-paper calendar server on http://localhost:${PORT}`);
  console.log(`  device fetches:  GET /frame.bin?batt=<volts>&reason=<wake>`);
  console.log(`  control panel:   http://localhost:${PORT}/`);
});

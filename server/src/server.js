// HTTP server: serves the packed framebuffer to the ESP32, a live PNG preview,
// and a web control panel for configuring feeds / notes / settings.

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "./config.js";
import { buildModel } from "./data.js";
import { renderCalendar, lipoPercent } from "./render.js";
import { packFramebuffer, packBMP6Color, snapRGBAToPanel } from "./palette.js";
import { feedTitles } from "./events.js";
import { latestFirmware } from "./firmware.js";
import { sendTelegram, formatDailyDigest, telegramReady, normalizeTimes, decideNotification } from "./telegram.js";
import { createReadStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_PATH = join(__dirname, "..", "data", "status.json");
const NOTIFY_PATH = join(__dirname, "..", "data", "notify.json");
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

// Telegram dedupe state — kept separate from status.json (which is rewritten in
// full on every device fetch) so the last-notified day/hash survive.
function loadNotify() {
  if (existsSync(NOTIFY_PATH)) { try { return JSON.parse(readFileSync(NOTIFY_PATH, "utf8")); } catch {} }
  return { day: null, sentTimes: [], hash: null };
}
function saveNotify(n) { try { writeFileSync(NOTIFY_PATH, JSON.stringify(n, null, 2)); } catch {} }

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
  const canvas = await renderCalendar(model, cfg, {
    controlUrl: controlUrl(req),
    battery: opts.battery,   // only ever a real, device-reported value
    crisp: opts.crisp,       // device frame: bilevel text, no anti-alias mush
  });
  return { canvas, model };
}

// ---- device frame endpoint ----
// The device fetches a real image and renders it on-board. v5+ use /frame.bmp — a
// 24-bit BMP in the panel's actual colours, so you can open that same URL in a
// browser and see exactly what the frame downloads. v4 uses /frame.bin (pure-colour
// BMP); older firmware gets the packed framebuffer. A request WITHOUT ?batt= (a
// browser opening the URL to check the image) does not record a device check-in.
async function serveDeviceFrame(req, res, { real }) {
  const battery = req.query.batt ? parseFloat(req.query.batt) : null;
  const deviceFw = req.query.fw ? parseInt(req.query.fw, 10) : 0; // build the device is RUNNING
  const cfg = loadConfig();
  const sleepSeconds = secondsUntilWake(cfg, battery);

  if (battery != null) { // only a real device (reports battery) updates status
    status = { lastSeen: new Date().toISOString(), battery, deviceFw, wakeReason: req.query.reason || null, lastSleepSeconds: sleepSeconds, count: (status.count || 0) + 1 };
    saveStatus(status);
  }

  try {
    const renderDate = deviceRenderDate(cfg);
    const { canvas } = await render(req, { battery, date: renderDate, crisp: true });
    const rgba = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;

    // /frame.bmp and v4+ get a 24-bit BMP in the six exact RGBs the device's verbatim
    // Waveshare GUI_ReadBmp_RGB_6Color matches; older firmware gets the raw framebuffer.
    let fb, ctype;
    if (real || deviceFw >= 4) { fb = packBMP6Color(rgba, cfg.rotate || 0, false); ctype = "image/bmp"; }
    else { fb = packFramebuffer(rgba, cfg.rotate || 0); ctype = "application/octet-stream"; }
    res.set("Content-Type", ctype);
    res.set("X-Sleep-Seconds", String(sleepSeconds));

    // Battery-gated OTA: advertise a flashable version only when battery is safe.
    const bat = cfg.battery || DEFAULT_CONFIG.battery;
    const pct = battery != null ? lipoPercent(battery) : null;
    const otaOk = pct == null || pct >= bat.otaMinPercent;
    try {
      const fwv = otaOk ? (await latestFirmware()).version : 0;
      res.set("X-FW-Version", String(fwv));
      if (!otaOk && battery != null) console.log(`[device] OTA held: battery ${pct}% < ${bat.otaMinPercent}%`);
    } catch {}

    res.set("Content-Length", String(fb.length));
    res.send(fb);
    if (battery != null) console.log(`[device] served ${real ? "real-BMP" : (deviceFw >= 4 ? "BMP" : "raw")} fw=${deviceFw} batt=${battery}V -> sleep ${sleepSeconds}s`);
  } catch (e) {
    console.error("render failed:", e);
    res.status(500).send("render error");
  }
}

app.get("/frame.bmp", (req, res) => serveDeviceFrame(req, res, { real: true }));   // v6+: real smooth image, device converts
app.get("/frame.bin", (req, res) => serveDeviceFrame(req, res, { real: false })); // legacy: v4 quantized BMP / older raw framebuffer

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
    const { canvas } = await render(req, {
      battery: recent ? status.battery : undefined,
    });
    // Snap to the exact 6 panel inks so the preview == the panel: provably no grey
    // and no anti-aliased pixel survives (the canvas AA can't be disabled, so we
    // resolve it here, hue-aware, same as the device frame).
    const pctx = canvas.getContext("2d");
    const id = pctx.getImageData(0, 0, canvas.width, canvas.height);
    snapRGBAToPanel(id.data);
    pctx.putImageData(id, 0, 0);
    const png = await canvas.encode("png");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(png);
  } catch (e) { console.error(e); res.status(500).send("render error"); }
});

// Invalidate ONLY the feed caches (keyed by feed NAME, so a changed URL must
// refetch). Everything else is keyed by its actual inputs — weather by lat/lon,
// holidays by state, name days by date, quote by day, horoscope by sign — so those
// refetch naturally when the input changes. Crucially this does not wipe the daily
// quote on every autosave (which was hammering the quotes API and causing HTTP 429).
function invalidateFeedCaches() {
  try {
    const cdir = join(__dirname, "..", "data", "cache");
    if (existsSync(cdir)) for (const f of readdirSync(cdir)) {
      if (f.startsWith("feed-")) rmSync(join(cdir, f), { force: true });
    }
  } catch {}
}

// ---- config API ----
app.get("/api/config", (_req, res) => res.json(loadConfig()));
app.post("/api/config", (req, res) => {
  try {
    const saved = saveConfig(req.body);
    invalidateFeedCaches();
    scheduleTelegramSync(); // pick up changed dailyTime / syncMinutes / credentials
    res.json(saved);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- config backup: export the whole config for migration/rescue, and import
// it back. Export is the full data/config.json; import validates it's an object,
// saves it (merged over defaults), and refreshes feeds + the Telegram schedule. ----
app.get("/api/config/export", (_req, res) => {
  const cfg = loadConfig();
  const stamp = new Date().toISOString().slice(0, 10);
  res.set("Content-Type", "application/json");
  res.set("Content-Disposition", `attachment; filename="epaper-config-${stamp}.json"`);
  res.send(JSON.stringify(cfg, null, 2));
});
app.post("/api/config/import", (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "expected a config object" });
    }
    const saved = saveConfig(incoming);
    invalidateFeedCaches();
    scheduleTelegramSync();
    res.json(saved);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Send a Telegram test message so the user can confirm token + chat id work.
app.post("/api/telegram/test", async (_req, res) => {
  // Send TODAY's real digest (not a generic "connected" ping), so the test shows
  // exactly what the daily message will look like.
  const cfg = loadConfig();
  const { message } = await buildDigestMessage(cfg);
  const r = await sendTelegram(message);
  if (r.ok) return res.json({ ok: true });
  res.status(400).json({ ok: false, error: r.error || r.reason || "failed" });
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
    scheduleWarm(); // reschedule for the next boundary
  }, wait);
}

// ---- Telegram: periodic calendar sync + a daily digest at one or more configured
// local times. Each tick rebuilds today's model (feeds refetch on their own ~1 h
// cache) and sends when either (a) a configured time has passed today and its
// digest hasn't gone out yet, or (b) today's tasks changed after a digest already
// went out. Battery is the device's last reported reading. The timing/dedupe
// decision lives in telegram.js (decideNotification) so it can be unit-tested. ----
// Build TODAY's actual digest text (same content the scheduled send uses), so the
// "Test" button and the scheduler produce the identical real message.
async function buildDigestMessage(cfg) {
  const model = await buildModel(cfg, new Date());
  const ti = model.dayInfo(model.today);
  const info = model.info; // today's holiday/nameday/moon/weather/quote/horoscope
  const events = ti.events || [];
  const volts = status.battery ?? null;
  const pct = volts != null ? lipoPercent(volts) : null;
  const bat = cfg.battery || DEFAULT_CONFIG.battery;
  const warn = pct != null && pct < bat.warnPercent;
  const otaBlocked = pct != null && pct < bat.otaMinPercent;
  const dateStr = model.today.toLocaleDateString("de-DE", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
  });
  const message = formatDailyDigest({
    dateStr, events,
    publicHoliday: info.publicHoliday,
    otherHoliday: ti.otherHoliday,
    schoolHoliday: info.schoolHoliday,
    nameDays: info.nameDays,
    moon: cfg.show?.moon !== false ? info.moon : null,
    weather: info.weather,
    quote: info.quote,
    horoscopes: info.horoscopes,
    pct, volts, warn, otaBlocked,
  });
  return { message, events, pct, key: ti.key };
}

async function telegramTick() {
  if (!telegramReady()) return; // disabled or missing token/chat id
  const cfg = loadConfig();
  const tg = cfg.telegram || DEFAULT_CONFIG.telegram;

  const model = await buildModel(cfg, new Date());
  const ti = model.dayInfo(model.today);
  const events = ti.events || [];
  const now = new Date();
  const decision = decideNotification({
    times: normalizeTimes(tg.dailyTimes ?? tg.dailyTime),
    nowMins: now.getHours() * 60 + now.getMinutes(),
    todayKey: ti.key,
    hash: events.map((e) => e.title).join("|"),
    prev: loadNotify(),
  });
  if (!decision.send) return;

  const { message, pct } = await buildDigestMessage(cfg);
  const r = await sendTelegram(message);
  if (r.ok) {
    saveNotify(decision.nextState);
    console.log(`[telegram] ${decision.reason} sent (${events.length} tasks, batt ${pct ?? "?"}%)`);
  }
}

let _tgTimer = null;
function scheduleTelegramSync() {
  if (_tgTimer) clearTimeout(_tgTimer);
  const tg = loadConfig().telegram || DEFAULT_CONFIG.telegram;
  const everyMs = Math.max(5, tg.syncMinutes ?? 60) * 60 * 1000;
  _tgTimer = setTimeout(function tick() {
    telegramTick()
      .catch((e) => console.error("[telegram] tick failed:", e.message))
      .finally(() => {
        const mins = Math.max(5, (loadConfig().telegram || DEFAULT_CONFIG.telegram).syncMinutes ?? 60);
        _tgTimer = setTimeout(tick, mins * 60 * 1000);
      });
  }, everyMs);
}

app.listen(PORT, () => {
  console.log(`e-paper calendar server on http://localhost:${PORT}`);
  console.log(`  device fetches:  GET /frame.bin?batt=<volts>&reason=<wake>`);
  console.log(`  control panel:   http://localhost:${PORT}/`);
  scheduleWarm();
  // Kick a Telegram check shortly after boot (so a just-configured bot sends
  // today's digest if the time has already passed), then run on its interval.
  setTimeout(() => telegramTick().catch(() => {}), 8000);
  scheduleTelegramSync();
});

// Telegram notifications. The server sends a daily digest — today's tasks, the
// battery level, and a charge warning when low — when the device does its daily
// refresh (see server.js /frame.bin). Credentials come from env
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (preferred — keeps secrets out of
// config.json) or config.telegram.{botToken,chatId}; env wins. Everything no-ops
// gracefully until both a token and a chat id are present, and sends never throw.

import { loadConfig } from "./config.js";

function tgConfig() {
  const t = loadConfig().telegram || {};
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN || t.botToken || "").trim(),
    chatId: (process.env.TELEGRAM_CHAT_ID || t.chatId || "").trim(),
    enabled: t.enabled !== false,
  };
}

// True when Telegram is switched on AND has the credentials it needs to send.
export function telegramReady() {
  const { token, chatId, enabled } = tgConfig();
  return Boolean(enabled && token && chatId);
}

// Send a message. Returns { ok } / { ok:false, ... } — never throws.
export async function sendTelegram(text) {
  const { token, chatId, enabled } = tgConfig();
  if (!enabled) return { ok: false, reason: "disabled" };
  if (!token || !chatId) return { ok: false, reason: "not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.description || `HTTP ${res.status}`);
    return { ok: true };
  } catch (e) {
    console.error(`[telegram] send failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Parse "HH:MM" -> { h, min, str (zero-padded), mins (minutes since midnight) }.
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return { h, min, str: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`, mins: h * 60 + min };
}

// Accept an array of "HH:MM" (or a single legacy string) -> sorted, de-duped list.
export function normalizeTimes(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const p = parseHHMM(s);
    if (p && !seen.has(p.str)) { seen.add(p.str); out.push(p); }
  }
  if (!out.length) out.push(parseHHMM("07:00"));
  return out.sort((a, b) => a.mins - b.mins);
}

// Decide whether to send now, given the configured times, the wall clock (minutes
// since midnight), today's key + task hash, and the persisted notify state.
// Returns { send, reason: "daily"|"update"|null, nextState }. Rules: send the
// digest once per configured time that has passed today ("daily"); once a daily has
// gone out, send again if the day's tasks change ("update"); a new day resets.
export function decideNotification({ times, nowMins, todayKey, hash, prev }) {
  const st = prev && prev.day === todayKey
    ? { day: todayKey, sentTimes: [...(prev.sentTimes || [])], hash: prev.hash ?? null }
    : { day: todayKey, sentTimes: [], hash: null };

  const due = times.filter((t) => nowMins >= t.mins && !st.sentTimes.includes(t.str));
  let reason = null;
  if (due.length) reason = "daily";
  else if (st.sentTimes.length && hash !== st.hash) reason = "update";
  if (!reason) return { send: false, reason: null, nextState: st };

  if (reason === "daily") st.sentTimes = [...new Set([...st.sentTimes, ...due.map((t) => t.str)])];
  st.hash = hash;
  return { send: true, reason, nextState: st };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Format the daily digest. events is today's event list (each { title }); pct is
// battery 0..100 (or null if unknown); volts is the reported voltage (or null);
// warn/otaBlocked come from the battery thresholds evaluated in server.js.
export function formatDailyDigest({
  dateStr, events,
  publicHoliday, otherHoliday, schoolHoliday, nameDays, moon,
  weather, quote, horoscopes,
  pct, volts, warn, otaBlocked,
}) {
  const lines = [`📅 <b>${esc(dateStr)}</b>`, ""];

  // Termine
  if (events && events.length) {
    lines.push("<b>Termine heute:</b>");
    for (const e of events) lines.push(`• ${esc(e.title || e.label || "Termin")}`);
  } else {
    lines.push("Keine Termine heute.");
  }

  // Tag-Infos: Feiertag / Ferien / Namenstag / Mond
  const day = [];
  if (publicHoliday) day.push(`🎉 Feiertag: <b>${esc(publicHoliday.name)}</b>`);
  if (otherHoliday) {
    const where = otherHoliday.stateNames?.length ? ` (${esc(otherHoliday.stateNames.join(", "))})` : "";
    day.push(`📌 Feiertag${where}: ${esc(otherHoliday.name)}`);
  }
  if (schoolHoliday) day.push(`🏖️ Ferien: ${esc(schoolHoliday)}`);
  if (nameDays && nameDays.length) day.push(`👤 Namenstag: ${esc(nameDays.join(", "))}`);
  if (moon && moon.name) day.push(`🌙 Mond: ${esc(moon.name)}`);
  if (day.length) { lines.push(""); lines.push(...day); }

  // Wetter heute (first day of each location's forecast is today)
  if (weather && weather.length) {
    lines.push("", "🌤️ <b>Wetter heute:</b>");
    for (const loc of weather) {
      const d = loc.days && loc.days[0];
      if (!d) continue;
      const cond = d.label ? ` – ${esc(d.label)}` : "";
      lines.push(`• ${esc(loc.name)}: <b>${d.tmax}°</b> / ${d.tmin}°${cond}`);
    }
  }

  // Spruch des Tages
  if (quote && quote.text) {
    lines.push("", `✨ <i>„${esc(quote.text)}“</i>${quote.author ? ` — ${esc(quote.author)}` : ""}`);
  }

  // Horoskop (per configured sign)
  if (horoscopes && horoscopes.length) {
    lines.push("", "🔮 <b>Horoskop:</b>");
    for (const h of horoscopes) {
      const lbl = h.label ? ` (${esc(h.label)})` : "";
      lines.push(`<b>${esc(h.signName || h.sign)}</b>${lbl}: ${esc(h.text)}`);
    }
  }

  // Batterie
  lines.push("");
  if (pct != null) {
    const v = volts != null ? ` (${volts.toFixed(2)} V)` : "";
    lines.push(`🔋 Batterie: <b>${pct}%</b>${v}`);
    if (warn) lines.push("⚠️ <b>Akku niedrig – bitte laden!</b>");
    if (otaBlocked) lines.push("⏸️ Firmware-Update pausiert, bis geladen wird.");
  } else {
    lines.push("🔋 Batterie: unbekannt");
  }

  return lines.join("\n");
}

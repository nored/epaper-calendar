// Draws the calendar onto a 1200x1600 canvas using only the 6 panel colors.
// The result is handed to palette.packFramebuffer() for the device, or encoded
// as PNG for the web preview.

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIDTH, HEIGHT, C } from "./palette.js";
import { DOW_SHORT_DE, MONTHS } from "./datetime.js";
import { relLabel } from "./data.js";
import { weatherImage } from "./weatherImage.js";

// Register the bundled DejaVu fonts (shipped in assets/fonts so the server is
// portable, not pinned to any one machine's system font paths).
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
for (const [file, family] of [
  ["DejaVuSans.ttf", "Sans"],
  ["DejaVuSans-Bold.ttf", "SansBold"],
  ["DejaVuSans-Oblique.ttf", "SansItalic"],
  ["WeatherIcons.ttf", "WeatherIcons"],
]) {
  const p = join(FONT_DIR, file);
  if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
}

// Weather condition -> Weather Icons (Erik Flowers) glyph. Font glyphs stay
// crisp at small sizes and render in a single solid colour, unlike rasterised
// icons which scribble/vanish when shrunk to the forecast cell size.
const WI_GLYPH = {
  sunny: "",      // day-sunny
  partly: "",     // day-cloudy (sun + cloud)
  cloudy: "",     // cloudy
  overcast: "",   // cloudy
  fog: "",        // fog
  rain: "",       // rain
  snow: "",       // snow
  thunder: "",    // thunderstorm
  tornado: "",    // tornado
  windy: "",      // strong-wind
  hot: "",        // hot
  scorching: "",  // hot
};

const MARGIN = 24;
const HEADER_H = 92;
const INFO_H = 322;

const binColorCss = (name) => C[name] || C.black;

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// Crisp pixel-aligned rules in pure black. The framebuffer dither only touches
// pixels with quantization error; a solid black line has none, so it survives
// intact. A sub-pixel / grey (anti-aliased) line would get shattered into dashes,
// so all structural rules go through these helpers (odd widths sit on a .5 centre
// to land on a single pixel row/column).
function hline(ctx, x0, x1, y, width = 1, color = C.black) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  const yy = width % 2 ? Math.round(y) + 0.5 : Math.round(y);
  ctx.beginPath(); ctx.moveTo(Math.round(x0), yy); ctx.lineTo(Math.round(x1), yy); ctx.stroke();
}
function vline(ctx, x, y0, y1, width = 1, color = C.black) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  const xx = width % 2 ? Math.round(x) + 0.5 : Math.round(x);
  ctx.beginPath(); ctx.moveTo(xx, Math.round(y0)); ctx.lineTo(xx, Math.round(y1)); ctx.stroke();
}

// Generic marker glyph used in day cells and the legend. (cx, cy) is the center.
// "dot" = filled circle, "square" = filled square, "bar" = small filled rect.
// Yellow gets a thin black outline so it stays visible on white.
function drawMarker(ctx, shape, color, cx, cy, size) {
  const fill = binColorCss(color);
  const outline = color === "yellow" || color === "white";
  ctx.fillStyle = fill;
  if (shape === "square") {
    const s = size;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
    if (outline) { ctx.strokeStyle = C.black; ctx.lineWidth = 1; ctx.strokeRect(cx - s / 2, cy - s / 2, s, s); }
  } else if (shape === "bar") {
    const w = size * 1.4, hgt = size * 0.55;
    ctx.fillRect(cx - w / 2, cy - hgt / 2, w, hgt);
    if (outline) { ctx.strokeStyle = C.black; ctx.lineWidth = 1; ctx.strokeRect(cx - w / 2, cy - hgt / 2, w, hgt); }
  } else { // dot
    const r = size / 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    if (outline) { ctx.strokeStyle = C.black; ctx.lineWidth = 1; ctx.stroke(); }
  }
}

// 4-phase moon glyph (new/first/full/last) — clean on e-ink.
function drawMoonGlyph(ctx, cx, cy, r, kind) {
  ctx.save();
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  if (kind === "new") {
    ctx.fillStyle = C.black;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  } else if (kind === "full") {
    ctx.strokeStyle = C.black; ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    // half lit; first = right half black, last = left half black
    ctx.strokeStyle = C.black; ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.black;
    ctx.beginPath();
    if (kind === "first") ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
    else ctx.arc(cx, cy, r, Math.PI / 2, -Math.PI / 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBattery(ctx, x, y, w, h, volts) {
  // 1S LiPo range ~3.3 (empty) .. 4.2 (full)
  let pct = volts ? Math.max(0, Math.min(1, (volts - 3.3) / (4.2 - 3.3))) : null;
  ctx.strokeStyle = C.black; ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = C.black;
  ctx.fillRect(x + w, y + h * 0.3, 3, h * 0.4); // nub
  if (pct != null) {
    ctx.fillStyle = pct < 0.2 ? C.red : pct < 0.5 ? C.yellow : C.green;
    ctx.fillRect(x + 2, y + 2, (w - 4) * pct, h - 4);
  }
  return pct;
}

// ---- cel-shaded weather icons in the 6 panel colors ----
function wSun(ctx, cx, cy, r) {
  ctx.strokeStyle = C.yellow; ctx.lineWidth = 3;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r + 3), cy + Math.sin(a) * (r + 3));
    ctx.lineTo(cx + Math.cos(a) * (r + 9), cy + Math.sin(a) * (r + 9));
    ctx.stroke();
  }
  ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = C.black; ctx.lineWidth = 1.5; ctx.stroke();
}
function wCloud(ctx, cx, cy, s, fill) {
  // black "halo" then fill -> clean outlined cloud (white clouds need an outline)
  const cs = [[-0.5, 0.12, 0.45], [0, -0.28, 0.55], [0.55, 0.05, 0.45], [0, 0.22, 0.52]];
  ctx.fillStyle = C.black;
  for (const [dx, dy, r] of cs) { ctx.beginPath(); ctx.arc(cx + dx * s, cy + dy * s, r * s + 2, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = fill || C.white;
  for (const [dx, dy, r] of cs) { ctx.beginPath(); ctx.arc(cx + dx * s, cy + dy * s, r * s, 0, Math.PI * 2); ctx.fill(); }
}
function wDrops(ctx, cx, cy, s, n, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 3;
  for (let i = 0; i < n; i++) {
    const x = cx + (i - (n - 1) / 2) * s * 0.5;
    ctx.beginPath(); ctx.moveTo(x, cy + s * 0.5); ctx.lineTo(x - s * 0.14, cy + s * 0.95); ctx.stroke();
  }
}
function wBolt(ctx, cx, cy, s) {
  ctx.fillStyle = C.yellow; ctx.strokeStyle = C.black; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.12, cy + s * 0.35);
  ctx.lineTo(cx - s * 0.22, cy + s * 0.9);
  ctx.lineTo(cx + s * 0.02, cy + s * 0.9);
  ctx.lineTo(cx - s * 0.15, cy + s * 1.3);
  ctx.lineTo(cx + s * 0.38, cy + s * 0.72);
  ctx.lineTo(cx + s * 0.12, cy + s * 0.72);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}
function drawWeatherIcon(ctx, cx, cy, s, type) {
  switch (type) {
    case "sunny": wSun(ctx, cx, cy, s * 0.72); break;
    case "partly":
      wSun(ctx, cx - s * 0.45, cy - s * 0.4, s * 0.45);
      wCloud(ctx, cx + s * 0.12, cy + s * 0.18, s * 0.92);
      break;
    case "cloudy": wCloud(ctx, cx, cy, s); break;
    case "fog":
      wCloud(ctx, cx, cy - s * 0.22, s * 0.92);
      ctx.strokeStyle = C.black; ctx.lineWidth = 3;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(cx - s * 0.6, cy + s * 0.55 + i * s * 0.28); ctx.lineTo(cx + s * 0.6, cy + s * 0.55 + i * s * 0.28); ctx.stroke(); }
      break;
    case "rain": wCloud(ctx, cx, cy - s * 0.22, s * 0.92); wDrops(ctx, cx, cy + s * 0.1, s, 3, C.blue); break;
    case "snow":
      wCloud(ctx, cx, cy - s * 0.22, s * 0.92);
      ctx.fillStyle = C.blue;
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(cx + (i - 1) * s * 0.5, cy + s * 0.75, s * 0.1, 0, Math.PI * 2); ctx.fill(); }
      break;
    case "thunder": wCloud(ctx, cx, cy - s * 0.22, s * 0.92); wBolt(ctx, cx, cy + s * 0.05, s); break;
    default: wCloud(ctx, cx, cy, s);
  }
}

// Weather as up to 3 columns: city 1 left, city 2 middle, city 3 right. Each
// column shows the city name and its next 3 days stacked vertically. Images come
// from assets/weather/<type>.png (dithered to 6 colors); drawn-icon fallback.
async function drawWeatherColumns(ctx, model, x, y, w, h, circleInk) {
  const locs = model.info.weather;
  if (!locs?.length) return;
  const n = Math.min(3, locs.length);
  const colW = w / n;
  const headerH = 30;
  const daysTop = y + headerH;
  const dayH = (h - headerH) / 3;
  const ICON = Math.round(Math.min(dayH - 4, colW * 0.42));

  for (let ci = 0; ci < n; ci++) {
    const loc = locs[ci];
    const colX = x + ci * colW;

    if (ci > 0) { // column separator
      vline(ctx, colX, y + 2, y + h, 1);
    }

    // Shared left margin: the city headline and every date sit on the same edge.
    const pad = 16;
    ctx.textAlign = "left"; ctx.fillStyle = C.black; ctx.font = "bold 22px SansBold";
    ctx.fillText(fitText(ctx, loc.name, colW - pad - 8), colX + pad, y + 18);

    // Each day is one tidy row: date · temps · icon, grouped on the left. The
    // temps are right-aligned into a fixed block so they always end just before
    // the icon — consistent tight spacing, no variable gap, rows stay aligned.
    const tempEndX = colX + pad + 124; // right edge of the temperature block
    const iconX = colX + pad + 132;    // icon sits just right of the temps
    for (let j = 0; j < Math.min(3, loc.days.length); j++) {
      const d = loc.days[j];
      const dd = new Date(d.date + "T00:00:00");
      const midY = daysTop + j * dayH + dayH / 2;
      ctx.textAlign = "left"; ctx.fillStyle = C.black; ctx.font = "bold 15px SansBold";
      ctx.fillText(`${dd.getDate()}.${dd.getMonth() + 1}.`, colX + pad, midY + 5);
      ctx.textAlign = "right";
      ctx.fillStyle = C.blue; ctx.font = "15px Sans";
      const cold = `${d.tmin}°`;
      ctx.fillText(cold, tempEndX, midY + 6);
      const cw = ctx.measureText(cold).width;
      ctx.fillStyle = C.black; ctx.font = "bold 19px SansBold";
      ctx.fillText(`${d.tmax}°`, tempEndX - cw - 6, midY + 6);
      // OpenWeatherMap icon, colour-mixed for the panel (see weatherImage.js).
      // Draw at INTEGER coords + native size with smoothing OFF so the pre-rendered
      // badge is copied pixel-for-pixel (no resampling) — otherwise the same icon's
      // dither would look different in every cell.
      const im = await weatherImage(d.type, ICON, circleInk);
      if (im) {
        const sm = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(im, Math.round(iconX), Math.round(midY - ICON / 2), ICON, ICON);
        ctx.imageSmoothingEnabled = sm;
      }
    }
  }
  ctx.textAlign = "left";
}

// Legend for the day-cell markers, built generically from info.legend. Each
// entry draws its own marker shape + label. Lays out left-to-right and wraps to
// a second row if items overflow the available header width (max two rows).
// Full-width legend footer at vertical position `y`, centered. Built entirely
// from model.info.legend (which comes from the feed config — see data.js).
function drawLegend(ctx, model, y) {
  const items = model.info.legend || [];
  if (!items.length) return;
  ctx.font = "14px Sans"; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  const mk = 16, gap = 22, mkSize = 12;
  const width = (it) => mk + ctx.measureText(it.label).width + gap;
  let total = -gap;
  for (const it of items) total += width(it);
  let x = MARGIN + Math.max(0, (WIDTH - 2 * MARGIN - total) / 2);
  for (const it of items) {
    drawMarker(ctx, it.marker || "dot", it.color, x + mkSize / 2, y - 5, mkSize);
    ctx.fillStyle = C.black;
    ctx.fillText(it.label, x + mk, y);
    x += width(it);
  }
}

export async function renderCalendar(model, cfg, opts = {}) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.antialias = "default";
  ctx.fillStyle = C.white;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  drawHeader(ctx, model, cfg, opts);

  const monthsTop = HEADER_H;
  const monthsBottom = HEIGHT - INFO_H;
  const gap = 34; // more breathing room between the three months
  const monthH = (monthsBottom - monthsTop - 2 * gap) / 3;
  model.months.forEach((m, i) => {
    drawMonth(ctx, model, cfg, m, MARGIN, monthsTop + i * (monthH + gap), WIDTH - 2 * MARGIN, monthH);
  });

  await drawInfoPanel(ctx, model, cfg, opts, monthsBottom, INFO_H);

  return canvas;
}

function drawHeader(ctx, model, cfg, opts) {
  const info = model.info;
  ctx.fillStyle = C.black; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";

  // Year — kept prominent on the left (unchanged).
  ctx.font = "bold 56px SansBold";
  const yearStr = String(model.today.getFullYear());
  ctx.fillText(yearStr, MARGIN, 64);
  const yearW = ctx.measureText(yearStr).width;

  // Day summary spread across the rest of the header width (replaces "KW 26").
  const sx = MARGIN + yearW + 32;
  let y = 34;
  ctx.font = "bold 26px SansBold"; ctx.fillStyle = C.black;
  const dateStr = `${info.weekdayName}, ${info.today.getDate()}. ${info.monthName}`;
  ctx.fillText(dateStr, sx, y);
  const dw = ctx.measureText(dateStr).width;
  ctx.font = "18px Sans"; ctx.fillStyle = C.black;
  ctx.fillText(`KW ${info.isoWeek} · Tag ${info.dayOfYear} · noch ${info.daysLeft} Tage`, sx + dw + 20, y - 2);

  // Line 2: today's holiday / Ferien / name day / moon — inline
  y = 62;
  let lx = sx;
  if (info.publicHoliday) {
    ctx.fillStyle = C.red; ctx.font = "bold 18px SansBold";
    const t = `Feiertag: ${info.publicHoliday.name}`; ctx.fillText(t, lx, y); lx += ctx.measureText(t).width + 22;
  }
  if (info.schoolHoliday && cfg.show?.schoolHolidays !== false) {
    ctx.fillStyle = C.green; ctx.font = "bold 18px SansBold";
    const t = `Ferien: ${info.schoolHoliday}`; ctx.fillText(t, lx, y); lx += ctx.measureText(t).width + 22;
  }
  if (info.nameDays.length) {
    ctx.fillStyle = C.black; ctx.font = "18px Sans";
    const t = `Namenstag: ${info.nameDays.join(", ")}`; ctx.fillText(t, lx, y); lx += ctx.measureText(t).width + 22;
  }
  if (cfg.show?.moon !== false) {
    drawMoonGlyph(ctx, lx + 8, y - 7, 8, ["new", "new", "first", "first", "full", "full", "last", "last"][info.moon.index]);
    ctx.fillStyle = C.black; ctx.font = "18px Sans"; ctx.fillText(info.moon.name, lx + 22, y);
  }

  // Right side: only ever shows REAL device data (no fake battery/clock).
  const hasBatt = typeof opts.battery === "number" && opts.battery > 0;
  ctx.textAlign = "right"; ctx.fillStyle = C.black; ctx.font = "20px Sans";
  const battRight = WIDTH - MARGIN;
  const syncRight = hasBatt ? battRight - 70 : battRight;
  if (opts.lastSync) ctx.fillText(`Aktualisiert: ${opts.lastSync}`, syncRight, 30);
  if (hasBatt) {
    drawBattery(ctx, battRight - 52, 14, 46, 22, opts.battery);
    ctx.textAlign = "right"; ctx.fillStyle = C.black; ctx.font = "15px Sans";
    ctx.fillText(`${opts.battery.toFixed(2)} V`, battRight, 50);
  }
  ctx.textAlign = "left";

  hline(ctx, MARGIN, WIDTH - MARGIN, HEADER_H - 4, 2);
}

// Ordered 4x4 dither → a light grey that survives the panel's quantization (a
// flat light grey would snap to plain white). Used to wash the active month.
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
function fillDitherBg(ctx, x, y, w, h, ink) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
  const id = ctx.createImageData(w, h);
  const d = id.data;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4;
      const t = (BAYER4[(y + yy) & 3][(x + xx) & 3] + 0.5) / 16;
      const v = t < ink ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  ctx.putImageData(id, x, y);
}

function drawMonth(ctx, model, cfg, m, x, y, w, h) {
  // Light grey wash behind the INACTIVE months, so the current month (left white)
  // stands out as the brightest block. Shade is configurable (0 = off).
  const shade = Math.max(0, Math.min(0.5, cfg.inactiveMonthShade ?? 0.12));
  if (!m.current && shade > 0) fillDitherBg(ctx, x - 6, y - 8, w + 12, h + 12, shade);
  const showKW = cfg.show?.weekNumbers !== false;
  const titleH = 48;
  const dowH = 24;
  const gridTop = y + titleH + dowH;
  const gridH = h - titleH - dowH;
  const kwW = showKW ? 52 : 0;
  const colW = (w - kwW) / 7;
  // Only render weeks that actually contain a day of this month — drops fully
  // adjacent-month rows so the remaining cells are taller (more space).
  const weeks = m.weeks.filter((wk) => wk.some((d) => d.getMonth() === m.month));
  const nWeeks = weeks.length;
  const rowH = gridH / nWeeks;

  // Title: German big + other langs small (multilingual like the Bosch).
  const names = MONTHS[m.month];
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.black;
  ctx.font = "bold 30px SansBold";
  const title = `${names[0]} ${m.year}`;
  ctx.fillText(title, x, y + 30);
  const titleW = ctx.measureText(title).width; // measured with the title font
  ctx.font = "16px Sans";
  const langs = `${names[1]} · ${names[2]} · ${names[3]} · ${names[4]}`;
  // White knockout in greyed months so the small multilingual label stays readable.
  if (!m.current) {
    ctx.fillStyle = C.white;
    ctx.fillRect(x + titleW + 22, y + 28 - 13, ctx.measureText(langs).width + 5, 17);
  }
  ctx.fillStyle = C.black;
  ctx.fillText(langs, x + titleW + 24, y + 28);

  // Current month: blue underline below the title — low enough to clear the tail
  // of a capital "J" (Juni/Juli/Januar), which dips below the baseline.
  if (m.current) {
    ctx.fillStyle = C.blue;
    ctx.fillRect(x, y + 41, titleW, 3);
  }

  // Weekday header row
  ctx.font = "bold 16px SansBold";
  const dowY = y + titleH + 17;
  if (showKW) { ctx.fillStyle = C.black; ctx.fillText("KW", x + 6, dowY); }
  for (let i = 0; i < 7; i++) {
    const dow = (i + 1) % 7; // Mon..Sun -> JS getDay 1..0
    ctx.fillStyle = (dow === 0 || (cfg.freeSaturday && dow === 6)) ? C.red : C.black;
    const cx = x + kwW + i * colW + colW / 2;
    ctx.textAlign = "center";
    ctx.fillText(DOW_SHORT_DE[dow], cx, dowY);
    ctx.textAlign = "left";
  }

  // grid lines — crisp 1px black so the dither leaves them solid
  for (let r = 0; r <= nWeeks; r++) {
    hline(ctx, x, x + w, gridTop + r * rowH, 1);
  }

  // cells
  for (let r = 0; r < nWeeks; r++) {
    const week = weeks[r];
    if (showKW) {
      ctx.fillStyle = C.black; ctx.font = "15px Sans"; ctx.textAlign = "center";
      const { isoWeek } = modelWeek(week);
      ctx.fillText(String(isoWeek), x + kwW / 2, gridTop + r * rowH + rowH / 2 + 5);
      ctx.textAlign = "left";
    }
    for (let c = 0; c < 7; c++) {
      const d = week[c];
      const inMonth = d.getMonth() === m.month;
      drawDayCell(ctx, model, cfg, d, inMonth, m.current, x + kwW + c * colW, gridTop + r * rowH, colW, rowH);
    }
  }
}

function modelWeek(week) {
  // week[0] is Monday; compute ISO week from Thursday
  const thu = week[3];
  // reuse isoWeek via datetime — imported lazily to avoid cycle
  return { isoWeek: isoWeekOf(thu) };
}

// local ISO week (kept here to avoid an import cycle through data.js)
function isoWeekOf(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fd = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fd + 3);
  return 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
}

function drawDayCell(ctx, model, cfg, d, inMonth, currentMonth, x, y, w, h) {
  if (!inMonth) return; // adjacent-month days are not drawn (blank → more space)
  const info = model.dayInfo(d);
  const pad = 6;

  // Bottom strips: red = public holiday, green = school holiday (stacked if both).
  // Drawn for EVERY holiday day incl. adjacent-month spill days, so spans stay
  // continuous across month boundaries.
  // Pixel-aligned + exact palette colour so the dither keeps them solid (a
  // fractional rect anti-aliases its edges to pink/pale-green → dither dashes it).
  const sx = Math.round(x + 1), sw = Math.round(w - 2);
  let stripY = Math.round(y + h - 4);
  if (info.publicHoliday) { ctx.fillStyle = C.red; ctx.fillRect(sx, stripY, sw, 3); stripY -= 4; }
  if (info.schoolHoliday && cfg.show?.schoolHolidays !== false) { ctx.fillStyle = C.green; ctx.fillRect(sx, stripY, sw, 3); }

  // Day number — red on Sundays, public holidays, and (optionally) Saturdays.
  const isRed = inMonth && (info.isSunday || info.publicHoliday || (cfg.freeSaturday && info.isSaturday));
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = `bold ${currentMonth ? 30 : 26}px SansBold`;
  const numStr = String(d.getDate());
  const numW = ctx.measureText(numStr).width;

  // Today: the number sits in a calm filled blue pill with a white number —
  // no harsh yellow fill / red frame.
  if (info.isToday) {
    const px = 9, ph = currentMonth ? 40 : 34, py0 = y + 2;
    ctx.fillStyle = C.blue;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x + pad - px, py0, numW + px * 2, ph, 10);
    else ctx.rect(x + pad - px, py0, numW + px * 2, ph);
    ctx.fill();
  }

  ctx.fillStyle = info.isToday ? C.white : (isRed ? C.red : C.black);
  ctx.fillText(numStr, x + pad, y + (currentMonth ? 33 : 30));
  const numRight = x + pad + numW;

  // Moon glyph — top-right corner.
  if (info.moon) drawMoonGlyph(ctx, x + w - 14, y + 13, 7, info.moon);

  // Event markers — left-aligned right next to the number, flowing across the
  // cell and wrapping onto further rows so a busy day fills the space. "+N" when
  // it runs out of room above the bottom holiday text.
  const evs = info.events || [];
  if (evs.length) {
    const r = 9, step = 14, rowStep = 15;
    const hasName = !!(info.publicHoliday || info.schoolHoliday);
    const bottomLimit = y + h - (hasName ? 16 : 6);
    let cx = numRight + (info.isToday ? 22 : 12), cy = y + (currentMonth ? 24 : 22), firstRow = true, drawn = 0, overflow = false;
    for (let i = 0; i < evs.length; i++) {
      const right = (firstRow && info.moon) ? x + w - 24 : x + w - pad;
      if (cx + r / 2 > right) { cx = x + pad + r / 2; cy += rowStep; firstRow = false; if (cy > bottomLimit) { overflow = true; break; } }
      drawMarker(ctx, evs[i].marker || "dot", evs[i].color, cx, cy, r);
      cx += step; drawn++;
    }
    if (overflow) {
      ctx.fillStyle = C.black; ctx.font = "10px Sans"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`+${evs.length - drawn}`, cx, cy + 3);
    }
  }

  // Holiday / Ferien names — BOTTOM of the cell (low), so they never crowd the date.
  const lineY = y + h - 9;
  ctx.font = "11px SansBold"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  // In greyed (inactive) months, paint a white knockout behind the coloured name
  // so red/green text stays readable against the grey dither.
  const nameText = (txt, color) => {
    if (!currentMonth) {
      ctx.fillStyle = C.white;
      ctx.fillRect(x + pad - 1, lineY - 10, Math.min(w - 2 * pad + 2, ctx.measureText(txt).width + 3), 13);
    }
    ctx.fillStyle = color;
    ctx.fillText(txt, x + pad, lineY);
  };
  if (info.publicHoliday) {
    nameText(fitText(ctx, info.publicHoliday.name, w - 2 * pad), C.red);
  } else if (info.otherHoliday) {
    // public holiday in a state we don't live in but work with: black & white,
    // labelled with the state(s).
    nameText(fitText(ctx, `${info.otherHoliday.name} (${info.otherHoliday.stateNames.join(", ")})`, w - 2 * pad), C.black);
  } else if (info.schoolHoliday && cfg.show?.schoolHolidays !== false) {
    const prev = new Date(d); prev.setDate(d.getDate() - 1);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const isStart = model.dayInfo(prev).schoolHoliday !== info.schoolHoliday;
    const isEnd = model.dayInfo(next).schoolHoliday !== info.schoolHoliday;
    if (isStart || d.getDate() === 1) nameText(fitText(ctx, info.schoolHoliday, w - 2 * pad), C.green);
    else if (isEnd) nameText("Ende", C.green);
  }
}

// Build a QR for the control-panel URL. Returns an object whose draw() paints
// crisp, integer-pixel-aligned black modules on a white quiet zone — pure
// black/white so it survives the panel's 6-colour quantization with no dither
// or anti-alias fringes (a scaled raster QR would shatter). null if no URL.
function makeQR(text, target = 116) {
  if (!text) return null;
  const qr = QRCode.create(String(text), { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data; // row-major, 1 = dark module
  const quiet = 2;              // white border (in modules) so it scans on any backdrop
  const cells = n + quiet * 2;
  const mod = Math.max(2, Math.floor(target / cells)); // integer module size, no AA
  const size = mod * cells;
  return {
    size,
    draw(ctx, x, y) {
      ctx.fillStyle = C.white;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = C.black;
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
          if (data[r * n + c])
            ctx.fillRect(x + (c + quiet) * mod, y + (r + quiet) * mod, mod, mod);
    },
  };
}

async function drawInfoPanel(ctx, model, cfg, opts, top, h) {
  const info = model.info;
  hline(ctx, MARGIN, WIDTH - MARGIN, top + 6, 3);

  const innerW = WIDTH - 2 * MARGIN;
  const weatherW = Math.round(innerW * 0.6);
  const panelBottom = top + h - 36; // reserve a strip for the legend footer
  const sepBottom = panelBottom - 6; // verticals stop above the legend divider

  // Weather moved UP into the strip freed by the "today" summary (same height as
  // before — not enlarged). The daily quote sits below it.
  const wy = top + 30;
  const weatherH = sepBottom - (top + 98); // keep the original weather height
  if (info.weather?.length) {
    await drawWeatherColumns(ctx, model, MARGIN, wy, weatherW, weatherH, Math.max(0, Math.min(0.8, cfg.weatherCircleShade ?? 0.12)));
  }
  if (info.quote) {
    drawQuote(ctx, info.quote, MARGIN, wy + weatherH + 10, weatherW, sepBottom - (wy + weatherH + 10));
  }

  // Control-panel QR in the lower-right corner, above the legend. The Demnächst
  // list reserves this corner so nothing overlaps it.
  const qr = makeQR(opts.controlUrl);
  const reserve = qr ? { h: qr.size + 10 } : null; // QR height + small gap

  const sepX = MARGIN + weatherW + 14;
  const demY = top + 30;
  vline(ctx, sepX, demY - 8, sepBottom, 1);
  drawUpcoming(ctx, model, sepX + 16, demY, WIDTH - MARGIN - (sepX + 16), sepBottom - demY, reserve);

  if (qr) {
    qr.draw(ctx, WIDTH - MARGIN - qr.size, sepBottom - qr.size);
  }

  // ---- Legend footer (config-driven): divider above the row, row above the border ----
  hline(ctx, MARGIN, WIDTH - MARGIN, panelBottom, 1);
  drawLegend(ctx, model, top + h - 12);
}

// Daily horoscopes — up to 3 full-width ROWS below the weather. Each row: the
// sign name (German, bold) followed by the COMPLETE daily text (no truncation),
// flowing across the full width with a hanging indent.
function drawHoroscopes(ctx, model, x, y, w, h) {
  const list = model.info.horoscopes || [];
  if (!list.length) return;
  const n = Math.min(3, list.length);
  const rowH = h / n;
  for (let i = 0; i < n; i++) {
    const ho = list[i];
    const ry = y + i * rowH;
    if (i > 0) hline(ctx, x, x + w, ry - 5, 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.black; ctx.font = "bold 15px SansBold";
    const label = ho.signName + ":  ";
    ctx.fillText(label, x, ry + 13);
    const lw = ctx.measureText(label).width;
    ctx.font = "13px Sans"; ctx.fillStyle = C.black;
    flowText(ctx, ho.text, x, ry + 13, x + lw, w, 16);
  }
  ctx.textAlign = "left";
}

// Draw `text` word-by-word with wrapping and NO truncation. First line starts at
// firstX (after the sign label); wrapped lines return to x. Lines step by lineH.
function flowText(ctx, text, x, y, firstX, w, lineH) {
  const words = String(text).split(/\s+/).filter(Boolean);
  let cx = firstX, cy = y;
  for (const wd of words) {
    const ww = ctx.measureText(wd + " ").width;
    if (cx + ww > x + w) { cy += lineH; cx = x; }
    ctx.fillText(wd, cx, cy);
    cx += ww;
  }
}

// Daily quote ("Spruch des Tages") below the weather — italic, full text wrapped.
function drawQuote(ctx, quote, x, y, w, h) {
  if (!quote || !quote.text) return;
  ctx.fillStyle = C.black; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.font = "italic 16px SansItalic";
  const str = quote.author ? `„${quote.text}"  — ${quote.author}` : `„${quote.text}"`;
  flowText(ctx, str, x + 4, y + 18, x + 4, w - 8, 20);
}

// "Demnächst" — generic upcoming-events list (date label + colored marker + title).
// `reserve` (optional) {h} keeps the bottom-right corner clear for the QR: the
// right column simply ends higher; overflow rolls into the "+N weitere" tally.
function drawUpcoming(ctx, model, x, y, w, h, reserve = null) {
  const info = model.info;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.black; ctx.font = "bold 20px SansBold";
  ctx.fillText("Demnächst", x, y + 6);

  const items = info.upcoming || [];
  if (!items.length) {
    ctx.fillStyle = C.black; ctx.font = "15px Sans";
    ctx.fillText("Keine Termine", x, y + 34);
    return;
  }

  // Two columns: fill column 1 top-to-bottom (soonest), then column 2. The right
  // column loses any rows that would collide with the reserved QR corner.
  const top = y + 22;
  const lineH = 22;
  const leftRows = Math.max(1, Math.floor((y + h - top) / lineH));
  const rightLimit = y + h - (reserve?.h || 0);
  const rightRows = Math.max(1, Math.floor((rightLimit - top) / lineH));
  const colGap = 16;
  const colW = (w - colGap) / 2;
  const capacity = leftRows + rightRows;
  const show = Math.min(items.length, capacity);
  for (let i = 0; i < show; i++) {
    const col = i < leftRows ? 0 : 1;
    const row = i < leftRows ? i : i - leftRows;
    const cx = x + col * (colW + colGap);
    const ry = top + row * lineH + 12;
    const e = items[i];
    const label = relLabel(e.date, info.today, DOW_SHORT_DE);
    ctx.font = "bold 14px SansBold"; ctx.fillStyle = C.black; ctx.textAlign = "left";
    ctx.fillText(label, cx, ry);
    const labW = Math.max(44, ctx.measureText(label).width + 8);
    drawMarker(ctx, e.marker || "dot", e.color, cx + labW + 3, ry - 5, 9);
    ctx.font = "14px Sans"; ctx.fillStyle = binColorCss(e.color);
    ctx.fillText(fitText(ctx, e.title, colW - (labW + 15)), cx + labW + 13, ry);
  }
  if (items.length > show) {
    ctx.font = "13px Sans"; ctx.fillStyle = C.black; ctx.textAlign = "left";
    ctx.fillText(`+ ${items.length - show} weitere`, x, top + leftRows * lineH + 10);
  }
}

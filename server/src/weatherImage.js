// Loads a weather image (assets/weather/<type>.png — the OpenWeatherMap set) and
// renders it as a badge for the 6-colour panel:
//
//   - a GREY CIRCLE background (black+white ordered dither = perceived grey),
//   - a COLOURFUL foreground icon on top:
//       white/light cloud -> WHITE   (visible against the grey circle)
//       dark/shadow cloud -> BLACK
//       sun / bolt (warm) -> ORANGE  = red + yellow ordered dither
//       rain (blue-ish)   -> BLUE
//       snow / mist (grey)-> WHITE
//
// The grey circle is what makes white clouds visible without any outline, and it
// restores the cloudy-vs-overcast distinction (one white cloud vs white + dark).
// Dithering is confined to the icon badge — it never touches calendar text/lines.
// Result canvases are cached per type+size.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "weather");
const cache = new Map();

// 4x4 Bayer matrix → clean uniform ordered dither (no noise).
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const bthr = (x, y) => (BAYER[y & 3][x & 3] + 0.5) / 16;

const BLACK = [0, 0, 0], WHITE = [255, 255, 255], YELLOW = [255, 233, 0], RED = [200, 0, 0], BLUE = [0, 70, 200];
const CIRCLE_INK = 0.04; // grey level of the badge background (light; still enough for white clouds to show)

const isWarm = (r, g, b) => r > 110 && r >= g && b < r * 0.7;       // sun / bolt

const CSS = { yellow: "rgb(255,233,0)", red: "rgb(200,0,0)", blue: "rgb(0,70,200)", black: "rgb(0,0,0)" };

// Bold drawn symbols for types where real icon sets read poorly at badge size:
// OWM's "clear sky" is a rayless disc; Meteocons' thermometer/wind are thin lines.
// (cx,cy,R) is the badge circle.
function drawSun(ctx, cx, cy, R, colorCss) {
  ctx.strokeStyle = colorCss; ctx.fillStyle = colorCss; ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, R * 0.16);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62);
    ctx.lineTo(cx + Math.cos(a) * R * 0.92, cy + Math.sin(a) * R * 0.92);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.42, 0, Math.PI * 2); ctx.fill();
}
function drawThermo(ctx, cx, cy, R) {
  ctx.strokeStyle = CSS.red; ctx.lineCap = "round"; ctx.lineWidth = R * 0.26;
  ctx.beginPath(); ctx.moveTo(cx, cy - R * 0.5); ctx.lineTo(cx, cy + R * 0.35); ctx.stroke();
  ctx.fillStyle = CSS.red;
  ctx.beginPath(); ctx.arc(cx, cy + R * 0.45, R * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = CSS.black; ctx.lineWidth = Math.max(1.5, R * 0.07);
  for (let i = 0; i < 3; i++) {
    const ty = cy - R * 0.3 + i * R * 0.22;
    ctx.beginPath(); ctx.moveTo(cx + R * 0.2, ty); ctx.lineTo(cx + R * 0.42, ty); ctx.stroke();
  }
}
function drawWind(ctx, cx, cy, R) {
  ctx.strokeStyle = CSS.black; ctx.lineCap = "round"; ctx.lineWidth = Math.max(2, R * 0.13);
  for (const l of [{ y: -0.34, x1: 0.2, curl: 1 }, { y: 0, x1: 0.5, curl: 0 }, { y: 0.34, x1: 0.1, curl: 1 }]) {
    ctx.beginPath();
    ctx.moveTo(cx - 0.7 * R, cy + l.y * R);
    ctx.lineTo(cx + l.x1 * R, cy + l.y * R);
    ctx.stroke();
    if (l.curl) { ctx.beginPath(); ctx.arc(cx + l.x1 * R, cy + l.y * R + R * 0.17, R * 0.17, -Math.PI / 2, Math.PI * 0.55); ctx.stroke(); }
  }
}
const DRAWN = {
  sunny: (ctx, cx, cy, R) => drawSun(ctx, cx, cy, R, CSS.yellow),
  scorching: (ctx, cx, cy, R) => drawSun(ctx, cx, cy, R, CSS.red),
  hot: drawThermo,
  windy: drawWind,
};

export async function weatherImage(type, size, circleInk = CIRCLE_INK) {
  const key = `${type}@${size}@${circleInk}`;
  if (cache.has(key)) return cache.get(key);

  const cv = createCanvas(size, size);
  const ctx = cv.getContext("2d");

  // --- 1. grey dithered circle background ---
  const bg = ctx.createImageData(size, size);
  const bd = bg.data;
  const cx = (size - 1) / 2, cy = (size - 1) / 2, R = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) {
        const v = bthr(x, y) < circleInk ? 0 : 255;
        bd[i] = bd[i + 1] = bd[i + 2] = v; bd[i + 3] = 255;
      } else { bd[i + 3] = 0; }
    }
  }
  ctx.putImageData(bg, 0, 0);

  // --- drawn-symbol types (bold pictographs that read at badge size) ---
  if (DRAWN[type]) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    DRAWN[type](ctx, cx, cy, R);
    ctx.restore();
    cache.set(key, cv);
    return cv;
  }

  // --- image-based types: load the PNG (OWM / Meteocons) ---
  const file = join(DIR, `${type}.png`);
  if (!existsSync(file)) { cache.set(key, null); return null; }
  const img = await loadImage(file);

  // --- 2. colourful foreground icon. First TRIM the transparent padding baked
  // into the OWM source so the actual symbol (not its empty margin) fills the
  // badge, then scale it to nearly fill the circle. Clipped to the circle so a
  // wide cloud can be large without poking outside the disc. ---
  const probe = createCanvas(img.width, img.height);
  const pc = probe.getContext("2d");
  pc.drawImage(img, 0, 0);
  const pd = pc.getImageData(0, 0, img.width, img.height).data;
  let minX = img.width, minY = img.height, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (pd[(y * img.width + x) * 4 + 3] > 20) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y; found = true;
      }
    }
  }
  if (!found) { minX = 0; minY = 0; maxX = img.width - 1; maxY = img.height - 1; }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;

  const t = createCanvas(size, size);
  const tc = t.getContext("2d");
  tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = "high";
  // Fit the symbol's whole bounding box INSIDE the circle by its diagonal, so
  // nothing (e.g. the sun's rays) gets clipped at the disc edge. Wide-short clouds
  // still nearly fill the disc; squarer icons (sun) shrink just enough to fit.
  const scale = (2 * R * 0.96) / Math.hypot(bw, bh);
  const w = Math.max(1, Math.round(bw * scale));
  const h = Math.max(1, Math.round(bh * scale));
  const dy = Math.round((size - h) / 2);
  tc.drawImage(img, minX, minY, bw, bh, Math.round((size - w) / 2), dy, w, h);
  const id = tc.getImageData(0, 0, size, size);
  const a = id.data;
  // Precipitation is coloured BLUE. Drops can't be told from the cloud outline by
  // colour (both dark grey), so use type + position: rain/thunder drops sit in the
  // lower part of the icon; snow is a standalone flake (colour the whole thing).
  const dropTypes = type === "rain" || type === "thunder" || type === "tornado";
  const snowy = type === "snow";
  const dropY = dy + h * 0.58;
  // Sun colour by type: plain sun = yellow, heat = red (so sunny / hot / scorching
  // are visually distinct). Other warm bits (bolts, sun-behind-cloud) = orange.
  const warmCol = type === "sunny" ? YELLOW : (type === "scorching" || type === "hot") ? RED : null;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (a[i + 3] < 128) { a[i + 3] = 0; continue; }
      const r = a[i], g = a[i + 1], b = a[i + 2];
      let col;
      if (isWarm(r, g, b)) col = warmCol || (bthr(x, y) < 0.5 ? RED : YELLOW); // sun by type, else orange
      else {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 150) col = WHITE;                                      // cloud body / highlight
        else if (snowy || (dropTypes && y > dropY)) col = BLUE;          // snow flake / rain drops
        else col = BLACK;                                                // cloud outline / dark cloud
      }
      a[i] = col[0]; a[i + 1] = col[1]; a[i + 2] = col[2]; a[i + 3] = 255;
    }
  }
  tc.putImageData(id, 0, 0);
  // composite icon over the grey circle, clipped to the disc so nothing pokes out
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(t, 0, 0);
  ctx.restore();

  cache.set(key, cv);
  return cv;
}

// Generates a cute "kawaii" starter weather set into assets/weather/*.png
// (transparent background, full color). These are just placeholders so the
// image pipeline works immediately — replace any file with your own anime art.
//   node scripts/gen-weather.js

import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "weather");
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const S = 240;
const YELLOW = "#ffe900", BLACK = "#000", WHITE = "#fff", BLUE = "#0046c8", RED = "#c80000", GREEN = "#00823c";

function face(ctx, cx, cy, scale = 1, look = "happy") {
  ctx.fillStyle = BLACK;
  const e = 7 * scale;
  ctx.beginPath(); ctx.arc(cx - 22 * scale, cy, e, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 22 * scale, cy, e, 0, 7); ctx.fill();
  // cheeks
  ctx.fillStyle = RED;
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.arc(cx - 34 * scale, cy + 12 * scale, 9 * scale, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 34 * scale, cy + 12 * scale, 9 * scale, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;
  // mouth
  ctx.strokeStyle = BLACK; ctx.lineWidth = 4 * scale; ctx.lineCap = "round";
  ctx.beginPath();
  if (look === "happy") ctx.arc(cx, cy + 8 * scale, 12 * scale, 0.15 * Math.PI, 0.85 * Math.PI);
  else { ctx.moveTo(cx - 8 * scale, cy + 14 * scale); ctx.lineTo(cx + 8 * scale, cy + 14 * scale); }
  ctx.stroke();
}

function sun(ctx, cx, cy, r, withFace = true) {
  ctx.fillStyle = YELLOW; ctx.strokeStyle = BLACK; ctx.lineWidth = 5;
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(r + 4, -9); ctx.lineTo(r + 26, 0); ctx.lineTo(r + 4, 9); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.stroke();
  if (withFace) face(ctx, cx, cy + 4, 1, "happy");
}

function cloud(ctx, cx, cy, s, fill = WHITE, withFace = true, look = "happy") {
  const cs = [[-0.55, 0.12, 0.46], [-0.05, -0.3, 0.56], [0.55, 0.02, 0.46], [0, 0.24, 0.54]];
  ctx.fillStyle = BLACK;
  for (const [dx, dy, r] of cs) { ctx.beginPath(); ctx.arc(cx + dx * s, cy + dy * s, r * s + 5, 0, 7); ctx.fill(); }
  ctx.fillStyle = fill;
  for (const [dx, dy, r] of cs) { ctx.beginPath(); ctx.arc(cx + dx * s, cy + dy * s, r * s, 0, 7); ctx.fill(); }
  if (withFace) face(ctx, cx, cy + 2, 1, look);
}

function drops(ctx, cx, cy, color, n = 3) {
  ctx.fillStyle = color; ctx.strokeStyle = BLACK; ctx.lineWidth = 3;
  for (let i = 0; i < n; i++) {
    const x = cx + (i - (n - 1) / 2) * 42;
    ctx.beginPath();
    ctx.moveTo(x, cy); ctx.quadraticCurveTo(x - 12, cy + 22, x, cy + 30);
    ctx.quadraticCurveTo(x + 12, cy + 22, x, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}

const ICONS = {
  sunny: (ctx) => sun(ctx, S / 2, S / 2, 64),
  partly: (ctx) => { sun(ctx, S * 0.36, S * 0.36, 40, false); cloud(ctx, S * 0.58, S * 0.6, 78); },
  cloudy: (ctx) => cloud(ctx, S / 2, S / 2, 92),
  fog: (ctx) => {
    cloud(ctx, S / 2, S * 0.42, 84, WHITE, true, "happy");
    ctx.strokeStyle = "#888"; ctx.lineWidth = 9; ctx.lineCap = "round";
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(S * 0.25, S * 0.74 + i * 22); ctx.lineTo(S * 0.75, S * 0.74 + i * 22); ctx.stroke(); }
  },
  rain: (ctx) => { cloud(ctx, S / 2, S * 0.4, 84); drops(ctx, S / 2, S * 0.7, BLUE, 3); },
  snow: (ctx) => {
    cloud(ctx, S / 2, S * 0.4, 84);
    ctx.fillStyle = BLUE;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(S / 2 + (i - 1) * 42, S * 0.78, 9, 0, 7); ctx.fill(); }
  },
  thunder: (ctx) => {
    cloud(ctx, S / 2, S * 0.4, 84, WHITE, true, "flat");
    ctx.fillStyle = YELLOW; ctx.strokeStyle = BLACK; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(S * 0.52, S * 0.62); ctx.lineTo(S * 0.4, S * 0.82); ctx.lineTo(S * 0.5, S * 0.82);
    ctx.lineTo(S * 0.44, S * 0.98); ctx.lineTo(S * 0.62, S * 0.74); ctx.lineTo(S * 0.52, S * 0.74);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  },
};

for (const [name, draw] of Object.entries(ICONS)) {
  const cv = createCanvas(S, S);
  const ctx = cv.getContext("2d");
  ctx.lineJoin = "round";
  draw(ctx);
  writeFileSync(join(DIR, `${name}.png`), cv.toBuffer("image/png"));
  console.log("wrote", `${name}.png`);
}
console.log("done ->", DIR);

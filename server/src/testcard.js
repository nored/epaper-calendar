// A sharp-vs-current test card for the Spectra-6 panel. Rendered at the native
// 1200x1600 so every pixel maps 1:1 to the glass — no scaling anywhere.
//
// Purpose: prove whether the panel can show crisp text, and whether the softness
// is our render pipeline (anti-aliased text hard-thresholded to 1-bit). Two blocks
// draw the SAME lines two ways:
//   • "1x (aktuell)"  — normal canvas fillText (anti-aliased), the way the calendar
//                       is drawn today; packFramebuffer later thresholds it.
//   • "scharf"        — supersampled 4x then downsampled with a hard ink-coverage
//                       threshold, i.e. crisp bilevel text with no grey edges.
// Compare the two blocks on the actual panel: if "scharf" is clearly better, the
// fix is to render the calendar text that way.
import { createCanvas } from "@napi-rs/canvas";
import { WIDTH, HEIGHT, C } from "./palette.js";
// render.js registers the DejaVu fonts (Sans/SansBold) at import; importing it
// here (indirectly, via server.js load order) guarantees they're available.

const SAMPLE = "Christchurch 11.7.  9° 2°  AaBbCcGg 0123456789";
const SIZES = [12, 14, 16, 20, 28];

// Draw text as crisp bilevel: render at `ss`x, downsample with a hard 50%
// ink-coverage threshold, blit the resulting black/white pixels at (x, yTop).
function drawSharpText(mainCtx, text, x, yTop, px, family = "SansBold", ss = 4) {
  const meas = createCanvas(4, 4).getContext("2d");
  meas.font = `${px}px ${family}`;
  const w = Math.max(1, Math.ceil(meas.measureText(text).width) + 2);
  const h = Math.ceil(px * 1.6) + 2;

  const big = createCanvas(w * ss, h * ss);
  const bg = big.getContext("2d");
  bg.fillStyle = "#fff"; bg.fillRect(0, 0, w * ss, h * ss);
  bg.fillStyle = "#000"; bg.textBaseline = "top";
  bg.font = `${px * ss}px ${family}`;
  bg.fillText(text, ss, ss);
  const src = bg.getImageData(0, 0, w * ss, h * ss).data;

  const out = mainCtx.createImageData(w, h);
  const o = out.data;
  const area = ss * ss;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      let ink = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const si = (((yy * ss + dy) * (w * ss)) + (xx * ss + dx)) * 4;
          const lum = (0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2]) / 255;
          ink += 1 - lum;
        }
      }
      const black = ink / area >= 0.5;
      const oi = (yy * w + xx) * 4;
      o[oi] = o[oi + 1] = o[oi + 2] = black ? 0 : 255;
      o[oi + 3] = 255;
    }
  }
  mainCtx.putImageData(out, x, yTop);
  return h;
}

export function renderSharpTestCard() {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.white; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = C.black;

  const M = 40;
  let y = 56;
  ctx.textBaseline = "alphabetic";
  ctx.font = "bold 34px SansBold";
  ctx.fillText("SCHÄRFE-TEST  ·  1200×1600  ·  1:1", M, y);
  y += 30;

  // Block 1: current pipeline (anti-aliased fillText)
  ctx.font = "bold 20px SansBold";
  ctx.fillText("1× (aktuell — anti-aliased, dann hart geschwellt):", M, y);
  y += 16;
  for (const px of SIZES) {
    ctx.textBaseline = "top";
    ctx.font = `${px}px SansBold`;
    ctx.fillStyle = C.black;
    ctx.fillText(SAMPLE, M, y);
    y += Math.ceil(px * 1.6) + 4;
    ctx.textBaseline = "alphabetic";
  }

  y += 24;

  // Block 2: sharp bilevel (supersampled + threshold)
  ctx.font = "bold 20px SansBold";
  ctx.fillText("scharf (4× → 1-Bit, keine Graukanten):", M, y);
  y += 20;
  for (const px of SIZES) {
    const hh = drawSharpText(ctx, SAMPLE, M, y, px);
    y += hh + 4;
  }

  y += 30;

  // Fine patterns: 1px lines + checkerboard — these are crisp by construction and
  // show the panel's true pixel fidelity.
  ctx.fillStyle = C.black;
  ctx.font = "bold 20px SansBold";
  ctx.fillText("1-px Linien & Schachbrett (Panel-Auflösung):", M, y);
  y += 20;
  // vertical hairlines with widening gaps
  for (let i = 0, x = M; i < 60 && x < WIDTH - M; i++) { ctx.fillRect(x, y, 1, 60); x += 2 + Math.floor(i / 10); }
  // 1px checkerboard block
  const cbX = M + 500, cb = 120;
  for (let yy = 0; yy < cb; yy++) for (let xx = 0; xx < cb; xx++) if (((xx + yy) & 1) === 0) ctx.fillRect(cbX + xx, y + yy, 1, 1);
  y += 80;

  // horizontal hairlines
  for (let i = 0, yy = y; i < 24 && yy < y + 80; i++) { ctx.fillRect(M, yy, 300, 1); yy += 2 + Math.floor(i / 6); }
  y += 100;

  // Color swatches — the six panel inks, solid, with labels.
  ctx.fillStyle = C.black; ctx.font = "bold 20px SansBold";
  ctx.fillText("Die 6 Farben (voll gesättigt):", M, y);
  y += 16;
  const inks = [["Schwarz", C.black], ["Weiß", C.white], ["Gelb", C.yellow], ["Rot", C.red], ["Blau", C.blue], ["Grün", C.green]];
  const sw = 170, sh = 90, gap = 14;
  let sx = M;
  for (const [label, col] of inks) {
    ctx.strokeStyle = C.black; ctx.lineWidth = 1; ctx.strokeRect(sx + 0.5, y + 0.5, sw, sh);
    ctx.fillStyle = col; ctx.fillRect(sx + 1, y + 1, sw - 1, sh - 1);
    ctx.fillStyle = (col === C.white || col === C.yellow) ? C.black : C.white;
    ctx.font = "bold 18px SansBold"; ctx.textBaseline = "alphabetic";
    ctx.fillText(label, sx + 10, y + sh - 12);
    sx += sw + gap;
    if (sx + sw > WIDTH - M) { sx = M; y += sh + gap; }
  }

  return canvas;
}

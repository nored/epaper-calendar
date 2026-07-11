// Draw text with the Waveshare/STM bitmap fonts (font8/12/16/20/24, + synthesized
// German glyphs) instead of an outline font. installWSFont(ctx) overrides fillText
// and measureText on a canvas context so the whole calendar renders in these 1-bit
// bitmap glyphs — no anti-aliasing, exactly what the panel shows.
import { WSFONTS } from "./wsfontdata.js";

// Decode the hex glyph tables to byte arrays once.
const FONTS = {};
for (const [h, f] of Object.entries(WSFONTS)) {
  const bpr = Math.ceil(f.W / 8);
  const glyphs = {};
  for (const [ch, hex] of Object.entries(f.glyphs)) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
    glyphs[ch] = arr;
  }
  FONTS[+h] = { W: f.W, H: f.H, bpr, glyphs };
}
const HEIGHTS = Object.keys(FONTS).map(Number).sort((a, b) => a - b);

// Pick the (font, integer-scale) whose pixel height is closest to the requested px.
function pick(px) {
  let best = { h: HEIGHTS[0], scale: 1 }, bd = Infinity;
  for (const h of HEIGHTS) {
    for (let s = 1; s <= 6; s++) {
      const d = Math.abs(h * s - px);
      if (d < bd) { bd = d; best = { h, scale: s }; }
    }
  }
  return best;
}
function strWidth(px, str) {
  const { h, scale } = pick(px);
  return str.length * (FONTS[h].W + 1) * scale;
}
function draw(ctx, str, x, y, px, align, baseline) {
  const { h, scale } = pick(px);
  const f = FONTS[h], W = f.W, H = f.H, bpr = f.bpr;
  const w = str.length * (W + 1) * scale;
  let sx = x;
  if (align === "center") sx = x - w / 2;
  else if (align === "right" || align === "end") sx = x - w;
  let sy;
  if (baseline === "top" || baseline === "hanging") sy = y;
  else if (baseline === "middle") sy = y - (H * scale) / 2;
  else if (baseline === "bottom") sy = y - H * scale;
  else sy = y - Math.round(H * scale * 0.80); // alphabetic baseline ~80% down the cell
  sx = Math.round(sx); sy = Math.round(sy);
  for (const ch of str) {
    const g = f.glyphs[ch] || f.glyphs["?"] || f.glyphs[" "];
    if (g) {
      for (let r = 0; r < H; r++) {
        const row = r * bpr;
        for (let c = 0; c < W; c++) {
          if (g[row + (c >> 3)] & (0x80 >> (c & 7))) ctx.fillRect(sx + c * scale, sy + r * scale, scale, scale);
        }
      }
    }
    sx += (W + 1) * scale;
  }
}

export function installWSFont(ctx) {
  const realFill = ctx.fillText.bind(ctx);
  const realMeasure = ctx.measureText.bind(ctx);
  const pxOf = () => { const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font || ""); return m ? parseFloat(m[1]) : 16; };
  const isIcon = () => /WeatherIcons/i.test(ctx.font || ""); // leave the weather symbol font alone
  ctx.fillText = (str, x, y) => {
    if (isIcon()) return realFill(str, x, y);
    draw(ctx, String(str), x, y, pxOf(), ctx.textAlign, ctx.textBaseline);
  };
  ctx.measureText = (str) => {
    if (isIcon()) return realMeasure(str);
    return { width: strWidth(pxOf(), String(str)) };
  };
}

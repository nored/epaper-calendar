// Render text with DejaVu rasterized to hinted 1-bit (Pillow/FreeType mono) —
// proportional widths, full glyph coverage, no anti-aliasing. installPXFont(ctx)
// overrides fillText/measureText so the whole calendar draws in these bitmaps,
// which is what the panel actually shows (no grey).
import { PXFONTS } from "./pxfontdata.js";

const FONTS = {};
const SIZES = {}; // weight -> sorted list of generated sizes
for (const [key, f] of Object.entries(PXFONTS)) {
  const w = key.split(":")[0], s = +key.split(":")[1];
  const g = {};
  for (const [ch, gl] of Object.entries(f.g)) {
    const bpr = Math.max(1, Math.ceil(gl.w / 8));
    const arr = new Uint8Array(gl.b.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(gl.b.substr(i * 2, 2), 16);
    g[ch] = { w: gl.w, bpr, bmp: arr };
  }
  FONTS[key] = { asc: f.asc, H: f.H, g };
  (SIZES[w] || (SIZES[w] = [])).push(s);
}
for (const w in SIZES) SIZES[w].sort((a, b) => a - b);

function parseFont(fontStr) {
  const size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(fontStr) || [])[1]) || 16;
  let weight = "Sans";
  if (/SansBold/.test(fontStr) || /\bbold\b/i.test(fontStr)) weight = "SansBold";
  if (/SansItalic/.test(fontStr) || /\b(italic|oblique)\b/i.test(fontStr)) weight = "SansItalic";
  if (!SIZES[weight]) weight = "Sans";
  return { weight, size };
}
function pickKey(weight, size) {
  const list = SIZES[weight];
  let best = list[0], bd = Infinity;
  for (const s of list) { const d = Math.abs(s - size); if (d < bd) { bd = d; best = s; } }
  return weight + ":" + best;
}
function widthOf(f, str) {
  let w = 0;
  for (const ch of str) { const g = f.g[ch] || f.g["?"] || f.g[" "]; w += g ? g.w : 0; }
  return w;
}
function draw(ctx, str, x, y) {
  const { weight, size } = parseFont(ctx.font || "");
  const f = FONTS[pickKey(weight, size)];
  str = String(str);
  const w = widthOf(f, str);
  let sx = x;
  const al = ctx.textAlign;
  if (al === "center") sx = x - w / 2;
  else if (al === "right" || al === "end") sx = x - w;
  const bl = ctx.textBaseline;
  let top;
  if (bl === "top" || bl === "hanging") top = y;
  else if (bl === "middle") top = y - f.H / 2;
  else if (bl === "bottom") top = y - f.H;
  else top = y - f.asc; // alphabetic
  sx = Math.round(sx); top = Math.round(top);
  for (const ch of str) {
    const g = f.g[ch] || f.g["?"] || f.g[" "];
    if (g && g.bmp) {
      for (let r = 0; r < f.H; r++) {
        const row = r * g.bpr;
        let c = 0;
        while (c < g.w) {
          if (g.bmp[row + (c >> 3)] & (0x80 >> (c & 7))) {
            let c2 = c;
            while (c2 < g.w && (g.bmp[row + (c2 >> 3)] & (0x80 >> (c2 & 7)))) c2++;
            ctx.fillRect(sx + c, top + r, c2 - c, 1);
            c = c2;
          } else c++;
        }
      }
    }
    sx += g ? g.w : 0;
  }
}
export function installPXFont(ctx) {
  const realFill = ctx.fillText.bind(ctx);
  const realMeasure = ctx.measureText.bind(ctx);
  const isIcon = () => /WeatherIcons/i.test(ctx.font || ""); // leave the weather symbol font alone
  ctx.fillText = (s, x, y) => { if (isIcon()) return realFill(s, x, y); draw(ctx, s, x, y); };
  ctx.measureText = (s) => {
    if (isIcon()) return realMeasure(s);
    const { weight, size } = parseFont(ctx.font || "");
    return { width: widthOf(FONTS[pickKey(weight, size)], String(s)) };
  };
}

// 6-color palette for the Waveshare 13.3" Spectra 6 (E6) panel.
//
// The panel framebuffer is 4 bits/pixel, 2 pixels/byte, row-major:
//   byte = Image[y * 600 + (x >> 1)]
//   even x -> high nibble, odd x -> low nibble
// (matches EPD_13IN3E_Display() and Paint_SetPixel() in the reference firmware)
//
// Nibble values come straight from EPD_13in3e.h.

export const WIDTH = 1200;
export const HEIGHT = 1600;
export const ROW_BYTES = WIDTH / 2; // 600
export const FRAME_BYTES = ROW_BYTES * HEIGHT; // 960000

// nibble code -> approximate sRGB the panel actually shows.
// These RGBs are what we draw with on the canvas so quantization is exact.
export const PALETTE = [
  { name: "black", code: 0x0, rgb: [0, 0, 0] },
  { name: "white", code: 0x1, rgb: [255, 255, 255] },
  { name: "yellow", code: 0x2, rgb: [255, 233, 0] },
  { name: "red", code: 0x3, rgb: [200, 0, 0] },
  { name: "blue", code: 0x5, rgb: [0, 70, 200] },
  { name: "green", code: 0x6, rgb: [0, 130, 60] },
];

// Convenience CSS color strings used throughout the renderer.
export const C = {
  black: "rgb(0,0,0)",
  white: "rgb(255,255,255)",
  yellow: "rgb(255,233,0)",
  red: "rgb(200,0,0)",
  blue: "rgb(0,70,200)",
  green: "rgb(0,130,60)",
};

// Build a fast 32K-entry lookup (5 bits per channel) mapping RGB -> nibble.
// Hue (0..360) of an RGB — used to snap by HUE so an anti-aliased edge never maps
// to a wrong-hue ink (a dark-yellow edge -> yellow/black, never red/green).
function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (!c) return 0;
  let h;
  if (mx === r) h = ((g - b) / c + 6) % 6;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  return h * 60;
}
const INK = [ // the four coloured inks, with precomputed hue
  { code: 0x2, hue: hueOf(255, 233, 0) },
  { code: 0x3, hue: hueOf(200, 0, 0) },
  { code: 0x5, hue: hueOf(0, 70, 200) },
  { code: 0x6, hue: hueOf(0, 130, 60) },
];

const LUT = new Uint8Array(32 * 32 * 32);
(function buildLUT() {
  for (let r = 0; r < 32; r++) {
    for (let g = 0; g < 32; g++) {
      for (let b = 0; b < 32; b++) {
        const R = (r << 3) | (r >> 2);
        const G = (g << 3) | (g >> 2);
        const B = (b << 3) | (b >> 2);
        const lum = 0.299 * R + 0.587 * G + 0.114 * B;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        let best;
        // Greys (incl. anti-aliased text edges) -> black/white by brightness.
        if (mx - mn < 48) best = lum < 128 ? 0x0 : 0x1;
        // Very dark / very light saturated pixels are edge blends toward black/white.
        else if (lum < 45) best = 0x0;
        else if (lum > 222) best = 0x1;
        // Otherwise snap to the ink with the NEAREST HUE — this is what prevents the
        // "rainbow" fringe: a blended edge keeps its hue, so it can only become its
        // own ink, never a different-hue one.
        else {
          let bd = Infinity; best = 0x2;
          const H = hueOf(R, G, B);
          for (const ink of INK) { let d = Math.abs(H - ink.hue); if (d > 180) d = 360 - d; if (d < bd) { bd = d; best = ink.code; } }
        }
        LUT[(r << 10) | (g << 5) | b] = best;
      }
    }
  }
})();

export function nearestNibble(r, g, b) {
  return LUT[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
}

// nibble code -> palette rgb, for reconstructing a true on-screen preview.
const CODE_RGB = (() => {
  const m = {};
  for (const p of PALETTE) m[p.code] = p.rgb;
  return m;
})();

// Snap an RGBA buffer (canvas getImageData().data) in place to the exact 6 panel
// colours — the same hard quantization the device applies. Use this on the
// preview canvas so what you see equals what the e-paper actually shows (no
// anti-aliasing, no in-between greys). Operates on the buffer; caller putImageData.
export function snapRGBAToPanel(data) {
  for (let i = 0; i < data.length; i += 4) {
    const rgb = CODE_RGB[nearestNibble(data[i], data[i + 1], data[i + 2])];
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2];
  }
  return data;
}

// Pack an RGBA Uint8ClampedArray (canvas getImageData) into the panel framebuffer.
// `rotate` (0 or 180) flips the image to match the panel's mounting / cable side.
// The layout is fixed at 1200x1600, so only 0/180 make sense here; mounting it
// as landscape would need a separate landscape layout, not a pixel rotation.
// nibble code -> the PURE sRGB the device's Waveshare reader exact-matches
// (GUI_ReadBmp_RGB_6Color). Order is R,G,B; the BMP writer emits B,G,R.
const CODE_PURE = { 0x0: [0, 0, 0], 0x1: [255, 255, 255], 0x2: [255, 255, 0], 0x3: [255, 0, 0], 0x5: [0, 0, 255], 0x6: [0, 255, 0] };

// Encode the render as a 24-bit bottom-up BMP quantized to the six panel colours.
// `panel=false` writes the PURE code RGBs the legacy v4 device exact-matches;
// `panel=true` writes the actual (muted) panel RGBs — a real, viewable image that
// looks like the glass, which v5+ devices exact-match. Orientation is set so the
// device's reader (BMP row y -> panel row H-1-y) shows it upright.
export function packBMP6Color(rgba, rotate = 0, panel = false) {
  const COLORS = panel ? CODE_RGB : CODE_PURE;
  const rowbytes = WIDTH * 3;                 // 3600 — multiple of 4, no padding
  const pix = rowbytes * HEIGHT;
  const off = 54;
  const buf = Buffer.alloc(off + pix);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(off + pix, 2);            // file size
  buf.writeUInt32LE(off, 10);                 // pixel-data offset
  buf.writeUInt32LE(40, 14);                  // info header size
  buf.writeInt32LE(WIDTH, 18);
  buf.writeInt32LE(HEIGHT, 22);
  buf.writeUInt16LE(1, 26);                   // planes
  buf.writeUInt16LE(24, 28);                  // bpp
  const flip = rotate === 180;
  for (let y = 0; y < HEIGHT; y++) {
    const dst = off + y * rowbytes;
    for (let x = 0; x < WIDTH; x++) {
      const sx = flip ? WIDTH - 1 - x : x;
      const sy = flip ? y : HEIGHT - 1 - y;
      const si = (sy * WIDTH + sx) * 4;
      const rgb = COLORS[nearestNibble(rgba[si], rgba[si + 1], rgba[si + 2])];
      const di = dst + x * 3;
      buf[di] = rgb[2]; buf[di + 1] = rgb[1]; buf[di + 2] = rgb[0]; // BGR
    }
  }
  return buf;
}

// Encode the render as a plain 24-bit BMP with the REAL pixel colours — no
// quantization, no snapping. This is the actual smooth image (real anti-aliased
// fonts); the DEVICE reduces it to the 6 panel inks itself. Bottom-up so the
// device reader (BMP row y -> panel row H-1-y) shows it upright.
export function rgbaToBMP24(rgba, rotate = 0) {
  const rowbytes = WIDTH * 3;
  const pix = rowbytes * HEIGHT;
  const off = 54;
  const buf = Buffer.alloc(off + pix);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(off + pix, 2);
  buf.writeUInt32LE(off, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(WIDTH, 18);
  buf.writeInt32LE(HEIGHT, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  const flip = rotate === 180;
  for (let y = 0; y < HEIGHT; y++) {
    const dst = off + y * rowbytes;
    for (let x = 0; x < WIDTH; x++) {
      const sx = flip ? WIDTH - 1 - x : x;
      const sy = flip ? y : HEIGHT - 1 - y;
      const si = (sy * WIDTH + sx) * 4;
      const di = dst + x * 3;
      buf[di] = rgba[si + 2]; buf[di + 1] = rgba[si + 1]; buf[di + 2] = rgba[si]; // BGR
    }
  }
  return buf;
}

export function packFramebuffer(rgba, rotate = 0) {
  const out = Buffer.alloc(FRAME_BYTES, 0x11); // default all-white
  const flip = rotate === 180;
  // sample(x,y) -> nibble at source pixel (with optional 180° remap)
  const sample = (x, y) => {
    const sx = flip ? WIDTH - 1 - x : x;
    const sy = flip ? HEIGHT - 1 - y : y;
    const i = (sy * WIDTH + sx) * 4;
    return nearestNibble(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  for (let y = 0; y < HEIGHT; y++) {
    const rowOff = y * ROW_BYTES;
    for (let x = 0; x < WIDTH; x += 2) {
      out[rowOff + (x >> 1)] = (sample(x, y) << 4) | sample(x + 1, y);
    }
  }
  return out;
}

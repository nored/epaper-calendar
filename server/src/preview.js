// Render once to data/preview.png + data/frame.bin for local inspection.
//   node src/preview.js [YYYY-MM-DD]

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildModel } from "./data.js";
import { renderCalendar } from "./render.js";
import { packFramebuffer, snapRGBAToPanel, FRAME_BYTES } from "./palette.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "data");

const arg = process.argv[2];
const now = arg ? new Date(arg + "T12:00:00") : new Date();

const cfg = loadConfig();
console.time("model");
const model = await buildModel(cfg, now);
console.timeEnd("model");

console.time("render");
// CLI preview: no device data faked (no battery, no update stamp).
const canvas = await renderCalendar(model, cfg, {
  controlUrl: "http://epaper-cal.local/",
});
console.timeEnd("render");

const ctx = canvas.getContext("2d");
const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
console.time("pack");
const fb = packFramebuffer(id.data);
console.timeEnd("pack");
writeFileSync(join(out, "frame.bin"), fb);

// True preview: snap the canvas to the exact 6 panel colours (no anti-aliasing),
// so preview.png is pixel-for-pixel what the e-paper screen shows.
snapRGBAToPanel(id.data);
ctx.putImageData(id, 0, 0);
const png = await canvas.encode("png");
writeFileSync(join(out, "preview.png"), png);

console.log(`preview.png (${png.length} bytes), frame.bin (${fb.length} bytes, expected ${FRAME_BYTES})`);

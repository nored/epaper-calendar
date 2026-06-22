// Configuration load/save. Persisted to data/config.json (gitignored).
// Everything the web UI edits lives here.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const CONFIG_PATH = join(DATA_DIR, "config.json");

export const DEFAULT_CONFIG = {
  // Locale / region
  country: "DE",
  // One or more Bundesländer for public holidays (union shown). School holidays
  // use the first. e.g. ["BB"] or ["BB","BE"] for two workplaces.
  states: ["BB"],
  timezone: "Europe/Berlin",

  // Mark Saturdays red (e.g. if nobody works Saturdays). Sundays are always red.
  freeSaturday: false,

  // How many days ahead the "Demnächst" list covers.
  upcomingDays: 7,

  // Grey shade behind the INACTIVE months (0 = white/off, ~0.3 = strong grey).
  // It's a black/white dither (the panel has no true grey).
  inactiveMonthShade: 0.12,

  // Grey shade of the weather-icon circle badges (0 = white, ~0.6 = dark grey).
  weatherCircleShade: 0.12,

  // Also show public holidays of OTHER Bundesländer (black & white, labelled with
  // the state) — e.g. for states you work with. Off = only your selected states.
  showOtherStateHolidays: false,

  // URL of this control panel, encoded into the on-screen QR code.
  // Leave empty to auto-fill from the request host.
  controlUrl: "",

  // Panel mounting: 0 = cable at bottom (native), 180 = cable at top (flipped).
  rotate: 0,

  // Up to 3 locations for the 3-day weather forecast. Each is either
  // { name } (auto-geocoded) or { name, lat, lon }.
  locations: [{ name: "Jüterbog", lat: 51.996, lon: 13.08 }],

  // Up to 3 daily horoscopes shown as columns below the weather. Each entry:
  // { sign } (zodiac key) and an optional { label } (e.g. a person's name).
  // Nothing hardcoded — configured in the control panel; empty = none shown.
  // Valid signs: aries taurus gemini cancer leo virgo libra scorpio
  //              sagittarius capricorn aquarius pisces
  horoscopes: [],

  // ICS feeds — fully generic & config-driven. Each feed maps its events to a
  // display color, a marker shape and a legend label, with no code special-casing.
  //
  // Per feed:
  //   name        display name + default legend label
  //   url         ICS URL (webcal:// or https://)
  //   enabled     include this feed
  //   color       default palette color: black|red|blue|green|yellow
  //   marker      "dot" | "square" | "bar" — how its events appear in day cells
  //   upcoming    include this feed's events in the "Demnächst" list
  //   showInLegend  show in the header legend (default true)
  //   rules       optional, for feeds whose ICS mixes categories (e.g. waste).
  //               Each rule: { match, color, label, marker? }. `match` is a
  //               case-insensitive substring of the event title; the first
  //               matching rule wins. marker falls back to feed.marker.
  // No feeds are baked in — they are user data, configured in the web UI and
  // stored in data/config.json. Empty by default (a fresh install shows none).
  feeds: [],

  // Feature toggles for the render.
  show: {
    nameDays: true,
    moon: true,
    schoolHolidays: true,
    weekNumbers: true,
    quote: true,
    weather: true,
    horoscope: true,
  },

  // Rotating quotes ("Spruch des Tages"). Empty by default — no filler text.
  // Add your own in the control panel; one is picked per day if non-empty.
  quotes: [],

  // Sleep scheduling the device honors via the X-Sleep-Seconds response header.
  sleep: {
    wakeHour: 0, // refresh at midnight (fixed; not user-configurable)
    minSeconds: 3600, // never sleep less than this
    lowBatteryVolts: 3.5, // below this, back off updates
    lowBatterySeconds: 172800, // 48h between updates when battery is low
  },
};

let cache = null;

function deepMerge(base, over) {
  if (Array.isArray(over)) return over;
  if (over && typeof over === "object" && base && typeof base === "object" && !Array.isArray(base)) {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

export function loadConfig(force = false) {
  if (cache && !force) return cache;
  if (existsSync(CONFIG_PATH)) {
    try {
      const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      cache = deepMerge(DEFAULT_CONFIG, user);
    } catch (e) {
      console.error("config.json parse error, using defaults:", e.message);
      cache = structuredClone(DEFAULT_CONFIG);
    }
  } else {
    cache = structuredClone(DEFAULT_CONFIG);
  }
  return cache;
}

export function saveConfig(cfg) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  cache = deepMerge(DEFAULT_CONFIG, cfg);
  writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2));
  return cache;
}

export { CONFIG_PATH };

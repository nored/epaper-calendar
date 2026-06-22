// Daily horoscopes from the free horoscope-app-api (no API key). One request per
// sign, disk-cached for the day (and falling back to the last good copy offline).
// Nothing hardcoded — the signs come from config (data/config.json). The horoscope
// TEXT from this API is English; the sign NAME is shown in German.

import { getJSON } from "./cache.js";

const SIGNS = new Set([
  "aries", "taurus", "gemini", "cancer", "leo", "virgo",
  "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces",
]);

export const SIGN_DE = {
  aries: "Widder", taurus: "Stier", gemini: "Zwillinge", cancer: "Krebs",
  leo: "Löwe", virgo: "Jungfrau", libra: "Waage", scorpio: "Skorpion",
  sagittarius: "Schütze", capricorn: "Steinbock", aquarius: "Wassermann", pisces: "Fische",
};

async function fetchOne(sign) {
  const url = `https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily?sign=${sign}&day=TODAY`;
  const d = await getJSON(`horoscope-${sign}`, url, { maxAgeMs: 12 * 3600 * 1000 });
  const text = d?.data?.horoscope;
  return text ? String(text).trim() : null;
}

// entries: [{ sign, label? }]. Returns [{ sign, signName, label, text }] (max 3).
export async function loadHoroscopes(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  for (const e of list.slice(0, 3)) {
    const sign = String(e?.sign || "").toLowerCase();
    if (!SIGNS.has(sign)) continue;
    const text = await fetchOne(sign);
    if (!text) continue;
    out.push({ sign, signName: SIGN_DE[sign] || sign, label: e?.label || "", text });
  }
  return out;
}

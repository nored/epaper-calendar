// Name days (Namenstag) from the Abalin nameday API (https://nameday.abalin.net).
//
//   GET /api/V2/date?day=DD&month=MM  -> { data: { de: "Alban, Alois, ...", ... } }
//
// Name-day-to-date mapping is fixed reference data, so we cache aggressively
// (30 days). Fetched live per date — nothing hardcoded.

import { getJSON } from "./cache.js";

function parseNames(data, country) {
  const str = data?.data?.[country];
  if (!str || typeof str !== "string" || str === "n/a") return [];
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

// Names for a specific Date. Returns array, e.g. ["Alban", "Alois"].
export async function nameDaysFor(date, country = "de") {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const url = `https://nameday.abalin.net/api/V2/date?day=${day}&month=${month}`;
  const data = await getJSON(`nameday-${country}-${month}-${day}`, url, {
    maxAgeMs: 30 * 24 * 3600 * 1000,
  });
  return parseNames(data, country);
}

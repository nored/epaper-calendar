// "Spruch des Tages" from the free ZenQuotes API (no key). One quote per day,
// disk-cached (and falling back to the last good copy offline). Nothing hardcoded
// — the user doesn't write quotes; this fetches them. Text is English.

import { getJSON } from "./cache.js";

export async function loadQuote() {
  const d = await getJSON("quote-today", "https://zenquotes.io/api/today", {
    maxAgeMs: 20 * 3600 * 1000, // once-a-day quote — cache most of the day
  });
  const q = Array.isArray(d) ? d[0] : null;
  if (!q || !q.q) return null;
  return { text: String(q.q).trim(), author: q.a ? String(q.a).trim() : "" };
}

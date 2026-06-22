// 3-day weather from Open-Meteo (free, no API key) for up to 3 locations.
// Locations may be given as { name } (auto-geocoded) or { name, lat, lon }.
// All requests disk-cached.

import { getJSON } from "./cache.js";

// Maps WMO code (+ max temp / max wind) to an icon type & German label. Beyond
// the basic conditions it also flags extreme heat, heat, wind and severe storms
// so the fuller icon set gets used.
function classify(code, tmax, wind) {
  if (code === 96 || code === 99) return { type: "tornado", label: "Unwetter" };
  if (code >= 95) return { type: "thunder", label: "Gewitter" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { type: "snow", label: "Schnee" };
  if (code >= 80 && code <= 82) return { type: "rain", label: "Schauer" };
  if (code >= 61 && code <= 67) return { type: "rain", label: "Regen" };
  if (code >= 51 && code <= 57) return { type: "rain", label: "Niesel" };
  if (code === 45 || code === 48) return { type: "fog", label: "Nebel" };
  if (code === 3) return { type: "overcast", label: "Bedeckt" };
  if (code === 2) return { type: "cloudy", label: "Wolkig" };
  // mostly clear (0,1): show heat / wind flavour when notable
  if (tmax != null && tmax >= 34) return { type: "scorching", label: "Sehr heiß" };
  if (tmax != null && tmax >= 30) return { type: "hot", label: "Heiß" };
  if (wind != null && wind >= 45) return { type: "windy", label: "Windig" };
  if (code === 1) return { type: "partly", label: "Heiter" };
  return { type: "sunny", label: "Klar" };
}

async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=de`;
  const d = await getJSON(`geo-${name}`, url, { maxAgeMs: 30 * 24 * 3600 * 1000 });
  const r = d?.results?.[0];
  return r ? { lat: r.latitude, lon: r.longitude, name: r.name } : null;
}

async function forecastFor(loc) {
  let { lat, lon, name } = loc;
  if (lat == null || lon == null) {
    if (!loc.name) return null;
    const g = await geocode(loc.name);
    if (!g) return null;
    lat = g.lat; lon = g.lon; name = loc.name || g.name;
  }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&timezone=auto&forecast_days=3`;
  const data = await getJSON(`weather-${lat}-${lon}`, url, { maxAgeMs: 6 * 3600 * 1000 });
  const d = data?.daily;
  if (!d?.time) return null;
  const days = d.time.map((date, i) => ({
    date,
    ...classify(d.weather_code[i], d.temperature_2m_max[i], d.wind_speed_10m_max?.[i]),
    tmax: Math.round(d.temperature_2m_max[i]),
    tmin: Math.round(d.temperature_2m_min[i]),
    pop: d.precipitation_probability_max?.[i] ?? null,
  }));
  return { name: name || "", days };
}

// Returns [{ name, days:[...] }, ...] for up to 3 locations.
export async function loadWeather(locations) {
  const list = Array.isArray(locations) ? locations : locations ? [locations] : [];
  const out = [];
  for (const loc of list.slice(0, 3)) {
    const w = await forecastFor(loc);
    if (w) out.push(w);
  }
  return out;
}

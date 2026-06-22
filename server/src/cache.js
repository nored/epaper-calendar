// Tiny JSON-over-HTTP fetcher with a persistent disk cache.
//
// Why disk-persistent: this is a wall calendar that must keep working. If an
// upstream API is down (or the house is offline) on refresh day, we serve the
// last good response instead of breaking the display. Successful fetches
// refresh the cache; failures fall back to whatever we cached last.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "data", "cache");

function pathFor(key) {
  const safe = key.replace(/[^a-z0-9._-]/gi, "_");
  return join(CACHE_DIR, `${safe}.json`);
}

function readCache(key) {
  const p = pathFor(key);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(pathFor(key), JSON.stringify({ ts: Date.now(), data }));
}

// Fetch JSON with caching. `maxAgeMs` controls when we consider the cache fresh
// enough to skip the network entirely. On any network/parse error we return the
// last cached value (regardless of age) so the calendar still renders.
export async function getJSON(key, url, { maxAgeMs = 12 * 3600 * 1000, headers } = {}) {
  const cached = readCache(key);
  if (cached && Date.now() - cached.ts < maxAgeMs) return cached.data;

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data = await res.json();
    writeCache(key, data);
    return data;
  } catch (e) {
    if (cached) {
      console.warn(`[cache] ${key}: fetch failed (${e.message}), using cached copy`);
      return cached.data;
    }
    console.error(`[cache] ${key}: fetch failed and no cache (${e.message})`);
    return null;
  }
}

// Like getJSON but returns raw text (for ICS feeds).
export async function getText(key, url, { maxAgeMs = 12 * 3600 * 1000, headers } = {}) {
  const cached = readCache(key);
  if (cached && Date.now() - cached.ts < maxAgeMs) return cached.data;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data = await res.text();
    writeCache(key, data);
    return data;
  } catch (e) {
    if (cached) {
      console.warn(`[cache] ${key}: fetch failed (${e.message}), using cached copy`);
      return cached.data;
    }
    console.error(`[cache] ${key}: fetch failed and no cache (${e.message})`);
    return null;
  }
}

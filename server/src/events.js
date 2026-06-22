// ICS feed ingestion. Fully generic: each feed maps its events to a display
// color, marker shape and label purely from config (no per-category code).
// Recurring events are expanded across the visible window. Feeds are disk-cached
// (see cache.js) so an offline refresh day still renders.

import ical from "node-ical";
import { getText } from "./cache.js";
import { ymd } from "./datetime.js";

function localMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// node-ical returns properties with parameters (e.g. SUMMARY;LANGUAGE=de) as
// { val, params } objects rather than plain strings — normalize to a string.
function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "val" in v) return String(v.val);
  return String(v);
}

// Resolve an event's display props (color, label, marker) from its feed.
// If the feed has rules, the first rule whose `match` is a case-insensitive
// substring of the title wins; otherwise the feed defaults apply.
function displayPropsFor(title, feed) {
  const t = (title || "").toLowerCase();
  if (Array.isArray(feed.rules)) {
    for (const r of feed.rules) {
      if (r && r.match && t.includes(String(r.match).toLowerCase())) {
        return {
          color: r.color || feed.color || "blue",
          label: r.label || feed.name,
          marker: r.marker || feed.marker || "dot",
        };
      }
    }
  }
  return {
    color: feed.color || "blue",
    label: feed.name,
    marker: feed.marker || "dot",
  };
}

// Parse one feed's ICS text into normalized occurrences within [from, to].
function expandFeed(text, feed, from, to) {
  const out = [];
  let parsed;
  try {
    parsed = ical.sync.parseICS(text);
  } catch (e) {
    console.warn(`[events] ${feed.name}: parse failed (${e.message})`);
    return out;
  }

  const push = (when, rawTitle, allDay) => {
    if (!when) return;
    const title = asText(rawTitle).trim();
    const day = localMidnight(when);
    if (day < from || day > to) return;
    const props = displayPropsFor(title, feed);
    out.push({
      date: ymd(day),
      title,
      color: props.color,
      label: props.label,
      marker: props.marker,
      feedName: feed.name,
      upcoming: feed.upcoming === true,
    });
  };

  for (const k of Object.keys(parsed)) {
    const ev = parsed[k];
    if (!ev || ev.type !== "VEVENT") continue;
    const allDay = ev.datetype === "date";

    if (ev.rrule) {
      // Recurring: expand occurrences in-window (pad a day for tz edges).
      const occ = ev.rrule.between(new Date(from.getTime() - 86400000), new Date(to.getTime() + 86400000), true);
      const exdates = Object.keys(ev.exdate || {}).map((d) => new Date(d).toDateString());
      for (const o of occ) {
        if (exdates.includes(o.toDateString())) continue;
        // Apply per-occurrence overrides if present.
        const ovr = ev.recurrences && ev.recurrences[ymd(o)];
        if (ovr) push(ovr.start, ovr.summary, ovr.datetype === "date");
        else push(o, ev.summary, allDay);
      }
    } else if (ev.start) {
      push(ev.start, ev.summary, allDay);
    }
  }
  return out;
}

// Load all enabled feeds and return a flat, de-duplicated, sorted occurrence list.
export async function loadEvents(feeds, from, to) {
  const all = [];
  for (const feed of feeds || []) {
    if (feed.enabled === false || !feed.url) continue;
    // webcal:// (iCloud/Google subscriptions) is plain HTTPS for fetching.
    const url = feed.url.replace(/^webcal:\/\//i, "https://");
    const text = await getText(`feed-${feed.name}`, url);
    if (!text) continue;
    all.push(...expandFeed(text, feed, from, to));
  }
  // de-dup identical (date,feed,title)
  const seen = new Set();
  const dedup = [];
  for (const e of all) {
    const key = `${e.date}|${e.feedName}|${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(e);
  }
  dedup.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return dedup;
}

// Discover the distinct event titles in a feed, so the UI can let the user map
// each one (pick a color) instead of guessing keywords. Returns sorted titles.
export async function feedTitles(url, name) {
  if (!url) return [];
  const fetchUrl = url.replace(/^webcal:\/\//i, "https://");
  const text = await getText(`feed-${name || fetchUrl}`, fetchUrl, { maxAgeMs: 3600 * 1000 });
  if (!text) return [];
  let parsed;
  try { parsed = ical.sync.parseICS(text); } catch { return []; }
  const set = new Set();
  for (const k of Object.keys(parsed)) {
    const ev = parsed[k];
    if (!ev || ev.type !== "VEVENT") continue;
    const t = asText(ev.summary).trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "de"));
}

// Assembles the complete view model the renderer draws: three month grids with
// per-day metadata, plus the "Heute" / upcoming info panel. All data is live
// (OpenHolidays + Abalin + ICS feeds) and disk-cached.

import { monthGrid, addMonths, ymd, startOfDay, addDays, isoWeek, dayOfYear, daysLeftInYear, DOW_DE, MONTHS } from "./datetime.js";
import { loadHolidays } from "./holidays.js";
import { loadEvents } from "./events.js";
import { nameDaysFor } from "./namedays.js";
import { moonPhase, principalPhaseOn } from "./astro.js";
import { loadWeather } from "./weather.js";
import { loadHoroscopes } from "./horoscope.js";
import { loadQuote } from "./quotes.js";

export async function buildModel(cfg, now = new Date()) {
  const today = startOfDay(now);

  // Three months: previous, current, next (like the Bosch wall calendar).
  const months = [-1, 0, 1].map((off) => {
    const d = addMonths(today, off);
    return { year: d.getFullYear(), month: d.getMonth(), weeks: monthGrid(d.getFullYear(), d.getMonth()), current: off === 0 };
  });

  // Visible date range across all grids.
  let rangeStart = months[0].weeks[0][0];
  let rangeEnd = months[2].weeks[5][6];

  // Holidays for every year the grids touch.
  const years = new Set();
  for (const m of months) for (const w of m.weeks) for (const d of w) years.add(d.getFullYear());
  const states = cfg.states || (cfg.state ? [cfg.state] : ["BB"]);
  const { pub, otherPub, school } = await loadHolidays([...years], cfg.country, states, cfg.showOtherStateHolidays === true);

  // Events. Grid markers only need the visible range, but the "Demnächst" panel
  // looks further ahead, so fetch a wider window.
  const events = await loadEvents(cfg.feeds, rangeStart, addDays(rangeEnd, 150));
  const byDay = new Map(); // "YYYY-MM-DD" -> array of that day's events (all feeds)
  for (const e of events) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }

  // Per-day decoration lookup used by the grid renderer.
  const dayInfo = (d) => {
    const key = ymd(d);
    return {
      key,
      publicHoliday: pub.get(key) || null,
      otherHoliday: otherPub.get(key) || null,
      schoolHoliday: school.get(key) || null,
      events: byDay.get(key) || [],
      moon: cfg.show?.moon ? principalPhaseOn(d) : null,
      isToday: key === ymd(today),
      isSunday: d.getDay() === 0,
      isSaturday: d.getDay() === 6,
    };
  };

  // ---- Info panel ("Heute" + upcoming) ----
  const todayKey = ymd(today);
  const nameDays = cfg.show?.nameDays ? await nameDaysFor(today, (cfg.country || "DE").toLowerCase()) : [];

  // Upcoming events (feeds flagged upcoming, today onward), sorted, first ~6.
  // Upcoming events within the configured horizon (default 7 days), soonest
  // first. The 2-column renderer fills the height and shows "+N weitere".
  const upCut = ymd(addDays(today, cfg.upcomingDays ?? 7));
  const upcoming = events
    .filter((e) => e.upcoming === true && e.date >= todayKey && e.date <= upCut)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(0, 40);

  // Quote of the day: an optional user-supplied list overrides; otherwise it's
  // fetched automatically from a free API (the user never has to write quotes).
  let quote = null;
  if (cfg.show?.quote !== false) {
    quote = cfg.quotes?.length
      ? { text: cfg.quotes[dayOfYear(today) % cfg.quotes.length], author: "" }
      : await loadQuote();
  }

  const weather = cfg.show?.weather !== false ? await loadWeather(cfg.locations || cfg.location) : [];

  const horoscopes = cfg.show?.horoscope !== false ? await loadHoroscopes(cfg.horoscopes) : [];

  // Legend, built generically from the feed config (not from fetched events) so
  // it is fully predictable and code-free: one entry per rule, or one per feed.
  const legend = [];
  for (const feed of cfg.feeds || []) {
    if (feed.enabled === false) continue;
    if (feed.showInLegend === false) continue;
    if (Array.isArray(feed.rules) && feed.rules.length) {
      for (const r of feed.rules) {
        legend.push({
          label: r.label || feed.name,
          color: r.color || feed.color || "blue",
          marker: r.marker || feed.marker || "dot",
        });
      }
    } else {
      legend.push({
        label: feed.name,
        color: feed.color || "blue",
        marker: feed.marker || "dot",
      });
    }
  }

  const info = {
    today,
    weekdayName: DOW_DE[today.getDay()],
    monthName: MONTHS[today.getMonth()][0],
    isoWeek: isoWeek(today),
    dayOfYear: dayOfYear(today),
    daysLeft: daysLeftInYear(today),
    publicHoliday: pub.get(todayKey) || null,
    schoolHoliday: school.get(todayKey) || null,
    nameDays,
    moon: moonPhase(today),
    upcoming,
    quote,
    weather,
    horoscopes,
    legend,
  };

  return { today, months, dayInfo, info, generatedAt: now };
}

// Friendly relative label for the upcoming list ("Heute", "Morgen", "Mo 6.7.").
export function relLabel(dateKey, today, dowShort) {
  const d = new Date(dateKey + "T00:00:00");
  const diff = Math.round((startOfDay(d) - startOfDay(today)) / 86400000);
  if (diff === 0) return "Heute";
  if (diff === 1) return "Morgen";
  if (diff > 1 && diff < 7) return dowShort[d.getDay()];
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

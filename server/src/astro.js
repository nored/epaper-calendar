// Moon phase computation (no external API). Good to within a few hours, which
// is plenty for a daily wall calendar showing a phase glyph.

const SYNODIC = 29.530588853; // days per lunation
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14) / 86400000; // 2000-01-06 18:14 UTC in days

// Returns 0..1 fraction of the cycle (0 = new, 0.5 = full).
export function moonAge(date) {
  const days = date.getTime() / 86400000;
  let phase = ((days - KNOWN_NEW_MOON) % SYNODIC) / SYNODIC;
  if (phase < 0) phase += 1;
  return phase;
}

// Map to 8 named phases. We draw a glyph only for the 4 principal phases on a
// wall calendar (new / first quarter / full / last quarter), like print calendars.
export function moonPhase(date) {
  const p = moonAge(date);
  const idx = Math.round(p * 8) % 8;
  const names = [
    "Neumond",
    "Zunehmende Sichel",
    "Erstes Viertel",
    "Zunehmender Mond",
    "Vollmond",
    "Abnehmender Mond",
    "Letztes Viertel",
    "Abnehmende Sichel",
  ];
  return { fraction: p, index: idx, name: names[idx] };
}

// Is `date` (a midnight Date) the day a principal phase occurs?
// Returns 'new' | 'first' | 'full' | 'last' | null. Used to drop a glyph on the grid.
export function principalPhaseOn(date) {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const prevNoon = new Date(noon.getTime() - 86400000);
  const a0 = moonAge(prevNoon);
  const a1 = moonAge(noon);
  // crossings of 0, .25, .5, .75 within this day
  const crossed = (target) => {
    let x0 = a0, x1 = a1;
    if (target === 0) {
      // handle wrap near 1->0
      if (x1 < x0) x1 += 1;
      return (x0 <= 1 && x1 >= 1) || (x0 <= 0 && x1 >= 0);
    }
    return x0 < target && x1 >= target;
  };
  if (crossed(0)) return "new";
  if (crossed(0.25)) return "first";
  if (crossed(0.5)) return "full";
  if (crossed(0.75)) return "last";
  return null;
}

// Public + school holidays from the OpenHolidays API (https://openholidaysapi.org).
// Live data, fetched per calendar year and disk-cached. Nothing is hardcoded —
// holidays and school-break dates shift every year and come straight from the API.
//
// Public holidays:  GET /PublicHolidays?countryIsoCode=DE&subdivisionCode=DE-BB&validFrom=..&validTo=..
// School holidays:   GET /SchoolHolidays?countryIsoCode=DE&subdivisionCode=DE-BB&validFrom=..&validTo=..

import { getJSON } from "./cache.js";
import { ymd, addDays } from "./datetime.js";

const BASE = "https://openholidaysapi.org";

function pickName(nameArr, lang = "DE") {
  if (!Array.isArray(nameArr)) return "";
  return (nameArr.find((n) => n.language === lang) || nameArr[0] || {}).text || "";
}

// Returns Map "YYYY-MM-DD" -> { name, nationwide } for public holidays in a year.
export async function publicHolidays(year, country = "DE", state = "BB") {
  const sub = `${country}-${state}`;
  const url =
    `${BASE}/PublicHolidays?countryIsoCode=${country}&languageIsoCode=${country}` +
    `&validFrom=${year}-01-01&validTo=${year}-12-31&subdivisionCode=${sub}`;
  const data = (await getJSON(`pubhol-${sub}-${year}`, url)) || [];
  const map = new Map();
  for (const h of data) {
    // Public holidays are single days, but honor start/end just in case.
    let d = new Date(h.startDate + "T00:00:00");
    const end = new Date((h.endDate || h.startDate) + "T00:00:00");
    while (d <= end) {
      map.set(ymd(d), { name: pickName(h.name, country), nationwide: !!h.nationwide });
      d = addDays(d, 1);
    }
  }
  return map;
}

// Returns Map "YYYY-MM-DD" -> name for school-holiday days in a year (ranges expanded).
export async function schoolHolidays(year, country = "DE", state = "BB") {
  const sub = `${country}-${state}`;
  const url =
    `${BASE}/SchoolHolidays?countryIsoCode=${country}&languageIsoCode=${country}` +
    `&validFrom=${year}-01-01&validTo=${year}-12-31&subdivisionCode=${sub}`;
  const data = (await getJSON(`schoolhol-${sub}-${year}`, url)) || [];
  const map = new Map();
  for (const h of data) {
    let d = new Date(h.startDate + "T00:00:00");
    const end = new Date(h.endDate + "T00:00:00");
    while (d <= end) {
      map.set(ymd(d), pickName(h.name, country));
      d = addDays(d, 1);
    }
  }
  return map;
}

// Fetch everything needed to cover a set of years at once.
export const ALL_DE_STATES = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"];
const STATE_NAMES = {
  BW: "Baden-Württemberg", BY: "Bayern", BE: "Berlin", BB: "Brandenburg", HB: "Bremen",
  HH: "Hamburg", HE: "Hessen", MV: "Mecklenburg-Vorpommern", NI: "Niedersachsen",
  NW: "Nordrhein-Westfalen", RP: "Rheinland-Pfalz", SL: "Saarland", SN: "Sachsen",
  ST: "Sachsen-Anhalt", SH: "Schleswig-Holstein", TH: "Thüringen",
};

// `selected` = the user's own Bundesländer (their holidays render red). When
// `includeOther` is true, holidays that fall ONLY in *other* states are also
// returned (as `otherPub`) so they can be shown in black & white with the state
// name. School holidays come from the first selected state.
export async function loadHolidays(years, country = "DE", selected = ["BB"], includeOther = false) {
  const sel = (Array.isArray(selected) ? selected : [selected]).filter(Boolean);
  if (!sel.length) sel.push("BB");
  const fetchStates = includeOther ? ALL_DE_STATES : sel;

  const byDay = new Map(); // "YYYY-MM-DD" -> { name, states:Set }
  for (const y of years) {
    for (const st of fetchStates) {
      for (const [k, v] of await publicHolidays(y, country, st)) {
        if (!byDay.has(k)) byDay.set(k, { name: v.name, states: new Set() });
        byDay.get(k).states.add(st);
      }
    }
  }

  const pub = new Map();      // applies to a selected state -> red
  const otherPub = new Map(); // only in other states -> black & white, labelled
  for (const [k, v] of byDay) {
    const states = [...v.states];
    if (states.some((s) => sel.includes(s))) {
      pub.set(k, { name: v.name, states });
    } else if (includeOther) {
      otherPub.set(k, { name: v.name, stateNames: states.map((s) => STATE_NAMES[s] || s) });
    }
  }

  const school = new Map();
  for (const y of years) for (const [k, v] of await schoolHolidays(y, country, sel[0])) school.set(k, v);

  return { pub, otherPub, school };
}

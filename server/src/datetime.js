// Date helpers. All calendar math is done in local (server) time, which we
// assume is the same timezone the calendar hangs in (Europe/Berlin).

export const DOW_DE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
export const DOW_SHORT_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
// Multilingual month names (de / en / fr / es / it) like the Bosch calendar.
export const MONTHS = [
  ["Januar", "January", "Janvier", "Enero", "Gennaio"],
  ["Februar", "February", "Février", "Febrero", "Febbraio"],
  ["März", "March", "Mars", "Marzo", "Marzo"],
  ["April", "April", "Avril", "Abril", "Aprile"],
  ["Mai", "May", "Mai", "Mayo", "Maggio"],
  ["Juni", "June", "Juin", "Junio", "Giugno"],
  ["Juli", "July", "Juillet", "Julio", "Luglio"],
  ["August", "August", "Août", "Agosto", "Agosto"],
  ["September", "September", "Septembre", "Septiembre", "Settembre"],
  ["Oktober", "October", "Octobre", "Octubre", "Ottobre"],
  ["November", "November", "Novembre", "Noviembre", "Novembre"],
  ["Dezember", "December", "Décembre", "Diciembre", "Dicembre"],
];

export function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ISO 8601 week number (weeks start Monday, week 1 contains the first Thursday).
export function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
}

export function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((startOfDay(d) - start) / 86400000);
}

export function daysLeftInYear(d) {
  const end = new Date(d.getFullYear(), 11, 31);
  return Math.round((startOfDay(end) - startOfDay(d)) / 86400000);
}

// Build a month grid: 6 rows x 7 cols (Mon-first), each cell a Date.
// Cells outside the target month are included (for the grey "spill" days).
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // how many Mon-first leading days
  const startDate = addDays(first, -offset);
  const weeks = [];
  let cur = startDate;
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let dca = 0; dca < 7; dca++) {
      row.push(cur);
      cur = addDays(cur, 1);
    }
    weeks.push(row);
  }
  return weeks;
}

/**
 * EnergyAggregate — pure helpers that bucket the daily energy series into
 * day / week / month aggregates for the bar-chart modal.
 *
 * Input: daily series from EnergyTracker.getEnergyHistory() —
 *   [{ date: "YYYY-MM-DD", total: Wh, sparks: { sparkId: Wh } }]
 *
 * Output buckets (ascending by date):
 *   { date, label, value (total Wh), sparks: { sparkId: Wh } }
 *   - day:    one bucket per calendar day,   label "MM/DD"
 *   - week:   one bucket per ISO week (Monday start), label Monday "MM/DD"
 *   - month:  one bucket per calendar month, label month name "Aug"
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const r3 = (v) => Math.round(v * 1000) / 1000;

/** "YYYY-MM-DD" (local) → local Date at midnight. */
function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Date → "YYYY-MM-DD" (local). */
function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Monday (ISO week start) of the week containing d. */
function mondayOf(d) {
  const m = new Date(d);
  m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return m;
}

/** "YYYY-MM" key for a date's calendar month. */
function monthKeyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * Aggregate the daily series into buckets for one period.
 * @param {Array<{date:string,total:number,sparks:Record<string,number>}>} series
 * @param {"day"|"week"|"month"} period
 * @returns {Array<{date:string,label:string,value:number,sparks:Record<string,number>}>}
 */
export function aggregate(series, period) {
  const buckets = new Map();
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  for (const entry of sorted) {
    const d = parseDate(entry.date);
    let key;
    let date;
    let label;
    if (period === "day") {
      key = entry.date;
      date = entry.date;
      label = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    } else if (period === "week") {
      const mon = mondayOf(d);
      key = iso(mon);
      date = key;
      label = `${pad(mon.getMonth() + 1)}/${pad(mon.getDate())}`;
    } else {
      key = monthKeyOf(d);
      date = `${key}-01`;
      label = MONTHS[d.getMonth()];
    }
    let b = buckets.get(key);
    if (!b) {
      b = { date, label, value: 0, sparks: {} };
      buckets.set(key, b);
    }
    b.value += entry.total;
    for (const [id, wh] of Object.entries(entry.sparks)) {
      b.sparks[id] = r3((b.sparks[id] || 0) + wh);
    }
  }
  for (const b of buckets.values()) b.value = r3(b.value);
  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Build all three period buckets at once (ascending). */
export function buildBuckets(series) {
  return {
    day: aggregate(series, "day"),
    week: aggregate(series, "week"),
    month: aggregate(series, "month"),
  };
}

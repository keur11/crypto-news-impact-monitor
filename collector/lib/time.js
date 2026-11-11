// Časovni pripomočki. Vse vrednosti so v ms od epohe, UTC.

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

const INTERVALS = { '1h': HOUR, '1d': DAY };

export function intervalMs(interval) {
  const ms = INTERVALS[interval];
  if (!ms) throw new Error(`Nepodprt interval: ${interval}`);
  return ms;
}

export function parseIso(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Neveljaven datum/čas: ${value}`);
  return ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// Epoha je poravnana na polnoč UTC, zato deljenje deluje za ure in dneve.
export function floorTo(ms, stepMs) {
  return Math.floor(ms / stepMs) * stepMs;
}

export function startOfUtcDay(ms) {
  return floorTo(ms, DAY);
}

export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextMonthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// Koledarski meseci, ki se prekrivajo z intervalom [fromMs, toMs).
export function monthsBetween(fromMs, toMs) {
  const out = [];
  for (let s = monthStart(fromMs); s < toMs; s = nextMonthStart(s)) {
    out.push({ key: monthKey(s), start: s, end: nextMonthStart(s) });
  }
  return out;
}

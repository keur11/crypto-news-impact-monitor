// Bitstamp javni OHLC: /api/v2/ohlc/{pair}/?step=&limit=&start=&end= (časi v sekundah).
// Volumen je v bazni valuti; qv ocenimo kot volume × close.

import { intervalMs } from '../lib/time.js';

export function parseOhlc(rows) {
  return rows.map((r) => {
    const c = Number(r.close);
    const v = Number(r.volume);
    return {
      t: Number(r.timestamp) * 1000,
      o: Number(r.open),
      h: Number(r.high),
      l: Number(r.low),
      c,
      v,
      qv: v * c,
    };
  });
}

export async function fetchRange(http, cfg, { pair, interval }, startMs, endMs) {
  const p = cfg.providers.bitstamp;
  const stepMs = intervalMs(interval);
  const stepS = stepMs / 1000;
  const candles = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url =
      `${p.baseUrl}${p.ohlcPath.replace('{pair}', encodeURIComponent(pair))}` +
      `?step=${stepS}&limit=${p.maxLimit}&start=${Math.floor(cursor / 1000)}&end=${Math.floor((endMs - 1) / 1000)}`;
    const { status, data } = await http.request('bitstamp', url, { passStatuses: [404] });
    if (status === 404) return { status: 'not_found', candles: [] };
    const rows = data?.data?.ohlc;
    if (!Array.isArray(rows) || rows.length === 0) break;
    const batch = parseOhlc(rows).filter((k) => k.t >= cursor && k.t < endMs);
    if (batch.length === 0) break;
    candles.push(...batch);
    const next = batch[batch.length - 1].t + stepMs;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < p.maxLimit) break;
  }
  return { status: 'ok', candles };
}

// Binance: javni API (data-api.binance.vision) in mesečni arhivi (data.binance.vision).
// Vse funkcije vrnejo { status: 'ok' | 'not_found', candles }.

import { createHash } from 'node:crypto';
import { intervalMs } from '../lib/time.js';
import { extractSingleFile } from '../lib/zip.js';

// Arhivi spot od 2025-01-01 uporabljajo mikrosekunde, prej milisekunde.
export function normalizeTimestamp(ts) {
  const n = Number(ts);
  return n > 1e14 ? Math.floor(n / 1000) : n;
}

// Vrstica: [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
export function parseKlineRow(row) {
  return {
    t: normalizeTimestamp(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[5]),
    qv: Number(row[7]),
  };
}

export function parseKlineCsv(text) {
  const candles = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    if (!/^\d+$/.test(cols[0].trim())) continue; // glava, če obstaja
    candles.push(parseKlineRow(cols));
  }
  return candles;
}

export async function fetchApiRange(http, cfg, { symbol, interval }, startMs, endMs) {
  const p = cfg.providers.binanceApi;
  const step = intervalMs(interval);
  const candles = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url =
      `${p.baseUrl}${p.klinesPath}?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs - 1}&limit=${p.maxLimit}`;
    const { status, data } = await http.request('binanceApi', url, { passStatuses: [400] });
    if (status === 400) {
      // -1121 = neveljaven simbol
      if (data?.code === -1121) return { status: 'not_found', candles: [] };
      throw new Error(`Binance API 400: ${JSON.stringify(data)}`);
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) candles.push(parseKlineRow(row));
    const next = candles[candles.length - 1].t + step;
    if (next <= cursor) break;
    cursor = next;
    if (data.length < p.maxLimit) break;
  }
  return { status: 'ok', candles };
}

export function archiveUrl(cfg, { symbol, interval }, monthKey) {
  const p = cfg.providers.binanceArchive;
  const [yyyy, mm] = monthKey.split('-');
  return (
    p.baseUrl +
    p.pathTemplate
      .replaceAll('{symbol}', symbol)
      .replaceAll('{interval}', interval)
      .replaceAll('{yyyy}', yyyy)
      .replaceAll('{mm}', mm)
  );
}

export async function fetchArchiveMonth(http, cfg, source, monthKey) {
  const url = archiveUrl(cfg, source, monthKey);
  const zip = await http.request('binanceArchive', url, { as: 'buffer', passStatuses: [404] });
  if (zip.status === 404) return { status: 'not_found', candles: [] };

  if (cfg.providers.binanceArchive.verifyChecksum) {
    const sum = await http.request('binanceArchive', `${url}.CHECKSUM`, { as: 'text', passStatuses: [404] });
    if (sum.status === 404) throw new Error(`Binance arhiv: ni datoteke CHECKSUM za ${url}`);
    const expected = sum.data.trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash('sha256').update(zip.data).digest('hex');
    if (expected !== actual) throw new Error(`Binance arhiv: neujemanje SHA-256 za ${url}`);
  }
  const { data } = extractSingleFile(zip.data);
  return { status: 'ok', candles: parseKlineCsv(data.toString('utf8')) };
}

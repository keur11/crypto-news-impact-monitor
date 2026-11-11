// Celoten tek backfilla nad simuliranim omrežjem (Binance API, arhiv, Bitstamp).
// Preveri razreševanje virov, izpuščanje sredstev, stablecoine, kriterij LUNC in determinizem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHttpClient } from '../collector/lib/http.js';
import { createPriceStore } from '../collector/prices.js';
import { runBackfill, writeOutputs, formatTable } from '../scripts/backfill-library.js';
import { DAY, HOUR, monthStart, nextMonthStart, parseIso } from '../collector/lib/time.js';
import { buildZip, loadConfig, loadLibrary } from './helpers.js';

// --- deterministični generator cen ---
function noise(key, t) {
  const h = createHash('sha1').update(`${key}|${t}`).digest();
  return (h.readUInt32LE(0) / 2 ** 32) * 2 - 1;
}
const SPEC = {
  BTCUSDT: { p0: 30000, amp: 0.004 },
  ETHUSDT: { p0: 2000, amp: 0.006 },
  BNBUSDT: { p0: 300, amp: 0.006, shock: { t0: '2019-05-07T23:00:00Z', per: -0.01, n: 12 } },
  FTTUSDT: { p0: 25, amp: 0.006, shock: { t0: '2022-11-08T16:00:00Z', per: -0.08, n: 24 } },
  LUNAUSDT: { p0: 80, amp: 0.008, shock: { t0: '2022-05-09T00:00:00Z', per: -0.15, n: 72 } },
  USTBUSD: { p0: 1, amp: 0.0002, shock: { t0: '2022-05-09T00:00:00Z', per: -0.01, n: 30 } },
  LUNCUSDT: { p0: 0.0001, amp: 0.01 },
  'btcusd-1d': { p0: 800, amp: 0.02, shock: { t0: '2014-02-24T00:00:00Z', per: -0.1, n: 2, step: DAY } },
};
function close(key, t) {
  const s = SPEC[key];
  let level = s.amp * noise(key, t);
  if (s.shock) {
    const step = s.shock.step ?? HOUR;
    const k = Math.floor((t - parseIso(s.shock.t0)) / step) + 1;
    level += s.shock.per * Math.min(Math.max(k, 0), s.shock.n);
  }
  return s.p0 * Math.exp(level);
}
function candleRow(key, t, step) {
  const c = close(key, t);
  const o = close(key, t - step);
  const inShock = SPEC[key].shock && t >= parseIso(SPEC[key].shock.t0) && t < parseIso(SPEC[key].shock.t0) + DAY;
  const qv = inShock ? 3e6 : 1e6;
  return [t, o, Math.max(o, c), Math.min(o, c), c, qv / c, t + step - 1, qv];
}

const API_FROM = { BTCUSDT: '2017-08-17', ETHUSDT: '2017-08-17', BNBUSDT: '2017-11-06', LUNCUSDT: '2022-05-30T09:30:00Z' };
const ARCHIVE = { FTTUSDT: [null, null], LUNAUSDT: ['2019-01-01', '2022-05-13T00:00:00Z'], USTBUSD: ['2021-01-01', '2022-05-13T00:00:00Z'] };

function response(status, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    ok: status < 300,
    headers: { get: () => null },
    text: async () => buf.toString(),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}

const zipCache = new Map();
function fakeFetch(urlStr) {
  const u = new URL(urlStr);
  if (u.hostname === 'data-api.binance.vision') {
    const symbol = u.searchParams.get('symbol');
    if (!API_FROM[symbol]) return response(400, { code: -1121, msg: 'Invalid symbol.' });
    const from = Math.max(Number(u.searchParams.get('startTime')), parseIso(API_FROM[symbol]));
    const to = Number(u.searchParams.get('endTime'));
    const rows = [];
    for (let t = Math.ceil(from / HOUR) * HOUR; t <= to && rows.length < 1000; t += HOUR) rows.push(candleRow(symbol, t, HOUR));
    return response(200, rows);
  }
  if (u.hostname === 'data.binance.vision') {
    const m = u.pathname.match(/klines\/(\w+)\/1h\/\w+-1h-(\d{4})-(\d{2})\.zip(\.CHECKSUM)?$/);
    if (!m || !ARCHIVE[m[1]]) return response(404, 'Not Found');
    const [, symbol, yyyy, mm, isSum] = m;
    const key = `${symbol}-${yyyy}-${mm}`;
    if (!zipCache.has(key)) {
      const ms = Date.UTC(Number(yyyy), Number(mm) - 1, 1);
      const [a, b] = ARCHIVE[symbol];
      const lo = Math.max(ms, a ? parseIso(a) : -Infinity);
      const hi = Math.min(nextMonthStart(ms), b ? parseIso(b) : Infinity);
      const lines = [];
      for (let t = lo; t < hi; t += HOUR) lines.push(candleRow(symbol, t, HOUR).join(','));
      const zip = buildZip(`${key}.csv`, `${lines.join('\n')}\n`);
      zipCache.set(key, { zip, sha: createHash('sha256').update(zip).digest('hex') });
    }
    const z = zipCache.get(key);
    return isSum ? response(200, `${z.sha}  ${key}.zip`) : response(200, z.zip);
  }
  if (u.hostname === 'www.bitstamp.net') {
    const step = Number(u.searchParams.get('step'));
    if (step !== 86400) return response(200, { data: { pair: 'BTC/USD', ohlc: [] } });
    const start = Number(u.searchParams.get('start')) * 1000;
    const end = Number(u.searchParams.get('end')) * 1000;
    const ohlc = [];
    for (let t = Math.ceil(start / DAY) * DAY; t <= end && ohlc.length < 1000; t += DAY) {
      const [, o, h, l, c, v] = candleRow('btcusd-1d', t, DAY);
      ohlc.push({ timestamp: String(t / 1000), open: String(o), high: String(h), low: String(l), close: String(c), volume: String(v) });
    }
    return response(200, { data: { pair: 'BTC/USD', ohlc } });
  }
  throw new Error(`nepričakovan URL ${urlStr}`);
}

function testConfig() {
  const cfg = loadConfig();
  for (const p of Object.values(cfg.providers)) p.minIntervalMs = 0;
  return cfg;
}

test('backfill: viri, izpuščanje, stablecoin, kriterij LUNC, determinizem', async () => {
  const cfg = testConfig();
  const library = loadLibrary();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cnim-backfill-'));
  const cacheDir = path.join(tmp, 'cache');
  const now = () => Date.UTC(2026, 9, 30);

  const http = createHttpClient(cfg, { fetchImpl: async (url, init) => { new Headers(init.headers); return fakeFetch(url); }, sleep: async () => {} });
  const online = createPriceStore({ http, cfg, cacheDir, now });
  const first = await runBackfill({ cfg, library, store: online });
  const ev = Object.fromEntries(first.libraryOut.events.map((e) => [e.id, e.measured]));

  // FTX: API vrne neveljaven simbol → arhiv; SOL nima vira → izpuščen z razlogom
  assert.equal(ev.ftx_collapse_2022.assets.FTT.source, 'binanceArchive:FTTUSDT:1h');
  assert.equal(ev.ftx_collapse_2022.assets.SOL.status, 'skipped');
  assert.match(ev.ftx_collapse_2022.assets.SOL.reason, /ni ustreznega vira/);
  assert.equal(ev.ftx_collapse_2022.estimationWindow.rule, 'first_pre_event');
  assert.ok(ev.ftx_collapse_2022.assets.FTT.z1 !== null, 't0 na uro natančen → z1');
  assert.equal(ev.ftx_collapse_2022.direction, -1);

  // LUNA: stari LUNA iz arhiva; USTC kot stablecoin brez z/M, z odmikom v bt
  assert.equal(ev.luna_crash_2022.assets.LUNC.source, 'binanceArchive:LUNAUSDT:1h');
  assert.equal(ev.luna_crash_2022.assets.LUNC.z1, null, 't0 na dan natančno → brez z1');
  const ustc = ev.luna_crash_2022.assets.USTC;
  assert.equal(ustc.status, 'info');
  assert.equal(ustc.source, 'binanceArchive:USTBUSD:1h');
  assert.equal(ustc.excludedFromM, true);
  assert.equal(ustc.z24, undefined);
  assert.ok(ustc.maxDepegBps > 1000);

  // Mt. Gox: Binance nima podatkov, Bitstamp 1h prazen → Bitstamp 1d
  const gox = ev.mtgox_2014.assets.BTC;
  assert.equal(gox.source, 'bitstamp:btcusd:1d');
  assert.equal(gox.resolution, '1d');
  assert.equal(gox.z1, null);
  assert.ok(gox.z24 < 0);

  // Binance hack: BNB z merilom BTC, t0 na uro natančen
  assert.equal(ev.binance_hack_2019.assets.BNB.benchmarkSource, 'binanceApi:BTCUSDT:1h');
  assert.equal(ev.binance_hack_2019.estimationWindow.rule, 'before_t0');

  const { refs, acceptance } = first.libraryOut;
  assert.equal(refs.n72, 5);
  assert.ok(refs.M_ref24 > 0 && refs.M_ref72 > 0);
  assert.equal(acceptance.largestImpact.result, 'pass');
  assert.equal(acceptance.largestImpact.rankAbsAR72, 1);
  assert.ok(ev.luna_crash_2022.AR72 < 0);
  assert.ok(ev.china_mining_ban_2021.assets.BTC.z1 !== null, 'Kitajska: t0 na uro natančen → z1');
  assert.equal(acceptance.informativeZ24.length, 2);

  // Ponovni zagon brez omrežja iz predpomnilnika: enak rezultat, nič HTTP klicev
  const callsAfterFirst = JSON.stringify(http.stats());
  const offline = createPriceStore({ http: null, cfg, cacheDir, now, offline: true });
  const second = await runBackfill({ cfg, library, store: offline });
  assert.equal(JSON.stringify(second.libraryOut), JSON.stringify(first.libraryOut));
  assert.equal(JSON.stringify(second.seriesById), JSON.stringify(first.seriesById));
  assert.equal(offline.stats().fetched, 0);
  assert.equal(JSON.stringify(http.stats()), callsAfterFirst);

  // Zapis izhodov
  const outCfg = { ...cfg, paths: { ...cfg.paths } };
  await writeOutputs(first, outCfg, tmp);
  const written = JSON.parse(await fs.readFile(path.join(tmp, cfg.paths.libraryOutput), 'utf8'));
  assert.equal(written.events.length, 5);
  const s = JSON.parse(await fs.readFile(path.join(tmp, cfg.paths.seriesDir, 'luna_crash_2022.json'), 'utf8'));
  // Arhiv se konča 13. 5. (ustavitev trgovanja): 2. 5. – 13. 5. = 11 dni × 24 h
  assert.equal(s.assets.LUNC.points.length, 11 * 24);
  assert.match(formatTable(first.libraryOut), /LUNC\*/);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('backfill: neveljaven vnos v knjižnici ustavi tek z jasno napako', async () => {
  const cfg = testConfig();
  const lib = loadLibrary();
  lib[0] = { ...lib[0], t0Source: null };
  const store = createPriceStore({ http: null, cfg, cacheDir: os.tmpdir(), offline: true });
  await assert.rejects(runBackfill({ cfg, library: lib, store }), /t0Source/);
});

test('backfill: brez podatkov se M ne izračuna, razlog je zapisan', async () => {
  const cfg = testConfig();
  const lib = loadLibrary().filter((e) => e.id === 'binance_hack_2019');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cnim-empty-'));
  const store = createPriceStore({ http: null, cfg, cacheDir: tmp, offline: true });
  const { libraryOut } = await runBackfill({ cfg, library: lib, store });
  const m = libraryOut.events[0].measured;
  assert.equal(m.M72, null);
  assert.equal(m.primaryStatus, 'skipped');
  assert.equal(libraryOut.acceptance.largestImpact.result, 'n/a');
  await fs.rm(tmp, { recursive: true, force: true });
});

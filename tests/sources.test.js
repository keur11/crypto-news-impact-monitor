import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHttpClient } from '../collector/lib/http.js';
import { extractSingleFile } from '../collector/lib/zip.js';
import { fetchApiRange, fetchArchiveMonth, normalizeTimestamp, parseKlineCsv } from '../collector/sources/binance.js';
import { parseOhlc } from '../collector/sources/bitstamp.js';
import { HOUR } from '../collector/lib/time.js';
import { buildZip, loadConfig } from './helpers.js';

const cfg = loadConfig();

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    },
  };
}

function client(handler) {
  const seen = [];
  const http = createHttpClient(cfg, {
    fetchImpl: async (url, init) => {
      new Headers(init.headers); // enako preverjanje glav kot pravi fetch (samo ASCII)
      seen.push({ url, ua: init.headers['User-Agent'] });
      return handler(url, seen.length);
    },
    sleep: async () => {},
  });
  return { http, seen };
}

test('časovni žigi arhiva: mikrosekunde od 2025 → milisekunde', () => {
  assert.equal(normalizeTimestamp('1735689600000000'), 1735689600000);
  assert.equal(normalizeTimestamp(1651017600000), 1651017600000);
});

test('CSV sveč z glavo ali brez', () => {
  const body = 'open_time,open,high,low,close,volume,close_time,quote_volume,count\n1651017600000,1,2,0.5,1.5,10,1651021199999,15,3\n';
  const c = parseKlineCsv(body);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], { t: 1651017600000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, qv: 15 });
  assert.equal(parseKlineCsv('1651017600000,1,2,0.5,1.5,10,1651021199999,15,3').length, 1);
});

test('ZIP z eno datoteko (deflate)', () => {
  const zip = buildZip('X-1h-2022-05.csv', 'abc,def\n'.repeat(100));
  const f = extractSingleFile(zip);
  assert.equal(f.name, 'X-1h-2022-05.csv');
  assert.equal(f.data.toString(), 'abc,def\n'.repeat(100));
});

test('Bitstamp: qv = volume × close', () => {
  const [k] = parseOhlc([{ timestamp: '1393200000', open: '600', high: '610', low: '500', close: '550', volume: '2' }]);
  assert.equal(k.t, 1393200000000);
  assert.equal(k.qv, 1100);
});

test('HTTP: User-Agent in glave samo ASCII (pravi fetch sicer vrže napako ByteString)', async () => {
  assert.doesNotThrow(() => new Headers({ 'User-Agent': cfg.app.userAgent }), 'UA iz configa je veljavna glava');
  assert.throws(() => createHttpClient({ ...cfg, app: { ...cfg.app, userAgent: 'Orodje (analitično)' } }), /ASCII/);
  const { http } = client(() => response(200, []));
  await assert.rejects(http.request('x', 'https://x/y', { headers: { 'User-Agent': 'kontakt: žan@example.com' } }), /ASCII/);
});

test('HTTP: ponovni poskus ob 429, User-Agent, štetje klicev', async () => {
  const { http, seen } = client((url, n) => (n === 1 ? response(429, 'slow down', { 'retry-after': '1' }) : response(200, [1])));
  const res = await http.request('binanceApi', 'https://x/y');
  assert.deepEqual(res.data, [1]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].ua, cfg.app.userAgent);
  assert.deepEqual(http.stats(), { binanceApi: 2 });
});

test('HTTP: največ 3 poskusi ob 5xx', async () => {
  const { http, seen } = client(() => response(503, 'down'));
  await assert.rejects(http.request('bitstamp', 'https://x/y'), /HTTP 503/);
  assert.equal(seen.length, cfg.http.maxAttempts);
});

test('HTTP: 451 brez ponovnega poskusa in z razlago', async () => {
  const { http, seen } = client(() => response(451, ''));
  await assert.rejects(http.request('binanceApi', 'https://x/y'), (err) => err.code === 'GEO_BLOCKED');
  assert.equal(seen.length, 1);
});

test('Binance API: straničenje po 1000 svečah in neveljaven simbol', async () => {
  const start = Date.UTC(2022, 0, 1);
  const end = start + 2500 * HOUR;
  const { http } = client((url) => {
    const u = new URL(url);
    if (u.searchParams.get('symbol') === 'NOPEUSDT') return response(400, { code: -1121, msg: 'Invalid symbol.' });
    const s = Number(u.searchParams.get('startTime'));
    const e = Number(u.searchParams.get('endTime'));
    const rows = [];
    for (let t = s; t <= e && rows.length < 1000; t += HOUR) rows.push([t, '1', '1', '1', '1', '1', t + HOUR - 1, '1']);
    return response(200, rows);
  });
  const ok = await fetchApiRange(http, cfg, { symbol: 'BTCUSDT', interval: '1h' }, start, end);
  assert.equal(ok.candles.length, 2500);
  assert.equal(http.stats().binanceApi, 3);
  const nf = await fetchApiRange(http, cfg, { symbol: 'NOPEUSDT', interval: '1h' }, start, end);
  assert.equal(nf.status, 'not_found');
});

test('Binance arhiv: SHA-256 se preveri, 404 pomeni "ni podatkov"', async () => {
  const zip = buildZip('LUNAUSDT-1h-2022-05.csv', '1651363200000,80,81,79,80.5,10,1651366799999,805,5\n');
  const sha = createHash('sha256').update(zip).digest('hex');
  let tamper = false;
  const { http } = client((url) => {
    if (url.includes('USTUSDT')) return response(404, 'not found');
    if (url.endsWith('.CHECKSUM')) return response(200, `${tamper ? 'f'.repeat(64) : sha}  LUNAUSDT-1h-2022-05.zip`);
    return response(200, zip);
  });
  const src = { symbol: 'LUNAUSDT', interval: '1h' };
  const ok = await fetchArchiveMonth(http, cfg, src, '2022-05');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.candles[0].c, 80.5);
  assert.equal((await fetchArchiveMonth(http, cfg, { symbol: 'USTUSDT', interval: '1h' }, '2022-05')).status, 'not_found');
  tamper = true;
  await assert.rejects(fetchArchiveMonth(http, cfg, src, '2022-05'), /SHA-256/);
});

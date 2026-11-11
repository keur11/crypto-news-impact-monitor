#!/usr/bin/env node
// Preizkus dosegljivosti virov (lokalno in v GitHub Actions).
//  - cene: data-api.binance.vision (kritično), arhivi LUNA/UST maj 2022, Bitstamp 1h/1d za 2014;
//  - RSS: vsi viri iz configa, tudi izklopljeni (npr. The Defiant – preverjanje pred vklopom);
//  - CoinGecko: ID-ji kategorij iz /coins/categories/list (če je nastavljen ključ).
// Izhodna koda 1 samo, če kritičen vir (data-api.binance.vision) ni dosegljiv.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from '../collector/lib/http.js';
import { archiveUrl } from '../collector/sources/binance.js';
import { contactUserAgent, parseFeed } from '../collector/sources/rss.js';
import { parseIso, toIso } from '../collector/lib/time.js';
import { redactString, secretValues } from '../collector/lib/redact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/config.json'), 'utf8'));
const http = createHttpClient(cfg);
const results = [];

async function check(group, name, critical, fn) {
  try {
    const detail = await fn();
    results.push({ group, name, ok: true, critical, detail });
  } catch (err) {
    results.push({ group, name, ok: false, critical, detail: err.message });
  }
}

// --- cene ---
const b = cfg.providers.binanceApi;
await check('cene', 'data-api.binance.vision /ping', true, async () => {
  await http.request('binanceApi', `${b.baseUrl}/api/v3/ping`);
  return 'OK';
});
await check('cene', 'data-api.binance.vision klines BTCUSDT 1h', true, async () => {
  const { data } = await http.request('binanceApi', `${b.baseUrl}${b.klinesPath}?symbol=BTCUSDT&interval=1h&limit=1`);
  return `zadnja sveča ${toIso(Number(data[0][0]))}`;
});
await check('cene', 'api.binance.com /ping (pričakovano 451 z ameriških IP)', false, async () => {
  try {
    const { status } = await http.request('binanceApi', 'https://api.binance.com/api/v3/ping', { passStatuses: [403] });
    return `HTTP ${status} (dosegljiv s te lokacije)`;
  } catch (err) {
    if (err.code === 'GEO_BLOCKED') return 'HTTP 451 (pričakovano – zato se uporablja data-api.binance.vision)';
    throw err;
  }
});
for (const symbol of ['LUNAUSDT', 'LUNABUSD', 'USTUSDT', 'USTBUSD', 'FTTUSDT']) {
  const month = symbol === 'FTTUSDT' ? '2022-11' : '2022-05';
  await check('cene', `data.binance.vision ${symbol} 1h ${month}`, false, async () => {
    const url = `${archiveUrl(cfg, { symbol, interval: '1h' }, month)}.CHECKSUM`;
    const { status } = await http.request('binanceArchive', url, { as: 'text', passStatuses: [404] });
    if (status === 404) throw new Error('NI ARHIVA');
    return 'arhiv obstaja';
  });
}
const s = cfg.providers.bitstamp;
for (const [label, step] of [['1h', 3600], ['1d', 86400]]) {
  await check('cene', `Bitstamp btcusd ${label} 2014-02`, false, async () => {
    const start = parseIso('2014-02-01T00:00:00Z') / 1000;
    const url = `${s.baseUrl}${s.ohlcPath.replace('{pair}', 'btcusd')}?step=${step}&limit=5&start=${start}`;
    const { data } = await http.request('bitstamp', url);
    const rows = data?.data?.ohlc ?? [];
    if (!rows.length) throw new Error('NI PODATKOV');
    const first = toIso(Number(rows[0].timestamp) * 1000);
    if (!first.startsWith('2014-02')) throw new Error(`vrnjeno obdobje ${first} – ne pokriva 2014-02`);
    return `prva sveča ${first}`;
  });
}

// --- RSS ---
for (const src of cfg.sources) {
  await check('rss', `${src.id}${src.enabled ? '' : ' (izklopljen)'} ${src.url}`, false, async () => {
    const headers = {};
    if (src.requiresContact) {
      const ua = contactUserAgent(cfg);
      if (!ua) throw new Error(`preskočeno: manjka ${cfg.app.contactEnv}`);
      headers['User-Agent'] = ua;
    }
    const { data } = await http.request(`rss:${src.id}`, src.url, { as: 'text', headers });
    const feed = parseFeed(data);
    const dates = feed.items.map((i) => i.publishedMs).filter(Number.isFinite).sort((x, y) => y - x);
    const newest = dates.length ? toIso(dates[0]) : '—';
    const ageDays = dates.length ? ((Date.now() - dates[0]) / 86400000).toFixed(1) : '—';
    return `${feed.format}, ${feed.items.length} postavk, najnovejša ${newest} (pred ${ageDays} d)`;
  });
}

// --- CoinGecko ---
const cg = cfg.providers.coingecko;
const key = process.env[cg.apiKeyEnv];
await check('coingecko', '/coins/categories/list – ID-ji sektorjev', false, async () => {
  if (!key) throw new Error(`preskočeno: manjka ${cg.apiKeyEnv}`);
  const { data } = await http.request('coingecko', `${cg.baseUrl}/coins/categories/list`, { headers: { [cg.apiKeyHeader]: key } });
  const ids = new Set(data.map((c) => c.category_id));
  const wanted = [...cfg.sectors.list.map((x) => x.id), ...cfg.sectors.libraryOnly, cfg.sectors.exclude.stablecoinCategory];
  const missing = wanted.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`neobstoječi ID-ji: ${missing.join(', ')}`);
  return `vseh ${wanted.length} ID-jev obstaja (skupaj ${data.length} kategorij)`;
});

// Izpis gre v javni dnevnik in artifact: skrivnosti se maskirajo.
const secrets = secretValues(cfg);
const print = (line) => console.log(redactString(line, secrets));
let group = '';
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    print(`\n[${group}]`);
  }
  print(`${r.ok ? 'OK    ' : r.detail.startsWith('preskočeno') ? 'SKIP  ' : 'NAPAKA'}  ${r.name}: ${r.detail}`);
}
print(`\nKlici: ${JSON.stringify(http.stats())}`);
if (results.some((r) => r.critical && !r.ok)) process.exit(1);

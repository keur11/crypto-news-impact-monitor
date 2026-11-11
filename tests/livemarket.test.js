// Tržni vpliv živih dogodkov in celotna veriga (RSS → dogodki → trg → točkovanje) nad simuliranimi cenami.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDictionary } from '../collector/entities.js';
import { measureLiveEvent, needsMeasurement, phaseAt } from '../collector/livemarket.js';
import { createHttpClient } from '../collector/lib/http.js';
import { createPriceStore } from '../collector/prices.js';
import { runCollector } from '../collector/pipeline.js';
import { HOUR, floorTo, toIso } from '../collector/lib/time.js';
import { loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const sectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sectors.json'), 'utf8'));
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/library-measured-synthetic.json'), 'utf8'));
const dict = buildDictionary(cfg, sectors);
const T0 = Date.parse('2026-10-20T09:20:00Z');

// Deterministične urne cene: šum + (za izbrane simbole) padec 1 % na uro 24 h od SHOCK.
function price(symbol, t, shocks) {
  const k = t / HOUR;
  const ph = [...symbol].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1000, 7) / 37; // različna faza za vsak simbol
  let lv = 0.004 * Math.sin(k * 1.3 + ph) + 0.003 * Math.cos(k * (0.5 + (ph % 1)) + 2 * ph);
  const s = shocks[symbol];
  if (s !== undefined) lv += -0.01 * Math.min(Math.max(Math.floor((t - floorTo(s, HOUR)) / HOUR) + 1, 0), 24);
  return 100 * Math.exp(lv);
}
function fakeStore(available, nowMs, shocks = {}) {
  const calls = [];
  return {
    calls,
    async getCandles(src, from, to) {
      calls.push(src.symbol);
      if (!available.includes(src.symbol)) return { status: 'not_found', candles: [], errors: [] };
      const out = [];
      for (let t = floorTo(from, HOUR); t < to && t + HOUR <= nowMs; t += HOUR) {
        const c = price(src.symbol, t, shocks);
        const o = price(src.symbol, t - HOUR, shocks);
        out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, qv: t >= floorTo(T0, HOUR) && t < floorTo(T0, HOUR) + 24 * HOUR ? 3e6 : 1e6 });
      }
      return { status: 'ok', candles: out, errors: [] };
    },
  };
}
const HISTORY = {
  snapshots: [{
    fetchedAt: '2026-10-01T00:00:00Z',
    marketCaps: { HYPE: 1.2e10, LINK: 9e9, UNI: 5e9, AAVE: 4e9, RUNE: 5e8 },
    sectors: { 'decentralized-finance-defi': ['HYPE', 'LINK', 'UNI', 'AAVE', 'RUNE'] },
  }],
};
const ev = (primaryAsset, extra = {}) => ({ id: 'e', firstSeenAt: toIso(T0), primaryAsset, entities: primaryAsset ? [primaryAsset] : [], ...extra });
const ctx = (store, nowMs, marketState = { noPair: {} }) => ({ cfg, store, nowMs, dict, sectorsHistory: HISTORY, marketState });

test('faze: 0 pred prvo zaprto svečo, 1, 24, 72; ponovna meritev samo ob novi fazi', () => {
  const c0 = floorTo(T0, HOUR);
  assert.equal(phaseAt(ev('BNB'), c0 + 59 * 60000), 0);
  assert.equal(phaseAt(ev('BNB'), c0 + HOUR), 1);
  assert.equal(phaseAt(ev('BNB'), c0 + 24 * HOUR), 24);
  assert.equal(phaseAt(ev('BNB'), c0 + 72 * HOUR), 72);
  assert.equal(needsMeasurement(ev('BNB'), c0 + 2 * HOUR), true);
  assert.equal(needsMeasurement(ev('BNB', { market: { phase: 1 } }), c0 + 5 * HOUR), false);
  assert.equal(needsMeasurement(ev('BNB', { market: { phase: 1 } }), c0 + 25 * HOUR), true);
  assert.equal(needsMeasurement(ev('BNB', { market: { phase: 72, final: true } }), c0 + 100 * HOUR), false);
});

test('kovanec s parom: po 30 h z24 in M24, brez z72; po 73 h končno z M = M72', async () => {
  const c0 = floorTo(T0, HOUR);
  const m24 = await measureLiveEvent(ev('BNB'), ctx(fakeStore(['BTCUSDT', 'BNBUSDT'], c0 + 30 * HOUR, { BNBUSDT: T0 }), c0 + 30 * HOUR));
  assert.equal(m24.status, 'ok');
  assert.equal(m24.asset, 'BNB');
  assert.equal(m24.phase, 24);
  assert.equal(m24.final, false);
  assert.ok(m24.z1 < 0 && m24.z24 < -2, `z24 = ${m24.z24}`);
  assert.equal(m24.z72, null, '72-urno okno se še ni izteklo');
  assert.equal(m24.M, m24.M24);
  assert.equal(m24.direction, -1);
  assert.ok(Math.abs(m24.V - 3) < 1e-9, 'V = 3 (trikratni volumen v 24 h)');
  assert.ok(m24.notes.some((n) => n.includes('se še ni izteklo')));
  const m72 = await measureLiveEvent(ev('BNB'), ctx(fakeStore(['BTCUSDT', 'BNBUSDT'], c0 + 73 * HOUR, { BNBUSDT: T0 }), c0 + 73 * HOUR));
  assert.equal(m72.phase, 72);
  assert.equal(m72.final, true);
  assert.ok(m72.z72 !== null);
  assert.equal(m72.M, m72.M72);
  assert.ok(Number.isFinite(m72.btcZ24));
});

test('BTC kot primarni: merilo je sredstvo samo (β = 0)', async () => {
  const now = floorTo(T0, HOUR) + 30 * HOUR;
  const m = await measureLiveEvent(ev('BTC'), ctx(fakeStore(['BTCUSDT'], now, { BTCUSDT: T0 }), now));
  assert.equal(m.status, 'ok');
  assert.equal(m.beta, 0);
  assert.equal(m.btcZ24, m.z24);
});

test('brez para na Binance: sektorski indeks (top po market cap s podatki); "ni para" se zapomni', async () => {
  const now = floorTo(T0, HOUR) + 30 * HOUR;
  const state = { noPair: {} };
  const store = fakeStore(['BTCUSDT', 'LINKUSDT', 'UNIUSDT', 'AAVEUSDT'], now);
  const m = await measureLiveEvent(ev('HYPE'), ctx(store, now, state));
  assert.equal(m.status, 'ok');
  assert.equal(m.asset, 'sector:decentralized-finance-defi');
  assert.equal(m.kind, 'sector');
  assert.equal(m.replaces, 'HYPE');
  assert.deepEqual(m.members.map((x) => x.symbol), ['LINK', 'UNI', 'AAVE'], 'HYPE in RUNE brez para');
  assert.equal(m.weightsSnapshotAt, '2026-10-01T00:00:00Z');
  assert.ok(state.noPair.HYPE && state.noPair.RUNE);
  // drugi klic v istem tednu ne sprašuje več za HYPE
  store.calls.length = 0;
  await measureLiveEvent(ev('HYPE'), ctx(store, now, state));
  assert.ok(!store.calls.includes('HYPEUSDT'));
});

test('sektorski indeks z < 3 člani → tržni indeks (top 20, enake uteži), označen kot trg', async () => {
  const now = floorTo(T0, HOUR) + 30 * HOUR;
  const hist = { snapshots: [{ ...HISTORY.snapshots[0], marketTop: ['BTC', 'ETH', 'BNB', 'SOL', 'HYPE', 'LINK'] }] };
  const store = fakeStore(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'LINKUSDT'], now);
  const m = await measureLiveEvent(ev('HYPE'), { ...ctx(store, now), sectorsHistory: hist });
  assert.equal(m.status, 'ok');
  assert.equal(m.kind, 'market');
  assert.equal(m.asset, 'market:top');
  assert.match(m.source, /^trg/);
  assert.deepEqual(m.members.map((x) => [x.symbol, x.weight]), [['BTC', 1], ['ETH', 1], ['BNB', 1], ['LINK', 1]], 'enake uteži, brez kovancev brez para');
  assert.match(m.fallbackReason, /le 1 članov/);
  assert.equal(m.series.market.label, cfg.scoring.marketIndex.label);
  // kovanec s parom, a sektor brez dovolj članov: primerjalna serija na grafu je trg
  const bnb = await measureLiveEvent(ev('BNB'), { ...ctx(store, now), sectorsHistory: hist });
  assert.equal(bnb.kind, 'coin');
  assert.equal(bnb.series.sector, null);
  assert.ok(bnb.series.market.points.length > 40);
  // brez posnetka tržnega vrha: BTC, ETH + spremljani kovanci
  const m2 = await measureLiveEvent(ev('HYPE'), ctx(store, now));
  assert.equal(m2.kind, 'market');
  assert.match(m2.membersSource, /ni posnetka/);
});

test('premalo članov indeksov, ni kovanca, ni merila → brez tržnih podatkov z razlogom', async () => {
  const now = floorTo(T0, HOUR) + 30 * HOUR;
  const few = await measureLiveEvent(ev('HYPE'), ctx(fakeStore(['BTCUSDT', 'LINKUSDT'], now), now));
  assert.equal(few.status, 'no_data');
  assert.match(few.reason, /le 1 članov.*tržni indeks: le 2 članov/);
  assert.equal((await measureLiveEvent(ev(null), ctx(fakeStore([], now), now))).status, 'no_asset');
  const noBtc = await measureLiveEvent(ev('BNB'), ctx(fakeStore(['BNBUSDT'], now), now));
  assert.equal(noBtc.status, 'no_data');
  assert.match(noBtc.reason, /merilo BTC/);
  assert.equal(await measureLiveEvent(ev('BNB'), ctx(fakeStore([], T0), T0)), null, 'faza 0');
});

test('shramba cen: odprta (nezaprta) sveča se ne uporabi', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-open-'));
  const now = Date.parse('2026-11-02T10:30:00Z');
  const http = createHttpClient(cfg, {
    sleep: async () => {},
    fetchImpl: async (url) => {
      const u = new URL(url);
      const s = Number(u.searchParams.get('startTime'));
      const rows = [];
      for (let t = s; t <= Date.parse('2026-11-02T10:00:00Z'); t += HOUR) rows.push([t, '1', '1', '1', '1', '1', t + HOUR - 1, '1']);
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(rows.slice(0, 1000)) };
    },
  });
  const store = createPriceStore({ http, cfg, cacheDir: tmp, now: () => now });
  const r = await store.getCandles({ provider: 'binanceApi', symbol: 'BTCUSDT', interval: '1h' }, Date.parse('2026-11-02T00:00:00Z'), now);
  assert.equal(r.candles.at(-1).t, Date.parse('2026-11-02T09:00:00Z'), 'sveča 10:00 se zapre šele ob 11:00');
  await fsp.rm(tmp, { recursive: true, force: true });
});

// ---------- celotna veriga ----------

const FEEDS = {
  'www.coindesk.com': 'coindesk', 'cointelegraph.com': 'cointelegraph', 'decrypt.co': 'decrypt',
  'www.theblock.co': 'theblock', 'cryptoslate.com': 'cryptoslate', 'www.sec.gov': 'sec',
};
function rssHttp() {
  return createHttpClient(cfg, {
    sleep: async () => {},
    fetchImpl: async (url) => {
      const id = FEEDS[new URL(url).hostname];
      const body = fs.readFileSync(path.join(ROOT, 'tests/fixtures/feeds', `${id}.xml`), 'utf8');
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
    },
  });
}
const NOW = Date.parse('2026-11-02T08:00:00Z');
const state = (library) => ({
  articles: [], events: [], sectors, sectorsHistory: { snapshots: [{ fetchedAt: '2026-10-25T00:00:00Z', marketCaps: { BNB: 9e10, SOL: 8e10, HYPE: 1.2e10, LINK: 9e9, UNI: 5e9, AAVE: 4e9, RUNE: 5e8, CORE: 3e8 }, sectors: {} }] },
  marketState: null, archive: null, prevStatus: null, library, libraryInput: null,
});
const avail = ['BTCUSDT', 'BNBUSDT', 'SOLUSDT', 'ETHUSDT', 'LINKUSDT', 'UNIUSDT', 'AAVEUSDT'];

test('celotna veriga z izmerjeno (sintetično) knjižnico: potrjeni dogodki z ExPost, analogi, arhiv', async () => {
  const store = fakeStore(avail, NOW, { BNBUSDT: Date.parse('2026-10-29T21:00:00Z') });
  const r = await runCollector({ cfg, http: rssHttp(), nowMs: NOW, env: { CONTACT_EMAIL: 'x@example.com' }, state: state(LIB), store });
  const fbi = r.events.find((e) => e.title.startsWith("FBI confirms North Korea's role"));
  assert.equal(fbi.market.status, 'ok');
  assert.equal(fbi.market.asset, 'BNB');
  assert.equal(fbi.market.phase, 24, '1. 11. 01:10 → ob 2. 11. 08:00 je minilo 31 h');
  assert.equal(fbi.status, 'confirmed');
  assert.ok(Number.isInteger(fbi.exPost.score) && fbi.exPost.horizon === 'M24');
  assert.equal(fbi.final, Math.round(0.3 * fbi.exAnteEff.raw + 0.7 * fbi.exPost.raw));
  assert.equal(fbi.exAnte.Tsource, 'library');
  // Visok A prek binance_hack_2019 ima prvi dogodek {BNB}; pri FBI {BNB, @FBI, @NORTH_KOREA} je Jaccard 1/3.
  const firstEv = r.events.find((e) => e.title.startsWith('Binance investigating hack'));
  assert.equal(firstEv.analogs[0].id, 'binance_hack_2019');
  assert.ok(firstEv.exAnte.A > 0);
  // FBI je nadaljevanje zgodbe »Binance hack« (specifičen kovanec BNB): N = 0,5, brez shared_impact znotraj zgodbe
  const first = r.events.find((e) => e.title.startsWith('Binance investigating hack'));
  assert.equal(fbi.storyId, first.storyId);
  assert.equal(fbi.novelty.reason, 'follow_up');
  assert.equal(fbi.exAnteEff.N, 0.5);
  assert.equal(first.novelty.reason, 'first');
  assert.ok(!fbi.flags.includes('shared_impact'));

  const intel = r.events.find((e) => e.title.startsWith('Intel Stock'));
  assert.ok(intel.flags.includes('no_market_asset'));
  assert.equal(intel.status, 'expected');
  assert.equal(intel.final, intel.exAnteEff.score);

  const old = r.events.find((e) => e.title.startsWith('Binance investigating hack'));
  assert.equal(old.market.phase, 72);
  assert.equal(old.market.final, true);
  assert.ok(r.archive.entries.some((x) => x.id === old.id && x.exPost));
  assert.equal(r.status.scoring.calibrated, true);
  assert.ok(r.status.scoring.counts.confirmed > 0);
  assert.ok(!r.status.warnings.some((w) => w.includes('ni izmerjena')));
});

test('celotna veriga brez knjižnice: trg se meri, ExPost ne; vsi "expected"; opozorilo', async () => {
  const store = fakeStore(avail, NOW);
  const r = await runCollector({ cfg, http: rssHttp(), nowMs: NOW, env: {}, state: state(null), store });
  const withMarket = r.events.filter((e) => e.market?.status === 'ok');
  assert.ok(withMarket.length > 5);
  for (const e of r.events) {
    assert.equal(e.status, 'expected');
    assert.equal(e.exPost, null);
    assert.equal(e.final, e.exAnteEff.score);
    assert.equal(e.exAnte.A, 0);
  }
  assert.ok(r.status.warnings.includes('Referenčna knjižnica ni izmerjena – ocene niso kalibrirane'));
  assert.equal(r.status.scoring.calibrated, false);
});

test('ponovni tek: tržne meritve v isti fazi se ne ponovijo (brez klicev cen)', async () => {
  const store1 = fakeStore(avail, NOW);
  const r1 = await runCollector({ cfg, http: rssHttp(), nowMs: NOW, env: {}, state: state(LIB), store: store1 });
  const store2 = fakeStore(avail, NOW + 30 * 60000);
  const s2 = { ...state(LIB), articles: r1.articles, events: r1.events, sectorsHistory: r1.sectorsHistory, marketState: r1.marketState, archive: r1.archive };
  const r2 = await runCollector({ cfg, http: rssHttp(), nowMs: NOW + 30 * 60000, env: {}, state: s2, store: store2 });
  const remeasured = r2.events.filter((e) => e.market && e.market.measuredAt === toIso(NOW + 30 * 60000));
  if (remeasured.length === 0) assert.equal(store2.calls.length, 0, 'brez nove faze ni klicev cen');
  assert.ok(remeasured.length < r1.events.filter((e) => e.market).length, 'večina meritev ostane iz prvega teka');
  for (const e of remeasured) assert.ok(phaseAt(e, NOW + 30 * 60000) > (r1.events.find((x) => x.id === e.id)?.market?.phase ?? 0));
});

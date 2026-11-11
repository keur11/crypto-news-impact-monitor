// Celoten tek zbiralnika nad simuliranim omrežjem (RSS iz fikstur, CoinGecko odgovori).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHttpClient } from '../collector/lib/http.js';
import { runCollector } from '../collector/pipeline.js';
import { runOnce } from '../collector/run.js';
import { libraryState } from '../collector/library.js';
import { MASK, redact, secretValues } from '../collector/lib/redact.js';
import { loadConfig, ROOT } from './helpers.js';

const NOW = Date.parse('2026-11-02T08:00:00Z');
const FEEDS = {
  'www.coindesk.com': 'coindesk', 'cointelegraph.com': 'cointelegraph', 'decrypt.co': 'decrypt',
  'www.theblock.co': 'theblock', 'cryptoslate.com': 'cryptoslate', 'www.sec.gov': 'sec',
};
const feedXml = (id) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/feeds', `${id}.xml`), 'utf8');

function res(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status < 300, headers: { get: () => null }, text: async () => text, arrayBuffer: async () => Buffer.from(text) };
}

const coin = (id, symbol, name, cap) => ({ id, symbol: symbol.toLowerCase(), name, market_cap: cap, market_cap_rank: 1 });
const CG = {
  list: [
    { category_id: 'decentralized-finance-defi', name: 'Decentralized Finance (DeFi)' },
    { category_id: 'layer-2', name: 'Layer 2 (L2)' },
    { category_id: 'artificial-intelligence', name: 'Artificial Intelligence (AI)' },
    { category_id: 'meme-token', name: 'Meme' },
    { category_id: 'centralized-exchange-token-cex', name: 'Centralized Exchange (CEX) Token' },
    { category_id: 'stablecoins', name: 'Stablecoins' },
    { category_id: 'layer-1', name: 'Layer 1 (L1)' },
    { category_id: 'proof-of-work-pow', name: 'Proof of Work (PoW)' },
    // solana-ecosystem namenoma manjka → preverjanje neveljavnega ID-ja
  ],
  markets: {
    stablecoins: [coin('tether', 'USDT', 'Tether', 1.8e11), coin('usd-coin', 'USDC', 'USDC', 7e10)],
    'decentralized-finance-defi': [
      coin('tether', 'USDT', 'Tether', 1.8e11),
      coin('wrapped-bitcoin', 'WBTC', 'Wrapped Bitcoin', 1e10),
      coin('hyperliquid', 'HYPE', 'Hyperliquid', 1.2e10),
      coin('chainlink', 'LINK', 'Chainlink', 9e9),
      coin('thorchain', 'RUNE', 'THORChain', 5e8),
      coin('lido-staked-ether', 'STETH', 'Lido Staked Ether', 3e10),
    ],
    'centralized-exchange-token-cex': [coin('binancecoin', 'BNB', 'BNB', 9e10)],
  },
};

function makeHttp(cfg, { down = [], log = [], secEcho = false } = {}) {
  return createHttpClient(cfg, {
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      new Headers(init.headers); // enako preverjanje glav kot pravi fetch (samo ASCII)
      const u = new URL(url);
      log.push({ host: u.hostname, ua: init.headers['User-Agent'], key: init.headers['x-cg-demo-api-key'] });
      if (u.hostname === 'api.coingecko.com') {
        if (u.pathname.endsWith('/coins/categories/list')) return res(200, CG.list);
        if (u.pathname.endsWith('/coins/markets')) return res(200, CG.markets[u.searchParams.get('category')] ?? []);
        return res(404, 'not found');
      }
      const id = FEEDS[u.hostname];
      if (!id) throw new Error(`nepričakovan URL ${url}`);
      if (down.includes(id)) return res(503, 'Service Unavailable');
      if (secEcho && id === 'sec') return res(403, `Undeclared automated tool: ${init.headers['User-Agent']}`);
      return res(200, feedXml(id));
    },
  });
}

const emptyState = () => ({ articles: [], events: [], sectors: null, prevStatus: null, library: null });

test('izpad enega vira: tek se konča, napaka je v statusu, ostali viri delujejo', async () => {
  const cfg = loadConfig();
  const http = makeHttp(cfg, { down: ['coindesk'] });
  const r = await runCollector({ cfg, http, nowMs: NOW, env: { CONTACT_EMAIL: 'test@example.com' }, state: emptyState() });
  assert.equal(r.status.ok, true);
  assert.equal(r.status.sources.coindesk.ok, false);
  assert.match(r.status.sources.coindesk.lastError, /HTTP 503/);
  assert.equal(r.status.sources.coindesk.lastErrorAt, '2026-11-02T08:00:00Z');
  assert.ok(r.status.errors.some((e) => e.startsWith('CoinDesk:')));
  assert.equal(r.status.httpCalls['rss:coindesk'], cfg.http.maxAttempts, 'ponovni poskusi ob 5xx');
  assert.equal(r.status.articles.new, 71, '91 − 20 člankov CoinDesk');
  assert.equal(r.status.sources.decrypt.ok, true);
  assert.equal(r.status.sources.blockworks.enabled, false);
  assert.equal(r.status.sources.thedefiant.enabled, false);
  assert.equal(r.status.httpCalls['rss:blockworks'], undefined, 'izklopljen vir se ne kliče');
});

test('SEC: brez CONTACT_EMAIL preskočen (opozorilo), s kontaktom User-Agent vsebuje kontakt', async () => {
  const cfg = loadConfig();
  const r1 = await runCollector({ cfg, http: makeHttp(cfg), nowMs: NOW, env: {}, state: emptyState() });
  assert.equal(r1.status.sources.sec.skipped, true);
  assert.equal(r1.status.sources.sec.ok, false);
  assert.ok(r1.status.warnings.some((w) => w.includes('CONTACT_EMAIL')));
  assert.ok(!r1.status.errors.some((e) => e.includes('SEC')), 'preskok ni napaka');

  const log = [];
  const r2 = await runCollector({ cfg, http: makeHttp(cfg, { log }), nowMs: NOW, env: { CONTACT_EMAIL: 'ops@example.com' }, state: emptyState() });
  assert.equal(r2.status.sources.sec.ok, true);
  const secCall = log.find((x) => x.host === 'www.sec.gov');
  assert.match(secCall.ua, /contact: ops@example\.com$/);
  assert.ok(!log.find((x) => x.host === 'decrypt.co').ua.includes('ops@example.com'), 'kontakt samo za vire, ki ga zahtevajo');
});

test('CoinGecko brez ključa: opozorilo, entitete iz configa, tek uspe', async () => {
  const cfg = loadConfig();
  const log = [];
  const r = await runCollector({ cfg, http: makeHttp(cfg, { log }), nowMs: NOW, env: {}, state: emptyState() });
  assert.equal(log.filter((x) => x.host === 'api.coingecko.com').length, 0);
  assert.equal(r.sectors, null);
  assert.ok(r.status.warnings.some((w) => w.includes('COINGECKO_DEMO_API_KEY')));
  const e = r.events.find((x) => x.title.startsWith('Binance arranges $6.34 billion'));
  assert.deepEqual(e.entities, ['BNB'], 'Binance → BNB iz statičnega slovarja');
  assert.deepEqual(e.sectors, [], 'brez sektorjev');
});

test('CoinGecko s ključem: preverjanje ID-jev, izločanje stablecoinov in zavitih žetonov, ključ v glavi', async () => {
  const cfg = loadConfig();
  const log = [];
  const r = await runCollector({ cfg, http: makeHttp(cfg, { log }), nowMs: NOW, env: { COINGECKO_DEMO_API_KEY: 'k123' }, state: emptyState() });
  const cgCalls = log.filter((x) => x.host === 'api.coingecko.com');
  assert.ok(cgCalls.length > 0 && cgCalls.every((x) => x.key === 'k123'));
  assert.deepEqual(r.status.coingecko.invalidCategories, ['solana-ecosystem']);
  assert.ok(r.status.warnings.some((w) => w.includes('solana-ecosystem')));
  const defi = r.sectors.sectors.find((s) => s.id === 'decentralized-finance-defi');
  assert.deepEqual(defi.coins.map((c) => c.symbol), ['HYPE', 'LINK', 'RUNE'], 'brez USDT, WBTC, stETH');
  assert.equal(r.sectors.sectors.find((s) => s.id === 'solana-ecosystem'), undefined);
  const hype = r.events.find((x) => x.title.startsWith('HYPE surges'));
  assert.deepEqual(hype.sectors, ['decentralized-finance-defi']);
  assert.ok(r.status.httpCalls.coingecko <= 3 + cfg.sectors.list.length, 'dnevni proračun klicev (seznam, stablecoini, sektorji, tržni vrh)');

  // Drugi tek isti dan: brez klicev CoinGecko
  const log2 = [];
  const r2 = await runCollector({
    cfg, http: makeHttp(cfg, { log: log2 }), nowMs: NOW + 3600000, env: { COINGECKO_DEMO_API_KEY: 'k123' },
    state: { ...emptyState(), sectors: r.sectors },
  });
  assert.equal(log2.filter((x) => x.host === 'api.coingecko.com').length, 0);
  assert.equal(r2.status.coingecko.refreshed, false);
});

test('neizmerjena knjižnica: opozorilo, ExAnte iz privzetih T in A = 0, brez ExPost, vsi "expected"', async () => {
  const cfg = loadConfig();
  const r = await runCollector({ cfg, http: makeHttp(cfg), nowMs: NOW, env: {}, state: emptyState() });
  assert.equal(r.status.library.measured, false);
  assert.equal(r.status.calibrated, false);
  assert.ok(r.status.warnings.includes('Referenčna knjižnica ni izmerjena – ocene niso kalibrirane'));
  assert.ok(r.events.length > 0);
  for (const e of r.events) {
    assert.equal(e.status, 'expected');
    assert.equal(e.exAnte.calibrated, false);
    assert.equal(e.exAnte.Tsource, 'default');
    assert.equal(e.exAnte.T, cfg.scoring.typeDefaults[e.exAnte.type]);
    assert.equal(e.exAnte.A, 0);
    assert.equal(e.exPost, null);
    assert.equal(e.final, e.exAnteEff.score);
  }
  assert.equal(r.status.scoring.market, 'disabled');
});

test('libraryState: manjka / brez measured / delno / izmerjena', () => {
  const cfg = loadConfig();
  const W = cfg.status.libraryWarnings;
  assert.equal(libraryState(null, cfg).warning, W.unmeasured);
  const unmeasured = { refs: { M_ref24: null }, events: [{ id: 'a', measured: { M24: null } }] };
  assert.equal(libraryState(unmeasured, cfg).measured, false);
  const partial = { refs: { M_ref24: 2, M_ref72: 3 }, events: [{ measured: { M24: 2 } }, { measured: { M24: null } }] };
  const p = libraryState(partial, cfg);
  assert.equal(p.measured, true);
  assert.equal(p.partial, true);
  assert.equal(p.warning, `${W.partial} (1/2)`);
  const full = { refs: { M_ref24: 2, M_ref72: 3 }, events: [{ measured: { M24: 2 } }] };
  assert.deepEqual(libraryState(full, cfg), {
    exists: true, measured: true, partial: false, nEvents: 1, nMeasured: 1, refs: { M_ref24: 2, M_ref72: 3 }, warning: null,
  });
});

test('ponovni tek: brez dvojnikov, zamrznjene oznake, ohranjeni ID-ji in polja točkovanja, retencija', async () => {
  const cfg = loadConfig();
  const env = { CONTACT_EMAIL: 'x@example.com' };
  const r1 = await runCollector({ cfg, http: makeHttp(cfg), nowMs: NOW, env, state: emptyState() });
  const ev = r1.events.find((e) => e.title.startsWith('Binance investigating hack'));
  const r2 = await runCollector({
    cfg, http: makeHttp(cfg), nowMs: NOW + 30 * 60000, env,
    state: { articles: r1.articles, events: r1.events, sectors: null, prevStatus: r1.status, library: null },
  });
  assert.equal(r2.status.articles.new, 0);
  assert.equal(r2.articles.length, r1.articles.length);
  assert.deepEqual(r2.events.map((e) => e.id), r1.events.map((e) => e.id));
  assert.deepEqual(r2.events.find((e) => e.id === ev.id).exAnte.score, ev.exAnte.score, 'brez novih člankov enak ExAnte');
  assert.equal(r2.articles[0].ingestedAt, '2026-11-02T08:00:00Z', 'ingestedAt se ne prepiše');

  // 15 dni kasneje: vsi članki in dogodki izpadejo iz 14-dnevnega okna
  const r3 = await runCollector({
    cfg, http: makeHttp(cfg, { down: Object.values(FEEDS) }), nowMs: NOW + 15 * 86400000, env,
    state: { articles: r2.articles, events: r2.events, sectors: null, prevStatus: r2.status, library: null },
  });
  assert.equal(r3.articles.length, 0);
  assert.equal(r3.events.length, 0);
  assert.equal(r3.status.sources.decrypt.lastSuccessAt, '2026-11-02T08:30:00Z', 'zadnje uspešno branje se ohrani');
});

test('aktivni viri: uspešno branje in ≥ 1 članek v zadnjih 24 h', async () => {
  const cfg = loadConfig();
  const r = await runCollector({ cfg, http: makeHttp(cfg), nowMs: NOW, env: {}, state: emptyState() });
  // Zadnji članki: CoinDesk 1. 11. 10:35 (< 24 h), Decrypt 1. 11. 16:01, The Block 2. 11., CT 2. 11., CryptoSlate 1. 11. 21:00
  assert.deepEqual(r.status.activeSources.sort(), ['coindesk', 'cointelegraph', 'cryptoslate', 'decrypt', 'theblock']);
  assert.equal(r.status.sources.sec.active, false, 'preskočen vir ni aktiven');
});

test('runOnce: zapiše data/*.json; pokvarjena datoteka stanja ne ustavi teka', async () => {
  const cfg = loadConfig();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-run-'));
  await fsp.mkdir(path.join(tmp, 'data'), { recursive: true });
  await fsp.writeFile(path.join(tmp, cfg.paths.events), '{ pokvarjeno');
  const r = await runOnce({ root: tmp, cfg, http: makeHttp(cfg), nowMs: NOW, env: {} });
  for (const p of [cfg.paths.articles, cfg.paths.events, cfg.paths.status]) {
    assert.ok(fs.existsSync(path.join(tmp, p)), p);
  }
  const status = JSON.parse(await fsp.readFile(path.join(tmp, cfg.paths.status), 'utf8'));
  assert.ok(status.errors.some((e) => e.startsWith('branje data/events.json')));
  assert.ok(status.warnings.includes('Referenčna knjižnica ni izmerjena – ocene niso kalibrirane'));
  assert.equal(JSON.parse(await fsp.readFile(path.join(tmp, cfg.paths.events), 'utf8')).events.length, r.events.length);
  assert.ok(!fs.existsSync(path.join(tmp, cfg.paths.sectors)), 'brez ključa se sectors.json ne zapiše');
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('maskiranje: kontakt in ključ se ne pojavita v nobeni zapisani datoteki (tudi če ju vir vrne v napaki)', async () => {
  const cfg = loadConfig();
  const env = { CONTACT_EMAIL: 'jack.secret@example.com', COINGECKO_DEMO_API_KEY: 'CG-supersecret-key' };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-redact-'));
  const r = await runOnce({ root: tmp, cfg, http: makeHttp(cfg, { secEcho: true }), nowMs: NOW, env });
  assert.equal(r.status.sources.sec.ok, false);
  assert.ok(r.status.sources.sec.lastError.includes('jack.secret@example.com'), 'kontrola: napaka v pomnilniku vsebuje kontakt');
  const files = (await fsp.readdir(path.join(tmp, 'data'))).map((f) => path.join(tmp, 'data', f));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const txt = await fsp.readFile(f, 'utf8');
    assert.ok(!txt.includes('jack.secret@example.com'), `${f} vsebuje kontakt`);
    assert.ok(!txt.includes('CG-supersecret-key'), `${f} vsebuje ključ`);
  }
  const status = JSON.parse(await fsp.readFile(path.join(tmp, cfg.paths.status), 'utf8'));
  assert.ok(status.sources.sec.lastError.includes(MASK));
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('redact: gnezdeni objekti, ključi, URL-kodirana oblika, kratke vrednosti se ne maskirajo', () => {
  const cfg = loadConfig();
  const secrets = secretValues(cfg, { CONTACT_EMAIL: 'a.b+c@example.com', COINGECKO_DEMO_API_KEY: 'xyz' });
  assert.deepEqual(secrets, ['a.b+c@example.com'], 'vrednosti < 4 znakov se ne maskirajo');
  const out = redact({ e: ['url?u=a.b%2Bc%40example.com', { 'a.b+c@example.com': 'x a.b+c@example.com y' }], n: 5 }, secrets);
  assert.deepEqual(out, { e: ['url?u=***', { '***': 'x *** y' }], n: 5 });
});

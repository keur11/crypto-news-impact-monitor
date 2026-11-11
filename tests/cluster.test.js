// Združevanje nad pravimi naslovi iz feedov (zajem 2026-11-02, zgodba "Binance hack" 29. 10. – 2. 11. 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFeed, normalizeItems } from '../collector/sources/rss.js';
import { buildDictionary } from '../collector/entities.js';
import { createClassifier } from '../collector/classify.js';
import { tagArticle } from '../collector/pipeline.js';
import { assignArticles, eventId, seenMs } from '../collector/cluster.js';
import { buildIdf, tokenize, vectorize } from '../collector/lib/tfidf.js';
import { loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const sectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sectors.json'), 'utf8'));
const dict = buildDictionary(cfg, sectors);
const classifier = createClassifier(cfg, dict);
const NOW = Date.parse('2026-11-02T08:00:00Z');
const SOURCES = ['coindesk', 'cointelegraph', 'decrypt', 'theblock', 'cryptoslate', 'sec'];

function loadArticles() {
  const out = [];
  for (const id of SOURCES) {
    const f = parseFeed(fs.readFileSync(path.join(ROOT, 'tests/fixtures/feeds', `${id}.xml`), 'utf8'));
    out.push(...normalizeItems(f.items, id, NOW).articles.map((a) => tagArticle(a, dict, classifier)));
  }
  return out;
}

function cluster(articles, existing = [], all = articles) {
  const idf = buildIdf(all.map((a) => tokenize(a.title)));
  const vectors = new Map(all.map((a) => [a.id, vectorize(tokenize(a.title), idf)]));
  const articlesById = new Map(all.map((a) => [a.id, a]));
  return assignArticles(existing, articles, { cfg, vectors, articlesById, classifier, dict });
}

const ARTICLES = loadArticles();
const { events: EVENTS } = cluster(ARTICLES);
const byTitle = (prefix) => {
  const a = ARTICLES.find((x) => x.title.startsWith(prefix));
  assert.ok(a, `ni članka: ${prefix}`);
  return a;
};
const eventOf = (prefix) => EVENTS.find((e) => e.articleIds.includes(byTitle(prefix).id));

test('vsak članek je v natanko enem dogodku', () => {
  assert.equal(ARTICLES.length, 91);
  const ids = EVENTS.flatMap((e) => e.articleIds);
  assert.equal(ids.length, 91);
  assert.equal(new Set(ids).size, 91);
});

test('isti razvoj zgodbe iz treh virov: "$6.34 milijarde za kritje izgub" je en dogodek', () => {
  const e = eventOf('Binance arranges $6.34 billion');
  assert.equal(e, eventOf('Binance says it has $6.34 billion ready'));
  assert.equal(e, eventOf('Binance Sets Aside $6.34B'));
  assert.equal(e.type, 'hack');
  assert.deepEqual(e.entities, ['BNB']);
  assert.ok(e.nSources >= 3);
  assert.equal(e.firstSource, 'coindesk');
  assert.deepEqual(e.sectors.includes('centralized-exchange-token-cex'), true);
});

test('isti razvoj iz dveh virov po podobnosti naslovov (TF-IDF): Trezor', () => {
  const e = eventOf('Trezor reports suspected hardware implant');
  assert.equal(e, eventOf('Trezor Warns CryptoBilis Buyers'));
  assert.equal(e.nSources, 2);
});

test('časovno okno 12 h: ista zgodba 21 h kasneje je nov dogodek', () => {
  // The Block 30. 10. 16:26 in Cointelegraph 31. 10. 13:37 (Δ ≈ 21 h)
  assert.notEqual(eventOf('Texas brothers sentenced to 15 years for holding'), eventOf('Texas brothers sentenced to 15 years in prison'));
});

test('nepovezane zgodbe ostanejo ločene in brez entitet', () => {
  const intel = eventOf('Intel Stock Suffers Worst Crash');
  const reddit = eventOf('Reddit Stock Plunges 30%');
  assert.notEqual(intel, reddit);
  assert.deepEqual(intel.entities, []);
  assert.equal(intel.articleIds.length, 1);
});

test('SEC sporočilo: tip regulation, vir tier 1,0 ločen dogodek', () => {
  const e = eventOf('Two Entities Charged');
  assert.equal(e.type, 'regulation');
  assert.equal(e.firstSource, 'sec');
});

test('struktura dogodka: firstSeenAt, firstIngestedAt, ID iz prvega članka', () => {
  const e = eventOf('Binance investigating hack');
  const first = byTitle('Binance investigating hack');
  assert.equal(e.firstSeenAt, '2026-10-29T21:49:16Z');
  assert.equal(e.firstIngestedAt, '2026-11-02T08:00:00Z');
  assert.equal(e.id, eventId(first));
  assert.match(e.id, /^evt_20261029_[0-9a-f]{6}$/);
  assert.equal(e.title, first.title);
});

test('determinizem: enak vhod v drugem vrstnem redu da enak izhod', () => {
  const again = cluster([...ARTICLES].reverse()).events;
  assert.equal(JSON.stringify(again), JSON.stringify(EVENTS));
});

test('inkrementalno: ID-ji in člani obstoječih dogodkov se ne spremenijo', () => {
  const cut = Date.parse('2026-10-31T00:00:00Z');
  const first = ARTICLES.filter((a) => seenMs(a) < cut);
  const second = ARTICLES.filter((a) => seenMs(a) >= cut);
  const r1 = cluster(first, [], first);
  const r2 = cluster(second, r1.events, ARTICLES);
  for (const e1 of r1.events) {
    const e2 = r2.events.find((e) => e.id === e1.id);
    assert.ok(e2, `dogodek ${e1.id} izginil`);
    for (const a of e1.articleIds) assert.ok(e2.articleIds.includes(a));
  }
  assert.equal(r2.events.flatMap((e) => e.articleIds).length, 91);
});

test('FBI o Severni Koreji (CoinDesk 01:10, Cointelegraph 07:44, CryptoSlate 12:20) je en dogodek', () => {
  // BTC/ETH/SOL v naslovu CoinDesk so ozadje (prisoten je BNB); akterja @FBI in @NORTH_KOREA sta skupna.
  const e = eventOf("FBI confirms North Korea's role");
  assert.equal(e, eventOf('FBI blames North Korea for record'));
  assert.equal(e, eventOf('FBI blames North Korea for $6 billion'));
  assert.deepEqual(e.entities, ['BNB', '@FBI', '@NORTH_KOREA']);
  assert.equal(e.primaryAsset, 'BNB');
});

test('ozadje: BTC v naslovu z drugim kovancem ni glavna entiteta, sam pa je', () => {
  assert.deepEqual(byTitle('Bitcoin slides below $77,000, BNB drops').titleSalient, ['BNB']);
  assert.deepEqual(byTitle('18 years in, what has Bitcoin truly done?').titleSalient, ['BTC']);
});

test('novo pravilo razbije prej zlepljen grozd: šibko podobni naslovi se ne združijo samo zaradi entitet', () => {
  // Prej (enake entitete + tip): 15 člankov v enem dogodku, tudi s TF-IDF 0,055.
  assert.notEqual(eventOf('Binance arranges $6.34 billion'), eventOf('Secret Service, FBI Join Binance Hack Probe'));
  for (const e of EVENTS) assert.ok(e.articleIds.length <= 4, `${e.title}: ${e.articleIds.length}`);
});

// Znana omejitev do embeddingov (2. faza): različno besedišče brez skupnih kripto entitet.
test('ZNANA OMEJITEV: Texas (The Block 16:26, Decrypt 18:16) ni en dogodek', { todo: 'različna besedišča (heist/gunpoint ↔ kidnapping/prison); rešijo embeddingi' }, () => {
  assert.equal(eventOf('Texas brothers sentenced to 15 years for holding'), eventOf('$8 Million Crypto Kidnapping'));
});

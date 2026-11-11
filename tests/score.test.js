// Točkovanje (poglavje 6) z ročno izračunanimi primeri.
// Knjižnica: tests/fixtures/library-measured-synthetic.json – SINTETIČNA (M izmišljeni za izračune):
//   M24 = (FTX 6, LUNA 9, Kitajska 1,5, Binance 3, Mt. Gox 2) → M_ref24 = 3
//   M72 = (8, 12, 2, 4, 3) → M_ref72 = 4;  rel72 = (2, 3, 0,5, 1, 0,75)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDictionary } from '../collector/entities.js';
import { createClassifier } from '../collector/classify.js';
import { libraryState } from '../collector/library.js';
import { tagArticle } from '../collector/pipeline.js';
import { buildIdf, tokenize } from '../collector/lib/tfidf.js';
import { HOUR, toIso } from '../collector/lib/time.js';
import {
  componentA,
  componentC,
  componentQ,
  componentS,
  componentT,
  computeExAnte,
  computeExPost,
  confoundingReasons,
  exAnteArticles,
  finalScore,
  findAnalogs,
  libraryFeatures,
  sharedImpactIds,
  similarity,
  snapshotAt,
} from '../collector/score.js';
import { scoreEvents } from '../collector/scoring.js';
import { approx, loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const sectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sectors.json'), 'utf8'));
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/library-measured-synthetic.json'), 'utf8'));
const dict = buildDictionary(cfg, sectors);
const classifier = createClassifier(cfg, dict);
const lib = libraryState(LIB, cfg);
const noLib = libraryState(null, cfg);
const feats = libraryFeatures(LIB.events, dict);
const EMPTY_IDF = buildIdf([]); // vse uteži 1 → kosinus postane navaden TF kosinus (ročni izračun)
const tierOf = (s) => Object.fromEntries(cfg.sources.map((x) => [x.id, x.tier]))[s] ?? cfg.scoring.defaultTier;
const T0 = Date.parse('2026-11-02T10:00:00Z');
const HISTORY = {
  snapshots: [{ fetchedAt: '2026-11-01T00:00:00Z', marketCaps: { BNB: 9e10, SOL: 8e10, LINK: 9e9, UNI: 5e9 }, sectors: {} }],
};

test('sintetična knjižnica je izmerjena in označena kot sintetična', () => {
  assert.match(LIB._synthetic, /SINTETIČNA/);
  assert.equal(lib.measured, true);
  assert.equal(lib.partial, false);
  assert.deepEqual(lib.refs, { M_ref24: 3, M_ref72: 4 });
});

test('uteži in privzete vrednosti so točno iz specifikacije', () => {
  assert.deepEqual(cfg.scoring.exAnteWeights, { T: 0.3, C: 0.2, Q: 0.1, S: 0.15, A: 0.25 });
  assert.deepEqual(cfg.scoring.typeDefaults, {
    insolvency: 0.8, protocol_failure: 0.8, hack: 0.6, regulation: 0.6, etf_institutional: 0.6, macro: 0.4,
    listing: 0.3, upgrade: 0.3, tokenomics: 0.3, partnership: 0.15, other: 0.1,
  });
  // podobnost: popravek formule iz specifikacije (tip je pogoj), odobreno 2026-11-02
  assert.deepEqual(cfg.scoring.similarityWeights, { entities: 0.6, keywords: 0.4 });
  assert.equal(cfg.scoring.similarityTypeGate, true);
  assert.deepEqual(cfg.scoring.finalWeights, { exAnte: 0.3, exPost: 0.7 });
  assert.equal(cfg.scoring.analogMinSim, 0.3);
  assert.equal(cfg.scoring.exAnteWindowHours, 6);
  assert.deepEqual(cfg.market.mWeights, { z24: 0.6, z72: 0.4 });
});

test('T: povprečje rel istega tipa (omejeno na 1) ali privzeta vrednost', () => {
  assert.deepEqual(componentT('hack', lib, feats, cfg), { value: 1, source: 'library', n: 1 });
  assert.deepEqual(componentT('insolvency', lib, feats, cfg), { value: 1, source: 'library', n: 2 }, '(2 + 0,75)/2 = 1,375 → 1');
  assert.deepEqual(componentT('regulation', lib, feats, cfg), { value: 0.5, source: 'library', n: 1 });
  assert.deepEqual(componentT('listing', lib, feats, cfg), { value: 0.3, source: 'default', n: 0 });
  assert.deepEqual(componentT('hack', noLib, feats, cfg), { value: 0.6, source: 'default', n: 0 }, 'brez knjižnice');
});

test('C, Q, S', () => {
  assert.equal(componentC(3, 5), 0.6);
  assert.equal(componentC(7, 5), 1);
  assert.equal(componentC(2, 0), 1, 'brez aktivnih virov imenovalec 1');
  assert.equal(componentC(0, 5, 1), 1, 'samo uradni vir → C = 1');
  assert.equal(componentC(2, 5, 1), 0.4, 'uradni vir ni v števcu');
  assert.equal(componentC(0, 5, 0), 0);
  assert.equal(componentQ(['coindesk', 'sec'], tierOf), 1);
  assert.equal(componentQ(['cryptoslate'], tierOf), 0.4);
  assert.equal(componentQ(['neznan'], tierOf), 0.4, 'privzeti tier');
  assert.equal(componentQ([], tierOf), 0);
  const caps = HISTORY.snapshots[0].marketCaps;
  assert.equal(componentS('LINK', caps, cfg), 0.5, '2 od 4 kovancev ≤ LINK');
  assert.equal(componentS('BNB', caps, cfg), 1);
  assert.equal(componentS('BTC', {}, cfg), 1, 'BTC = 1');
  assert.equal(componentS('ETH', null, cfg), 1, 'ETH = 1');
  assert.equal(componentS('XYZ', caps, cfg), 0);
  assert.equal(componentS(null, caps, cfg), 0);
});

test('podobnost (ročni izračun): [tip] · (0,6·Jaccard + 0,4·cos)', () => {
  // ključne besede Binance 2019 → 7 žetonov: binance, hack, hot, wallet, safu, withdrawal, suspend
  // dogodek: binance, hack, hot, wallet → cos = 4 / (√4 · √7)
  const ev = { type: 'hack', entities: ['BNB'], tokens: tokenize('Binance hack hot wallet') };
  const ref = feats.find((f) => f.id === 'binance_hack_2019');
  assert.deepEqual(ref.entities, ['BNB'], 'BTC je ozadje ob BNB');
  const s = similarity(ev, ref, EMPTY_IDF, cfg);
  assert.ok(approx(s.keywords, 4 / (2 * Math.sqrt(7))));
  assert.ok(approx(s.sim, 0.6 * 1 + 0.4 * (4 / (2 * Math.sqrt(7)))), '= 0,902');
  // drug tip → sim = 0 ne glede na vsebino
  assert.equal(similarity({ ...ev, type: 'regulation' }, ref, EMPTY_IDF, cfg).sim, 0);
  // Kitajska: same ozadje (BTC, ETH) ostane + akter
  assert.deepEqual(feats.find((f) => f.id === 'china_mining_ban_2021').entities, ['BTC', 'ETH', '@CN_REGULATORS']);
  const an = findAnalogs(ev, feats, EMPTY_IDF, cfg);
  assert.deepEqual(an.map((a) => a.id), ['binance_hack_2019'], 'ostali imajo sim < 0,3');
});

test('A: s podobnostjo utežen povprečni rel (omejeno na 1); brez knjižnice 0', () => {
  const an = [{ id: 'a', sim: 0.9, rel: 0.5 }, { id: 'b', sim: 0.3, rel: 2 }, { id: 'c', sim: 0.4, rel: null }];
  assert.ok(approx(componentA(an, lib), (0.9 * 0.5 + 0.3 * 2) / 1.2), '= 0,875');
  assert.equal(componentA([{ id: 'x', sim: 0.5, rel: 3 }], lib), 1);
  assert.equal(componentA(an, noLib), 0);
  assert.equal(componentA([], lib), 0);
});

// ---------- ExAnte nad dogodkom ----------

function art(id, source, title, seenH, ingestedH = seenH) {
  const a = { id, url: `https://x/${id}`, title, summary: '', source, publishedAt: toIso(T0 + seenH * HOUR), ingestedAt: toIso(T0 + ingestedH * HOUR) };
  return tagArticle(a, dict, classifier);
}
const A1 = art('a1', 'coindesk', 'Binance hack hot wallet', 0);
const A2 = art('a2', 'theblock', 'Binance hot wallet hack confirmed', 1);
const A3 = art('a3', 'sec', 'SEC statement on Binance hot wallet hack', 2);
const A4 = art('a4', 'cryptoslate', 'Binance hack aftermath', 8); // izven okna 6 h
const A5 = art('a5', 'cryptoslate', 'Binance hack: exclusive early report', 1, 10); // datiran nazaj, zajet po 10 h
const EVENT = { id: 'evt_test', firstSeenAt: toIso(T0), firstIngestedAt: toIso(T0), articleIds: ['a1', 'a2', 'a3', 'a4', 'a5'], primaryAsset: 'BNB', entities: ['BNB'] };
const ctxBase = (articles, nowMs, library = lib) => ({
  cfg, articlesById: new Map(articles.map((a) => [a.id, a])), classifier, dict, lib: library,
  libFeatures: libraryFeatures(LIB.events, dict), idfModel: EMPTY_IDF, activeSourceCount: 5,
  sectorsHistory: HISTORY, tierOf, nowMs,
});

test('ExAnte (ročni izračun): T=1, C=2/5 (SEC ni medij), Q=1 (SEC), S=1, A=1 → 88', () => {
  const { exAnte, analogs } = computeExAnte(EVENT, ctxBase([A1, A2, A3], T0 + 3 * HOUR));
  // 100 · (0,30·1 + 0,20·0,4 + 0,10·1 + 0,15·1 + 0,25·1) = 88
  assert.deepEqual([exAnte.T, exAnte.C, exAnte.Q, exAnte.S, exAnte.A], [1, 0.4, 1, 1, 1]);
  assert.equal(exAnte.score, 88);
  assert.equal(exAnte.nMediaSources, 2);
  assert.equal(exAnte.type, 'hack', 'tier: 0,7 + 0,7 + 1,0 za hack');
  assert.deepEqual(exAnte.entities, ['BNB'], '@SEC je v 1/3 naslovov');
  assert.equal(exAnte.frozen, false, 'pred knownBy je začasen');
  assert.equal(analogs[0].id, 'binance_hack_2019');
  // cos = 12 / (√39 · √7): TF dogodka binance, hack, hot, wallet po 3, confirm, sec, statement po 1
  assert.ok(approx(analogs[0].sim, Math.round((0.6 + 0.4 * (12 / Math.sqrt(273))) * 1000) / 1000));
});

test('ExAnte brez knjižnice: T = privzeto 0,6, A = 0 → 51 (analogi le za prikaz)', () => {
  const { exAnte, analogs } = computeExAnte(EVENT, ctxBase([A1, A2, A3], T0 + 3 * HOUR, noLib));
  assert.equal(exAnte.T, 0.6);
  assert.equal(exAnte.A, 0);
  assert.equal(exAnte.score, 51, '100 · (0,18 + 0,08 + 0,10 + 0,15 + 0)');
  assert.equal(exAnte.calibrated, false);
  assert.equal(analogs[0].id, 'binance_hack_2019', 'podobnost deluje tudi brez meritev');
});

test('brez look-ahead: kasnejši in nazaj datirani članki ter tržni podatki ne spremenijo ExAnte', () => {
  const frozenNow = T0 + 11 * HOUR;
  const all = [A1, A2, A3, A4, A5];
  const sel = exAnteArticles(EVENT, new Map(all.map((a) => [a.id, a])), cfg);
  assert.deepEqual(sel.articles.map((a) => a.id), ['a1', 'a2', 'a3'], 'a4: objava po 6 h; a5: zajem po 6 h');
  const early = computeExAnte(EVENT, ctxBase([A1, A2, A3], T0 + 3 * HOUR)).exAnte;
  const late = computeExAnte(EVENT, ctxBase(all, frozenNow)).exAnte;
  assert.equal(late.frozen, true);
  for (const k of ['score', 'T', 'C', 'Q', 'S', 'A', 'type', 'nSources']) assert.deepEqual(late[k], early[k], k);
});

test('zamrznjen ExAnte se v scoreEvents ne preračuna (tudi ob spremembi aktivnih virov in tržnih podatkih)', async () => {
  const all = [A1, A2, A3, A4, A5];
  const frozen = computeExAnte(EVENT, ctxBase([A1, A2, A3], T0 + 7 * HOUR)).exAnte;
  assert.equal(frozen.frozen, true);
  const ev = { ...EVENT, type: 'hack', exAnte: frozen, analogs: [], market: { status: 'ok', phase: 24, M24: 1.5, M72: null, final: false } };
  const { events } = await scoreEvents([ev], {
    ...ctxBase(all, T0 + 30 * HOUR), activeSourceCount: 1, libEvents: LIB.events, store: null, marketState: {}, archive: null,
  });
  assert.equal(events[0].exAnte, frozen);
  assert.equal(events[0].exPost.score, 50);
});

test('snapshotAt: zadnji pred časom, sicer najzgodnejši z oznako', () => {
  const h = { snapshots: [{ fetchedAt: '2026-11-01T00:00:00Z' }, { fetchedAt: '2026-11-02T00:00:00Z' }] };
  assert.equal(snapshotAt(h, Date.parse('2026-11-01T12:00:00Z')).snapshot.fetchedAt, '2026-11-01T00:00:00Z');
  assert.deepEqual(snapshotAt(h, Date.parse('2026-10-01T00:00:00Z')), { snapshot: h.snapshots[0], after: true });
  assert.deepEqual(snapshotAt(null, 0), { snapshot: null, after: false });
});

// ---------- ExPost in končna ocena ----------

test('ExPost po 24 h: 100·min(1, 1,5/3) = 50; najbližji Kitajska (M24 1,5)', () => {
  const p = computeExPost({ status: 'ok', phase: 24, M24: 1.5, M72: null }, lib, LIB.events);
  assert.deepEqual(
    { score: p.score, horizon: p.horizon, Mref: p.Mref, nearestRef: p.nearestRef, ratio: p.ratioToNearest },
    { score: 50, horizon: 'M24', Mref: 3, nearestRef: 'china_mining_ban_2021', ratio: 1 },
  );
});

test('ExPost po 72 h: 100·min(1, 6/4) = 100; izenačenje najbližjega (Binance 4, FTX 8) po id', () => {
  const p = computeExPost({ status: 'ok', phase: 72, M24: 1.5, M72: 6 }, lib, LIB.events);
  assert.equal(p.score, 100);
  assert.equal(p.horizon, 'M72');
  assert.equal(p.nearestRef, 'binance_hack_2019');
  assert.equal(p.ratioToNearest, 1.5);
  assert.equal(computeExPost({ status: 'ok', phase: 72, M24: 1.5, M72: null }, lib, LIB.events).horizon, 'M24', 'brez M72 → M24');
});

test('ExPost se ne računa: brez knjižnice, pred 24 h, brez tržnih podatkov', () => {
  const m = { status: 'ok', phase: 24, M24: 1.5 };
  assert.equal(computeExPost(m, noLib, LIB.events), null);
  assert.equal(computeExPost({ ...m, phase: 1 }, lib, LIB.events), null);
  assert.equal(computeExPost({ status: 'no_data', phase: 24 }, lib, LIB.events), null);
  assert.equal(computeExPost(null, lib, LIB.events), null);
});

test('končna ocena: 0,3·88 + 0,7·50 = 61,4 → 61 (potrjen); 0,3·88 + 0,7·100 = 96,4 → 96; brez ExPost = ExAnte', () => {
  const ea = { score: 88, raw: 88 };
  assert.deepEqual(finalScore(ea, { score: 50, raw: 50 }, cfg), { final: 61, status: 'confirmed' });
  assert.deepEqual(finalScore(ea, { score: 100, raw: 100 }, cfg), { final: 96, status: 'confirmed' });
  assert.deepEqual(finalScore(ea, null, cfg), { final: 88, status: 'expected' });
  assert.deepEqual(finalScore(null, null, cfg), { final: null, status: 'expected' });
});

// ---------- varovalke ----------

test('confounded: |z24(BTC)| > 3 in dogodek ne zadeva BTC; makro objava v ±24 h', () => {
  const ev = { firstSeenAt: '2026-11-05T12:00:00Z', entities: ['BNB'] };
  assert.equal(confoundingReasons(ev, { btcZ24: -3.5 }, cfg).length, 1);
  assert.equal(confoundingReasons(ev, { btcZ24: -2.9 }, cfg).length, 0);
  assert.equal(confoundingReasons({ ...ev, entities: ['BTC'] }, { btcZ24: -3.5 }, cfg).length, 0, 'zadeva BTC');
  const cpi = confoundingReasons({ firstSeenAt: '2026-11-10T00:00:00Z', entities: ['BNB'] }, null, cfg);
  assert.deepEqual(cpi, ['CPI ZDA (oktober 2026) (2026-11-10T13:30:00Z)']);
  assert.equal(confoundingReasons({ firstSeenAt: '2026-11-11T14:00:00Z', entities: [] }, null, cfg).length, 0, '24,5 h po CPI');
});

test('shared_impact: ista merjena entiteta v ±24 h', () => {
  const t = (h) => toIso(T0 + h * HOUR);
  const evs = [
    { id: 'e1', firstSeenAt: t(0), market: { asset: 'BNB' } },
    { id: 'e2', firstSeenAt: t(20), primaryAsset: 'BNB' },
    { id: 'e3', firstSeenAt: t(50), market: { asset: 'BNB' } },
    { id: 'e4', firstSeenAt: t(1), market: { asset: 'LINK' } },
    { id: 'e5', firstSeenAt: t(2) },
  ];
  assert.deepEqual([...sharedImpactIds(evs, cfg)].sort(), ['e1', 'e2']);
});

test('A ne podvaja T: "stolen iPhone" (isti tip, brez skupnih entitet in besed) → sim 0, A = 0', () => {
  const ev = { type: 'hack', entities: [], tokens: tokenize("A stolen iPhone, $14,000 in losses and London's crypto theft problem") };
  const ref = feats.find((f) => f.id === 'binance_hack_2019');
  assert.equal(similarity(ev, ref, EMPTY_IDF, cfg).sim, 0);
  const an = findAnalogs(ev, feats, EMPTY_IDF, cfg);
  assert.deepEqual(an, []);
  assert.equal(componentA(an, lib), 0);
});

test('Binance hack 2026 → visok A prek binance_hack_2019', () => {
  const ev = { type: 'hack', entities: ['BNB'], tokens: tokenize('Binance investigating hack as suspicious outflows reach up to $5.8 billion') };
  const an = findAnalogs(ev, feats, EMPTY_IDF, cfg);
  assert.equal(an[0].id, 'binance_hack_2019');
  assert.ok(an[0].sim >= 0.6, `sim = ${an[0].sim}`);
  assert.equal(componentA(an, lib), 1, 'rel(binance_hack_2019) = 4/4');
});

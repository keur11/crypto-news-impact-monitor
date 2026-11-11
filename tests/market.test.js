import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimationWindowLive,
  magnitudeM24,
  magnitudeM72,
  maxDepegBps,
  measureImpact,
  sectorIndexCandles,
  volumeFactor,
} from '../collector/market.js';
import { DAY, HOUR, parseIso } from '../collector/lib/time.js';
import { approx, loadConfig, makeCandles } from './helpers.js';

const cfg = loadConfig();
const E0 = Date.UTC(2024, 0, 1);
const EST = { start: E0, end: E0 + 720 * HOUR };
const C0 = E0 + 744 * HOUR; // ocenjevalno okno (30 d) + 1 dan razmika

// 720 donosov ±0,01, 24 ničel (razmik), 72 × d v oknu dogodka, 24 ničel
function seq({ est, gap = 24, event, tail = 24 }) {
  return [...est, ...Array(gap).fill(0), ...event, ...Array(tail).fill(0)];
}
const alternating = (n, a) => Array.from({ length: n }, (_, i) => (i % 2 ? -a : a));

test('volumeFactor, M24 in M72 (ročni primer)', () => {
  assert.ok(approx(volumeFactor(4, cfg), 1.2));
  assert.ok(approx(volumeFactor(16, cfg), 1.3), 'log2 V je omejen na 3');
  assert.equal(volumeFactor(0.5, cfg), 1, 'log2 V < 0 se omeji na 0');
  assert.equal(volumeFactor(null, cfg), 1);
  // z24 = −3, z72 = −4, V = 4: M24 = 3 · 1,2 = 3,6; M72 = (0,6·3 + 0,4·4) · 1,2 = 4,08
  assert.ok(approx(magnitudeM24(-3, 1.2), 3.6));
  assert.ok(approx(magnitudeM72(-3, -4, 1.2, cfg), 4.08));
  assert.equal(magnitudeM72(-3, null, 1.2, cfg), null);
});

test('BTC kot lastno merilo: β = 0, z iz surovih donosov, V, M', () => {
  const d = 0.005;
  const returns = seq({ est: alternating(720, 0.01), event: Array(72).fill(d) });
  const candles = makeCandles(E0 - HOUR, HOUR, returns, { qv: (i) => (i >= 744 && i < 768 ? 3000 : 1000) });
  const res = measureImpact({
    assetCandles: candles,
    benchCandles: null,
    interval: '1h',
    t0Ms: C0 + 15 * 60 * 1000, // 10:15 → sveča 10:00
    t0Precision: 'hour',
    estWindow: EST,
    cfg,
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.beta, 0);
  const sigma = Math.sqrt((720 * 1e-4) / 719);
  assert.ok(approx(res.sigma, sigma, 1e-9));
  assert.ok(approx(res.z1, d / sigma, 1e-9));
  assert.ok(approx(res.z24, (24 * d) / (sigma * Math.sqrt(24)), 1e-9));
  assert.ok(approx(res.z72, (72 * d) / (sigma * Math.sqrt(72)), 1e-9));
  assert.ok(approx(res.V, 3, 1e-12), 'V = 72.000 / 24.000');
  const vf = 1 + 0.1 * Math.log2(3);
  assert.ok(approx(res.M24, res.z24 * vf, 1e-12));
  assert.ok(approx(res.M72, (0.6 * res.z24 + 0.4 * res.z72) * vf, 1e-12));
  assert.equal(res.direction, 1);
  assert.equal(res.eventStart, new Date(C0).toISOString().replace('.000Z', 'Z'));
});

test('sredstvo z β = 2 glede na BTC: AR odstrani tržni del', () => {
  // rb = [a, a, −a, −a]…, e = [b, −b, b, −b]… → Cov(rb, e) = 0, β = 2, σ_AR = std(e)
  const a = 0.01;
  const b = 0.002;
  const rbEst = Array.from({ length: 720 }, (_, i) => (i % 4 < 2 ? a : -a));
  const eEst = alternating(720, b);
  const c = 0.001;
  const dAbn = -0.004;
  const benchReturns = seq({ est: rbEst, event: Array(72).fill(c) });
  const assetReturns = seq({ est: rbEst.map((r, i) => 2 * r + eEst[i]), event: Array(72).fill(2 * c + dAbn) });
  const res = measureImpact({
    assetCandles: makeCandles(E0 - HOUR, HOUR, assetReturns),
    benchCandles: makeCandles(E0 - HOUR, HOUR, benchReturns),
    interval: '1h',
    t0Ms: C0,
    t0Precision: 'hour',
    estWindow: EST,
    cfg,
  });
  assert.equal(res.status, 'ok');
  assert.ok(approx(res.beta, 2, 1e-9));
  const sigma = Math.sqrt((720 * b * b) / 719);
  assert.ok(approx(res.sigma, sigma, 1e-7));
  assert.ok(approx(res.ar24, 24 * dAbn, 1e-7));
  assert.ok(approx(res.z24, (24 * dAbn) / (sigma * Math.sqrt(24)), 1e-6));
  assert.ok(approx(res.z72, (72 * dAbn) / (sigma * Math.sqrt(72)), 1e-6));
  assert.equal(res.direction, -1);
});

test('t0Precision "day": z1 se ne računa', () => {
  const returns = seq({ est: alternating(720, 0.01), event: Array(72).fill(-0.002) });
  const res = measureImpact({
    assetCandles: makeCandles(E0 - HOUR, HOUR, returns),
    interval: '1h',
    t0Ms: C0,
    t0Precision: 'day',
    estWindow: EST,
    cfg,
  });
  assert.equal(res.z1, null);
  assert.ok(res.z24 < 0);
  assert.ok(res.notes.some((n) => n.startsWith('z1:')));
});

test('dnevni podatki: z24 iz 1 sveče, z72 iz 3, brez z1', () => {
  const D0 = Date.UTC(2014, 0, 7);
  const est = { start: D0, end: D0 + 30 * DAY };
  const returns = [...alternating(30, 0.02), 0, -0.05, -0.05, -0.05, 0];
  const res = measureImpact({
    assetCandles: makeCandles(D0 - DAY, DAY, returns),
    interval: '1d',
    t0Ms: D0 + 31 * DAY,
    t0Precision: 'day',
    estWindow: est,
    cfg,
  });
  assert.equal(res.status, 'ok');
  const sigma = Math.sqrt((30 * 0.0004) / 29);
  assert.ok(approx(res.z24, -0.05 / sigma, 1e-9));
  assert.ok(approx(res.z72, -0.15 / (sigma * Math.sqrt(3)), 1e-9));
  assert.equal(res.z1, null);
});

test('premalo podatkov v ocenjevalnem oknu', () => {
  const returns = seq({ est: alternating(100, 0.01), event: Array(72).fill(0.001) });
  const res = measureImpact({
    assetCandles: makeCandles(E0 + 620 * HOUR, HOUR, returns),
    interval: '1h',
    t0Ms: C0,
    t0Precision: 'hour',
    estWindow: EST,
    cfg,
  });
  assert.equal(res.status, 'insufficient_estimation');
  assert.match(res.reason, /ocenjevalno okno/);
});

test('vrzel v oknu dogodka: log donosi se seštejejo, AR ostane enak', () => {
  const returns = seq({ est: alternating(720, 0.01), event: Array(72).fill(-0.003) });
  const full = makeCandles(E0 - HOUR, HOUR, returns);
  const holed = full.filter((k) => k.t !== C0 + 5 * HOUR && k.t !== C0 + 6 * HOUR);
  const args = { interval: '1h', t0Ms: C0, t0Precision: 'hour', estWindow: EST, cfg };
  const a = measureImpact({ ...args, assetCandles: full });
  const b = measureImpact({ ...args, assetCandles: holed });
  assert.ok(approx(b.ar24, a.ar24, 1e-12));
  assert.ok(approx(b.z24, a.z24, 1e-12));
  assert.ok(approx(b.coverage.event24, 22 / 24));
  assert.ok(b.notes.some((n) => n.includes('vrzel')));
});

test('ocenjevalno okno za žive dogodke: [t − 31 d, t − 1 d), poravnano na uro', () => {
  const w = estimationWindowLive(parseIso('2026-10-30T08:15:00Z'), cfg);
  assert.equal(w.end, parseIso('2026-10-29T08:00:00Z'));
  assert.equal(w.start, parseIso('2026-09-29T08:00:00Z'));
  assert.equal(w.rule, 'live');
});

test('stablecoin: največji odmik od vezave v bazičnih točkah', () => {
  const t0 = Date.UTC(2022, 4, 9);
  const candles = [
    { t: t0 - HOUR, o: 1, h: 1.001, l: 0.999, c: 1, qv: 1 },
    { t: t0, o: 1, h: 1.0, l: 0.98, c: 0.99, qv: 1 },
    { t: t0 + HOUR, o: 0.99, h: 0.99, l: 0.65, c: 0.7, qv: 1 },
    { t: t0 + 100 * HOUR, o: 0.2, h: 0.2, l: 0.1, c: 0.1, qv: 1 }, // izven 72 h
  ];
  const d = maxDepegBps({ candles, peg: 1, t0Ms: t0, interval: '1h', hours: 72 });
  assert.ok(approx(d.maxDepegBps, 3500, 1e-9));
  assert.equal(d.maxDepegAt, '2022-05-09T01:00:00Z');
});

test('sektorski indeks: renormalizirane uteži', () => {
  const s = Date.UTC(2024, 0, 1);
  const m1 = makeCandles(s, HOUR, [0.02, 0.02]);
  const m2 = makeCandles(s, HOUR, [0.04]); // drugi član nima zadnje sveče
  const idx = sectorIndexCandles(
    [
      { candles: m1, weight: 1 },
      { candles: m2, weight: 1 },
    ],
    '1h',
  );
  assert.equal(idx.length, 3);
  assert.ok(approx(Math.log(idx[1].c / idx[0].c), 0.03), 'prva ura: (0,02 + 0,04)/2');
  assert.ok(approx(Math.log(idx[2].c / idx[1].c), 0.02), 'druga ura: samo prvi član');
});

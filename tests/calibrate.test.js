import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ranks, spearman } from '../collector/lib/stats.js';
import { nnls } from '../collector/lib/nnls.js';
import { calibrate } from '../scripts/calibrate.js';
import { approx, loadConfig } from './helpers.js';

const cfg = loadConfig();

test('Spearman: monotono, obratno, izenačenja (ročni izračun)', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.ok(approx(spearman([1, 2, 3, 4], [10, 30, 70, 80]), 1));
  assert.ok(approx(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1));
  // rangi x = [1, 2,5, 2,5, 4], y = [1, 3, 2, 4] → ρ = 4,5 / √(4,5 · 5)
  assert.ok(approx(spearman([1, 2, 2, 3], [1, 3, 2, 4]), 4.5 / Math.sqrt(22.5)));
  assert.equal(spearman([1, 2], [1, 2]), null, 'premalo točk');
});

test('NNLS: točna nenegativna rešitev in odrez negativnega koeficienta (ročni izračun)', () => {
  const X = [[1, 0, 2, 0, 1], [0, 1, 1, 1, 0], [2, 1, 0, 1, 1], [1, 1, 1, 0, 0], [0, 2, 1, 1, 2], [3, 0, 1, 2, 1]];
  const y = X.map((r) => 0.5 * r[0] + 0.3 * r[2]);
  const r = nnls(X, y);
  [0.5, 0, 0.3, 0, 0].forEach((w, i) => assert.ok(approx(r.weights[i], w, 1e-9) || Math.abs(r.weights[i] - w) < 1e-9, `w${i}`));
  // OLS bi dal [1, −1]; NNLS: {x1} → 0,5 (SSE 1,5) je najboljša dopustna rešitev
  const r2 = nnls([[1, 0], [0, 1], [1, 1]], [1, -1, 0]);
  assert.ok(approx(r2.weights[0], 0.5));
  assert.equal(r2.weights[1], 0);
  assert.ok(approx(r2.sse, 1.5));
});

function entry(i, comps, post) {
  return { id: `e${i}`, firstSeenAt: '2026-11-01T00:00:00Z', exAnte: { ...comps, raw: 100 * (0.3 * comps.T + 0.2 * comps.C + 0.1 * comps.Q + 0.15 * comps.S + 0.25 * comps.A), calibrated: true }, exPost: { raw: post, score: Math.round(post) } };
}

test('kalibracija: pod 50 potrjenih samo Spearman; od 50 naprej predlog NNLS, config nespremenjen', () => {
  const few = { entries: Array.from({ length: 10 }, (_, i) => entry(i, { T: 0.6, C: i / 10, Q: 0.7, S: 0.5, A: 0 }, 10 * i)) };
  const r1 = calibrate(few, cfg, Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(r1.n, 10);
  assert.equal(r1.spearman, 1);
  assert.equal(r1.proposal, null);
  assert.match(r1.reason, /10 < 50/);

  // 60 dogodkov, kjer je ExPost/100 = 0,8·C + 0,2·A (pravi model) → NNLS to najde
  const many = {
    entries: Array.from({ length: 60 }, (_, i) => {
      const c = { T: ((i * 7) % 10) / 10, C: ((i * 3) % 11) / 10, Q: [0.4, 0.7, 1][i % 3], S: ((i * 5) % 9) / 8, A: ((i * 2) % 7) / 6 };
      return entry(i, c, 100 * (0.8 * c.C + 0.2 * c.A));
    }),
  };
  const before = JSON.stringify(cfg.scoring.exAnteWeights);
  const r2 = calibrate(many, cfg, Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(r2.n, 60);
  assert.ok(approx(r2.proposal.raw.C, 0.8, 1e-3) && approx(r2.proposal.raw.A, 0.2, 1e-3));
  assert.equal(r2.proposal.raw.T, 0);
  assert.equal(r2.proposal.r2, 1);
  assert.ok(approx(r2.proposal.normalized.C + r2.proposal.normalized.A, 1, 1e-6));
  assert.equal(JSON.stringify(cfg.scoring.exAnteWeights), before, 'uteži se ne uveljavijo');
  assert.equal(calibrate(null, cfg, 0).n, 0);
});

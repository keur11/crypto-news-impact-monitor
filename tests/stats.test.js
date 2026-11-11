import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beta, clip, covariance, logReturn, mean, median, round, sampleStd, sampleVariance } from '../collector/lib/stats.js';
import { approx } from './helpers.js';

// Ročno izračunan primer:
// rb = [0,01; −0,02; 0,03; 0], ra = [0,02; −0,03; 0,05; 0,01]
// Σ(dev_b·dev_a) = 0,00205; Σ dev_b² = 0,0013  →  β = 0,00205 / 0,0013 = 41/26
const rb = [0.01, -0.02, 0.03, 0.0];
const ra = [0.02, -0.03, 0.05, 0.01];

test('mean, vzorčna varianca in kovarianca', () => {
  assert.ok(approx(mean(rb), 0.005));
  assert.ok(approx(sampleVariance(rb), 0.0013 / 3));
  assert.ok(approx(covariance(ra, rb), 0.00205 / 3));
  assert.equal(sampleVariance([1]), null);
  assert.equal(mean([]), null);
});

test('β = Cov(ra, rb) / Var(rb) = 41/26', () => {
  assert.ok(approx(beta(ra, rb), 41 / 26));
  assert.equal(beta([1, 2], [3, 3]), null, 'Var(rb) = 0 vrne null');
});

test('σ abnormalnih donosov iz ročnega primera', () => {
  // AR = ra − β·rb = [0,11; 0,04; 0,07; 0,26] / 26
  // povprečje 0,12/26, odkloni [−0,01; −0,08; −0,05; 0,14]/26, Σ kvadratov = 0,0286/26²
  const b = beta(ra, rb);
  const ar = ra.map((r, i) => r - b * rb[i]);
  assert.ok(approx(ar[0], 0.11 / 26));
  assert.ok(approx(ar[3], 0.01));
  assert.ok(approx(sampleStd(ar), Math.sqrt(0.0286 / 3) / 26));
  assert.ok(approx(sampleStd(ar), 0.0037553, 1e-4));
});

test('mediana, clip, logReturn, round', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, 5, NaN]), 5);
  assert.equal(median([]), null);
  assert.equal(clip(5, 0, 3), 3);
  assert.equal(clip(-1, 0, 3), 0);
  assert.ok(approx(logReturn(100, 110), Math.log(1.1)));
  assert.throws(() => logReturn(0, 1));
  assert.equal(round(1.23456789, 4), 1.2346);
  assert.equal(round(-0.0000001, 4), 0);
  assert.equal(round(null), null);
});

test('neveljavni vhodi', () => {
  assert.throws(() => covariance([1, 2], [1]));
  assert.throws(() => sampleVariance([1, NaN]));
});

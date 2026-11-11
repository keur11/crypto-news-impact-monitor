#!/usr/bin/env node
// Kalibracija (varovalka 6.5.4): Spearmanova korelacija ExAnte proti ExPost na potrjenih dogodkih iz arhiva.
// Ko je potrjenih ≥ minConfirmed, predlaga uteži z nenegativno regresijo (NNLS) ExPost/100 ~ T, C, Q, S, A.
// Predlog se zapiše v data/calibration.json in se NIKOLI ne uveljavi samodejno (config ostane nespremenjen).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { round, spearman } from '../collector/lib/stats.js';
import { nnls } from '../collector/lib/nnls.js';
import { toIso } from '../collector/lib/time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENTS = ['T', 'C', 'Q', 'S', 'A'];

export function calibrate(archive, cfg, nowMs) {
  const rows = (archive?.entries ?? []).filter(
    (x) => x.exPost && Number.isFinite(x.exPost.raw ?? x.exPost.score) && x.exAnte && COMPONENTS.every((k) => Number.isFinite(x.exAnte[k])),
  );
  const n = rows.length;
  const exAnte = rows.map((x) => x.exAnte.raw ?? x.exAnte.score);
  const exPost = rows.map((x) => x.exPost.raw ?? x.exPost.score);
  const rho = spearman(exAnte, exPost);
  const out = {
    computedAt: toIso(nowMs),
    n,
    nCalibratedExAnte: rows.filter((x) => x.exAnte.calibrated).length,
    spearman: rho === null ? null : round(rho, 4),
    currentWeights: cfg.scoring.exAnteWeights,
    minConfirmed: cfg.calibration.minConfirmed,
    proposal: null,
    note: 'Predlog se ne uveljavi samodejno. Uteži v config.json spremeni ročno po pregledu.',
  };
  if (n < cfg.calibration.minConfirmed) {
    out.reason = `potrjenih dogodkov ${n} < ${cfg.calibration.minConfirmed}; predlog uteži ni izračunan`;
    return out;
  }
  const X = rows.map((x) => COMPONENTS.map((k) => x.exAnte[k]));
  const y = exPost.map((v) => v / 100);
  const { weights, sse } = nnls(X, y);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const sum = weights.reduce((s, w) => s + w, 0);
  out.proposal = {
    method: 'NNLS brez presečišča: ExPost/100 ~ w·[T, C, Q, S, A], w ≥ 0',
    raw: Object.fromEntries(COMPONENTS.map((k, i) => [k, round(weights[i], 4)])),
    normalized: sum > 0 ? Object.fromEntries(COMPONENTS.map((k, i) => [k, round(weights[i] / sum, 4)])) : null,
    r2: sst > 0 ? round(1 - sse / sst, 4) : null,
  };
  return out;
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/config.json'), 'utf8'));
  let archive = null;
  try {
    archive = JSON.parse(await fs.readFile(path.join(ROOT, cfg.paths.archive), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const res = calibrate(archive, cfg, Date.now());
  await fs.mkdir(path.dirname(path.join(ROOT, cfg.paths.calibration)), { recursive: true });
  await fs.writeFile(path.join(ROOT, cfg.paths.calibration), `${JSON.stringify(res, null, 2)}\n`);
  console.log(`Potrjenih: ${res.n}, Spearman ρ(ExAnte, ExPost) = ${res.spearman ?? '—'}`);
  console.log(res.proposal ? `Predlog uteži (normirano): ${JSON.stringify(res.proposal.normalized)}, R² = ${res.proposal.r2}` : res.reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}

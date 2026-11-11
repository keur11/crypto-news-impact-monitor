#!/usr/bin/env node
// data/bundle.js: vsi podatki za dashboard v eni skripti (window.__DATA__), da index.html deluje tudi
// prek file:// (brskalniki tam ne dovolijo fetch lokalnih JSON datotek).
// Kliče se na koncu teka zbiralnika in backfilla; ročno: npm run bundle.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact, secretValues } from './lib/redact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Podmnožica configa, ki jo potrebuje vmesnik (brez skrivnosti in notranjih nastavitev). */
export function uiConfig(cfg) {
  return {
    version: cfg.app.version,
    sectors: cfg.sectors.list.map((s) => ({ id: s.id, name: s.name })),
    types: [...cfg.classification.priority, 'other'],
    colorThresholds: cfg.scoring.colorThresholds,
    staleRunHours: cfg.status.staleRunHours,
    exAnteWeights: cfg.scoring.exAnteWeights,
    finalWeights: cfg.scoring.finalWeights,
    novelty: cfg.stories.novelty,
    sources: cfg.sources.map((s) => ({ id: s.id, name: s.name, url: s.url, tier: s.tier, official: Boolean(s.official), enabled: s.enabled })),
    actors: Object.fromEntries((cfg.actors ?? []).map((a) => [a.id, a.label])),
  };
}

export async function buildBundle(cfg, { root = ROOT, env = process.env, nowIso = new Date().toISOString() } = {}) {
  const p = (rel) => path.join(root, rel);
  const status = await readJson(p(cfg.paths.status));
  const events = (await readJson(p(cfg.paths.events)))?.events ?? [];
  const stories = (await readJson(p(cfg.paths.stories)))?.stories ?? [];
  const library = await readJson(p(cfg.paths.libraryOutput));
  const libraryInput = library ? null : await readJson(p(cfg.paths.libraryInput));
  const series = {};
  try {
    for (const f of await fs.readdir(p(cfg.paths.seriesDir))) {
      if (f.endsWith('.json')) series[f.replace(/\.json$/, '')] = await readJson(p(path.join(cfg.paths.seriesDir, f)));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Članki v dogodku: vmesnik potrebuje naslov, vir, povezavo in čas; povzetki niso potrebni.
  const slimEvents = events.map((e) => ({ ...e, articleIds: undefined }));
  const data = {
    generatedAt: nowIso,
    config: uiConfig(cfg),
    status,
    events: slimEvents,
    stories,
    library: library ?? null,
    libraryInput: libraryInput ?? null,
    librarySeries: series,
  };
  const safe = redact(data, secretValues(cfg, env));
  const js = `// Samodejno ustvarjeno (${nowIso}). Ne urejaj ročno – npm run bundle.\nwindow.__DATA__ = ${JSON.stringify(safe)};\n`;
  await fs.mkdir(path.dirname(p(cfg.paths.bundle)), { recursive: true });
  await fs.writeFile(p(cfg.paths.bundle), js);
  return { bytes: Buffer.byteLength(js), events: events.length, stories: stories.length };
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/config.json'), 'utf8'));
  const r = await buildBundle(cfg);
  console.log(`data/bundle.js: ${r.events} dogodkov, ${r.stories} zgodb, ${(r.bytes / 1024).toFixed(1)} KiB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}

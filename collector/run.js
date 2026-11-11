#!/usr/bin/env node
// Zbiralnik: en tek. Bere in piše data/*.json. Izpad posameznega vira ne ustavi teka (napaka gre v status.json).
// Izhodna koda: 0 = tek končan (tudi z napakami virov), 1 = usodna napaka (config, zapis datotek).
// Koda 2 (kriterij knjižnice) je rezervirana za ročni backfill in je zbiralnik nikoli ne vrne.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from './lib/http.js';
import { toIso } from './lib/time.js';
import { runCollector } from './pipeline.js';
import { createPriceStore } from './prices.js';
import { buildBundle } from './bundle.js';
import { redact, secretValues } from './lib/redact.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${path.relative(ROOT, file)}: ${err.message}`);
  }
}

export async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export async function runOnce({ root = ROOT, cfg, http, nowMs = Date.now(), env = process.env, market = true }) {
  const p = (rel) => path.join(root, rel);
  const readErrors = [];
  const safeRead = async (rel, fallback) => {
    try {
      return await readJson(p(rel), fallback);
    } catch (err) {
      readErrors.push(`branje ${rel}: ${err.message}`);
      return fallback;
    }
  };

  const articlesDoc = await safeRead(cfg.paths.articles, null);
  const eventsDoc = await safeRead(cfg.paths.events, null);
  const state = {
    articles: articlesDoc?.articles ?? [],
    events: eventsDoc?.events ?? [],
    sectors: await safeRead(cfg.paths.sectors, null),
    sectorsHistory: await safeRead(cfg.paths.sectorsHistory, null),
    marketState: await safeRead(cfg.paths.marketState, null),
    archive: await safeRead(cfg.paths.archive, null),
    stories: await safeRead(cfg.paths.stories, null),
    keepalive: await safeRead(cfg.paths.keepalive, null),
    prevStatus: await safeRead(cfg.paths.status, null),
    library: await safeRead(cfg.paths.libraryOutput, null),
    libraryInput: await safeRead(cfg.paths.libraryInput, null),
  };

  // Ura teka je tudi meja zaprtih sveč (nobena sveča po nowMs).
  const store = market ? createPriceStore({ http, cfg, cacheDir: p(cfg.cache.dir), now: () => nowMs }) : null;
  const res = await runCollector({ cfg, http, nowMs, env, state, store });
  res.status.errors.unshift(...readErrors);
  res.status.finishedAt = toIso(Date.now());
  res.status.durationMs = Date.now() - nowMs;
  res.status.httpCalls = http.stats();

  const generatedAt = toIso(nowMs);
  // Vsi zapisi gredo skozi maskiranje skrivnosti (artifacti in veja data so javni).
  const secrets = secretValues(cfg, env);
  const out = async (rel, obj) => writeJson(p(rel), redact(obj, secrets));
  await out(cfg.paths.articles, { generatedAt, retentionDays: cfg.retention.articleDays, articles: res.articles });
  await out(cfg.paths.events, { generatedAt, events: res.events });
  if (res.sectors) await out(cfg.paths.sectors, res.sectors);
  if (res.sectorsHistory) await out(cfg.paths.sectorsHistory, res.sectorsHistory);
  if (res.archive) await out(cfg.paths.archive, res.archive);
  if (res.marketState) await out(cfg.paths.marketState, res.marketState);
  if (res.stories) await out(cfg.paths.stories, res.stories);
  await out(cfg.paths.status, res.status);
  await buildBundle(cfg, { root, env, nowIso: toIso(nowMs) });
  return res;
}

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/config.json'), 'utf8'));
  const http = createHttpClient(cfg);
  const res = await runOnce({ cfg, http });
  const s = redact(res.status, secretValues(cfg));
  const srcLine = Object.entries(s.sources)
    .filter(([, v]) => v.enabled)
    .map(([k, v]) => `${k}:${v.ok ? `ok(${v.items}/${v.new} novih)` : v.skipped ? 'preskočen' : 'NAPAKA'}`)
    .join(' ');
  console.log(`Tek ${s.runAt}: ${s.articles.new} novih člankov, ${s.events.new} novih dogodkov, ${s.events.total} skupaj; ${s.durationMs} ms`);
  console.log(`Viri: ${srcLine}`);
  console.log(`Klici: ${JSON.stringify(s.httpCalls)}`);
  for (const w of s.warnings) console.log(`Opozorilo: ${w}`);
  for (const e of s.errors) console.log(`Napaka: ${e}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}

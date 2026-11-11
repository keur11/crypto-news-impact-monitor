#!/usr/bin/env node
// Enkratni izračun tržnega vpliva za referenčno knjižnico.
//   Vhod:  config/library.json (samo ročni vnos)
//   Izhod: data/library.json (vnos + measured + refs), data/series/{id}.json, data/backfill-log.json
// Ponovni zagon da enak data/library.json in data/series/*, ker so pretekli meseci cen v trajnem predpomnilniku.
//
// Uporaba: node scripts/backfill-library.js [--offline]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY, HOUR, floorTo, intervalMs, parseIso, toIso } from '../collector/lib/time.js';
import { round } from '../collector/lib/stats.js';
import { closeSeries, maxDepegBps, measureImpact } from '../collector/market.js';
import {
  computeRefs,
  evaluateLargestImpact,
  libraryEstimationWindow,
  validateLibrary,
  windowToIso,
} from '../collector/library.js';
import { createHttpClient } from '../collector/lib/http.js';
import { createPriceStore, sourceLabel } from '../collector/prices.js';
import { redact, redactString, secretValues } from '../collector/lib/redact.js';
import { buildBundle } from '../collector/bundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const METRIC_KEYS = ['beta', 'sigma', 'ar1', 'ar24', 'ar72', 'z1', 'z24', 'z72', 'V', 'volumeFactor', 'M24', 'M72'];

function roundMetrics(res) {
  const out = {};
  for (const k of METRIC_KEYS) out[k] = round(res[k] ?? null, 6);
  return out;
}

function roundCoverage(cov) {
  return Object.fromEntries(Object.entries(cov).map(([k, v]) => [k, round(v, 4)]));
}

export async function measureEvent(entry, cfg, store) {
  const m = cfg.market;
  const t0 = parseIso(entry.t0);
  const estHourly = libraryEstimationWindow(entry, cfg, HOUR);
  const c0h = floorTo(t0, HOUR);
  const fetchFrom = Math.min(estHourly.start, t0 - m.libraryFetchBeforeDays * DAY) - DAY;
  const fetchTo = floorTo(t0, DAY) + (Math.max(m.libraryFetchAfterDays, 3) + 1) * DAY;
  const eventCheck = { name: 'event', start: c0h, end: c0h + 72 * HOUR, min: m.minCoverage.event };
  const estCheck = { name: 'estimation', start: estHourly.start, end: estHourly.end, min: m.minCoverage.estimation };

  const assets = {};
  const series = {};

  for (const asset of entry.assets) {
    const assetCfg = cfg.assets[asset];
    if (!assetCfg) {
      assets[asset] = { status: 'skipped', reason: `sredstvo ni opredeljeno v config.assets` };
      continue;
    }

    if (assetCfg.isStablecoin) {
      const depegCheck = { name: 'event', start: c0h, end: c0h + m.depegWindowHours * HOUR, min: m.minCoverage.event };
      const r = await store.resolveSeries(asset, { fetchFrom, fetchTo, checks: [depegCheck] });
      if (!r.chosen) {
        assets[asset] = { status: 'skipped', isStablecoin: true, reason: 'ni ustreznega vira cen', attempts: r.attempts };
        continue;
      }
      const d = maxDepegBps({ candles: r.candles, peg: assetCfg.peg ?? 1, t0Ms: t0, interval: r.chosen.interval, hours: m.depegWindowHours });
      assets[asset] = {
        status: 'info',
        isStablecoin: true,
        excludedFromM: true,
        source: sourceLabel(r.chosen),
        sourceNote: r.chosen.note ?? null,
        resolution: r.chosen.interval,
        peg: assetCfg.peg ?? 1,
        maxDepegBps: round(d.maxDepegBps, 1),
        maxDepegAt: d.maxDepegAt,
        coverage: { event: round(d.coverage, 4) },
      };
      series[asset] = { interval: r.chosen.interval, points: closeSeries(r.candles, t0 - m.seriesWindowDays * DAY, t0 + m.seriesWindowDays * DAY) };
      continue;
    }

    const r = await store.resolveSeries(asset, { fetchFrom, fetchTo, checks: [estCheck, eventCheck] });
    if (!r.chosen) {
      assets[asset] = { status: 'skipped', reason: 'ni ustreznega vira cen s potrebno pokritostjo', attempts: r.attempts };
      continue;
    }
    const interval = r.chosen.interval;
    const step = intervalMs(interval);
    const est = libraryEstimationWindow(entry, cfg, step);

    let bench = null;
    if (asset !== m.benchmark) {
      const b = await store.resolveSeries(m.benchmark, { fetchFrom, fetchTo, checks: [estCheck, eventCheck] }, { interval });
      if (!b.chosen) {
        assets[asset] = { status: 'skipped', reason: `ni merila ${m.benchmark} v intervalu ${interval}`, attempts: b.attempts };
        continue;
      }
      bench = b;
    }

    const res = measureImpact({
      assetCandles: r.candles,
      benchCandles: bench ? bench.candles : null,
      interval,
      t0Ms: t0,
      t0Precision: entry.t0Precision,
      estWindow: est,
      cfg,
    });
    if (res.status !== 'ok') {
      assets[asset] = { status: 'skipped', reason: res.reason, source: sourceLabel(r.chosen) };
      continue;
    }

    assets[asset] = {
      status: 'ok',
      source: sourceLabel(r.chosen),
      sourceNote: r.chosen.note ?? null,
      benchmarkSource: bench ? sourceLabel(bench.chosen) : null,
      resolution: interval,
      estimationWindow: windowToIso(est),
      nEstimationReturns: res.estimation.nReturns,
      eventStart: res.eventStart,
      coverage: roundCoverage(res.coverage),
      ...roundMetrics(res),
      direction: res.direction,
      notes: res.notes,
    };
    series[asset] = { interval, points: closeSeries(r.candles, t0 - m.seriesWindowDays * DAY, t0 + m.seriesWindowDays * DAY) };
  }

  const primary = assets[entry.primaryAsset];
  const ok = primary?.status === 'ok';
  const measured = {
    estimationWindow: windowToIso(estHourly),
    primaryAsset: entry.primaryAsset,
    primaryStatus: primary?.status ?? 'skipped',
    primaryReason: ok ? null : (primary?.reason ?? 'ni podatkov'),
    M24: ok ? primary.M24 : null,
    M72: ok ? primary.M72 : null,
    AR24: ok ? primary.ar24 : null,
    AR72: ok ? primary.ar72 : null,
    direction: ok ? primary.direction : null,
    assets,
  };
  return { measured, series };
}

export async function runBackfill({ cfg, library, store }) {
  validateLibrary(library);
  const events = [];
  const seriesById = {};
  for (const entry of library) {
    const { measured, series } = await measureEvent(entry, cfg, store);
    events.push({ ...entry, measured });
    seriesById[entry.id] = { id: entry.id, t0: entry.t0, assets: series };
  }

  const refs = computeRefs(events);
  for (const e of events) {
    e.measured.relative = {
      M24: e.measured.M24 !== null && refs.M_ref24 ? round(e.measured.M24 / refs.M_ref24, 4) : null,
      M72: e.measured.M72 !== null && refs.M_ref72 ? round(e.measured.M72 / refs.M_ref72, 4) : null,
    };
  }
  refs.M_ref24 = round(refs.M_ref24, 6);
  refs.M_ref72 = round(refs.M_ref72, 6);

  const acceptance = {
    largestImpact: evaluateLargestImpact(events, cfg.acceptance.largestImpact),
    informativeZ24: cfg.acceptance.informativeZ24.map(({ event, asset }) => {
      const a = events.find((e) => e.id === event)?.measured.assets[asset];
      return { event, asset, z24: a?.status === 'ok' ? a.z24 : null, status: a?.status ?? 'missing' };
    }),
  };

  const libraryOut = {
    schema: 1,
    params: {
      estimationDays: cfg.market.estimationDays,
      estimationGapDays: cfg.market.estimationGapDays,
      estimationRule: 'knjižnica: do estimationGapDays pred prvim mejnikom ali sočasnim dejavnikom pred t0',
      windowsHours: cfg.market.windowsHours,
      mWeights: cfg.market.mWeights,
      volumeFactor: cfg.market.volumeFactor,
      M24: '|z24| · f(V)',
      M72: '(w24·|z24| + w72·|z72|) · f(V)',
    },
    refs,
    acceptance,
    events,
  };
  return { libraryOut, seriesById };
}

// ---------- izpis ----------

function fmt(x, digits = 2) {
  if (x === null || x === undefined) return '—';
  return x.toFixed(digits).replace('.', ',');
}

export function formatTable(libraryOut) {
  const pct = (x) => (x === null || x === undefined ? '—' : `${fmt(x * 100, 1)} %`);
  const rows = [['dogodek', 'sredstvo', 'vir', 'int', 'β', 'AR24', 'AR72', 'z1', 'z24', 'z72', 'V', 'M24', 'M72', 'smer', 'opomba']];
  for (const e of libraryOut.events) {
    for (const [asset, a] of Object.entries(e.measured.assets)) {
      const tag = asset === e.primaryAsset ? `${asset}*` : asset;
      if (a.status === 'ok') {
        rows.push([
          e.id, tag, a.source, a.resolution, fmt(a.beta), pct(a.ar24), pct(a.ar72), fmt(a.z1), fmt(a.z24), fmt(a.z72),
          fmt(a.V), fmt(a.M24), fmt(a.M72), a.direction === -1 ? '▼' : a.direction === 1 ? '▲' : '·', '',
        ]);
      } else if (a.status === 'info') {
        rows.push([e.id, tag, a.source, a.resolution, '', '', '', '', '', '', '', '', '', '', `stablecoin: max odmik ${fmt(a.maxDepegBps, 0)} bt`]);
      } else {
        rows.push([e.id, tag, a.source ?? '—', '', '', '', '', '', '', '', '', '', '', '', `IZPUŠČENO: ${a.reason}`]);
      }
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  const lines = rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
  lines.splice(1, 0, widths.map((w) => '-'.repeat(w)).join('  '));

  const { refs, acceptance } = libraryOut;
  lines.push('');
  lines.push(`* primarno sredstvo dogodka; AR v log točkah (×100)`);
  lines.push(`M_ref24 = ${fmt(refs.M_ref24)} (n = ${refs.n24}),  M_ref72 = ${fmt(refs.M_ref72)} (n = ${refs.n72})`);
  lines.push(`Kriterij (največji vpliv): ${acceptance.largestImpact.result.toUpperCase()} — ${acceptance.largestImpact.detail}`);
  for (const x of acceptance.informativeZ24) {
    lines.push(`Informativno: ${x.event} / ${x.asset}: z24 = ${fmt(x.z24)} (${x.status})`);
  }
  return lines.join('\n');
}

export function formatSkipped(libraryOut) {
  const out = [];
  for (const e of libraryOut.events) {
    for (const [asset, a] of Object.entries(e.measured.assets)) {
      if (a.status !== 'skipped') continue;
      out.push(`${e.id} / ${asset}: ${a.reason}`);
      for (const t of a.attempts ?? []) {
        out.push(`    ${t.source ?? ''}: ${t.reason}${t.coverage ? ` ${JSON.stringify(t.coverage)}` : ''}`);
        for (const err of t.errors ?? []) out.push(`        ${err}`);
      }
    }
  }
  return out.join('\n');
}

export async function writeOutputs({ libraryOut, seriesById }, cfg, root = ROOT) {
  const libPath = path.join(root, cfg.paths.libraryOutput);
  await fs.mkdir(path.dirname(libPath), { recursive: true });
  await fs.writeFile(libPath, `${JSON.stringify(redact(libraryOut, secretValues(cfg)), null, 2)}\n`);
  const seriesDir = path.join(root, cfg.paths.seriesDir);
  await fs.mkdir(seriesDir, { recursive: true });
  for (const [id, s] of Object.entries(seriesById)) {
    await fs.writeFile(path.join(seriesDir, `${id}.json`), `${JSON.stringify(s)}\n`);
  }
}

async function main() {
  const offline = process.argv.includes('--offline');
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/config.json'), 'utf8'));
  const library = JSON.parse(await fs.readFile(path.join(ROOT, cfg.paths.libraryInput), 'utf8'));
  const http = offline ? null : createHttpClient(cfg);
  const store = createPriceStore({ http, cfg, cacheDir: path.join(ROOT, cfg.cache.dir), offline });

  const startedAt = Date.now();
  const result = await runBackfill({ cfg, library, store });
  await writeOutputs(result, cfg);

  const log = {
    runAt: toIso(startedAt),
    durationMs: Date.now() - startedAt,
    offline,
    httpCallsByProvider: http ? http.stats() : {},
    priceStore: store.stats(),
    acceptance: result.libraryOut.acceptance,
  };
  const secrets = secretValues(cfg);
  await fs.writeFile(path.join(ROOT, cfg.paths.backfillLog), `${JSON.stringify(redact(log, secrets), null, 2)}\n`);

  await buildBundle(cfg); // vmesnik takoj vidi izmerjeno knjižnico
  const print = (s) => console.log(redactString(s, secrets));
  print(formatTable(result.libraryOut));
  const skipped = formatSkipped(result.libraryOut);
  if (skipped) print(`\nIzpuščena sredstva:\n${skipped}`);
  print(`\nKlici po virih: ${JSON.stringify(log.httpCallsByProvider)}; predpomnilnik: ${JSON.stringify(log.priceStore)}`);

  // Izhodna koda 2 samo za ročni backfill. Zbiralnik (cron) knjižnice ne preverja in te kode nikoli ne vrne.
  if (result.libraryOut.acceptance.largestImpact.result === 'fail') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}

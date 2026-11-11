// Cenovne serije s trajnim predpomnilnikom po koledarskih mesecih in razreševanjem virov.
//
// Vir (iz config.assets[X].sources):
//   { provider: 'binanceApi' | 'binanceArchive' | 'bitstamp', symbol | pair, interval,
//     validFrom?, validTo?, note? }
// validFrom je vključujoč, validTo izključujoč (ISO). Sveče izven obdobja se zavržejo,
// npr. ko je bil ticker kasneje prenesen na drug žeton (LUNA → nova veriga).

import fs from 'node:fs/promises';
import path from 'node:path';
import { intervalMs, monthsBetween, parseIso } from './lib/time.js';
import { fetchApiRange, fetchArchiveMonth } from './sources/binance.js';
import { fetchRange as fetchBitstampRange } from './sources/bitstamp.js';

export function sourceLabel(s) {
  return `${s.provider}:${s.symbol ?? s.pair}:${s.interval}`;
}

function toRow(k) {
  return [k.t, k.o, k.h, k.l, k.c, k.v, k.qv];
}
function fromRow(r) {
  return { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], qv: r[6] };
}

export function createPriceStore({ http, cfg, cacheDir, now = Date.now, offline = false }) {
  const stats = { cacheHits: 0, memoryHits: 0, fetched: 0, errors: 0 };
  // Tekoči mesec se ne shrani trajno; v istem teku ga ne beremo dvakrat.
  const memory = new Map();

  function cachePath(source, monthKey) {
    return path.join(cacheDir, source.provider, String(source.symbol ?? source.pair), source.interval, `${monthKey}.json`);
  }

  async function readCache(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeCache(file, obj) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj));
    await fs.rename(tmp, file);
  }

  async function fetchMonth(source, month) {
    const end = Math.min(month.end, now());
    switch (source.provider) {
      case 'binanceApi':
        return fetchApiRange(http, cfg, source, month.start, end);
      case 'binanceArchive':
        return fetchArchiveMonth(http, cfg, source, month.key);
      case 'bitstamp':
        return fetchBitstampRange(http, cfg, source, month.start, end);
      default:
        throw new Error(`Neznan ponudnik cen: ${source.provider}`);
    }
  }

  async function getCandles(source, fromMs, toMs) {
    const errors = [];
    const statuses = [];
    let candles = [];
    for (const month of monthsBetween(fromMs, toMs)) {
      const file = cachePath(source, month.key);
      let entry = memory.get(file) ?? null;
      if (entry?.status === 'error') {
        // napaka v istem teku se ne ponavlja
        errors.push(`${month.key}: ${entry.error}`);
        statuses.push('error');
        continue;
      } else if (entry) {
        stats.memoryHits++;
      } else if ((entry = await readCache(file))) {
        stats.cacheHits++;
      } else if (offline || !http) {
        errors.push(`${month.key}: ni v predpomnilniku (način brez omrežja)`);
        statuses.push('error');
        continue;
      } else {
        try {
          const res = await fetchMonth(source, month);
          stats.fetched++;
          entry = { source: sourceLabel(source), month: month.key, status: res.status, candles: res.candles.map(toRow) };
          // Pretekli meseci se ne spreminjajo: shranimo trajno. Tekoči mesec samo v pomnilnik teka.
          if (month.end + cfg.cache.immutableAfterMs <= now()) await writeCache(file, entry);
          else memory.set(file, entry);
        } catch (err) {
          stats.errors++;
          memory.set(file, { status: 'error', error: err.message });
          errors.push(`${month.key}: ${err.message}`);
          statuses.push('error');
          continue;
        }
      }
      statuses.push(entry.status);
      if (entry.status === 'ok') candles.push(...entry.candles.map(fromRow));
    }

    const lo = Math.max(fromMs, source.validFrom ? parseIso(source.validFrom) : -Infinity);
    const hi = Math.min(toMs, source.validTo ? parseIso(source.validTo) : Infinity);
    // Samo zaprte sveče: odprta sveča bi pomenila delni (in kasneje spremenjen) podatek.
    const step = intervalMs(source.interval);
    const closedBy = now();
    candles = candles.filter((k) => k.t >= lo && k.t < hi && k.t + step <= closedBy);

    let status = 'error';
    if (statuses.includes('ok')) status = 'ok';
    else if (statuses.length && statuses.every((s) => s === 'not_found')) status = 'not_found';
    return { status, candles, errors };
  }

  function coverage(candles, start, end, step) {
    if (end <= start) return 1;
    const expected = Math.round((end - start) / step);
    const have = new Set(candles.filter((k) => k.t >= start && k.t < end).map((k) => k.t)).size;
    return have / expected;
  }

  /**
   * Izbere prvi vir, ki pokrije potrebna okna.
   * need = { fetchFrom, fetchTo, checks: [{ name, start, end, min }] }
   * opts.interval omeji izbiro na določen interval (za merilo BTC).
   */
  async function resolveSeries(assetKey, need, opts = {}) {
    const assetCfg = cfg.assets[assetKey];
    if (!assetCfg) return { chosen: null, candles: [], attempts: [{ reason: `sredstvo ${assetKey} ni v config.assets` }] };
    const attempts = [];
    const needStart = Math.min(...need.checks.map((c) => c.start));
    const needEnd = Math.max(...need.checks.map((c) => c.end));
    for (const source of assetCfg.sources) {
      if (opts.interval && source.interval !== opts.interval) continue;
      const label = sourceLabel(source);
      if (source.validFrom && parseIso(source.validFrom) > needStart) {
        attempts.push({ source: label, reason: `vir veljaven šele od ${source.validFrom}` });
        continue;
      }
      if (source.validTo && parseIso(source.validTo) < needEnd) {
        attempts.push({ source: label, reason: `vir veljaven le do ${source.validTo}` });
        continue;
      }
      const step = intervalMs(source.interval);
      const res = await getCandles(source, need.fetchFrom, need.fetchTo);
      if (res.status !== 'ok') {
        attempts.push({ source: label, reason: res.status === 'not_found' ? 'ni podatkov pri viru' : 'napaka', errors: res.errors });
        continue;
      }
      const cov = {};
      let ok = true;
      for (const c of need.checks) {
        cov[c.name] = coverage(res.candles, c.start, c.end, step);
        if (cov[c.name] < c.min) ok = false;
      }
      if (!ok) {
        attempts.push({ source: label, reason: 'premajhna pokritost', coverage: cov, errors: res.errors });
        continue;
      }
      attempts.push({ source: label, reason: 'izbran', coverage: cov, errors: res.errors });
      return { chosen: source, candles: res.candles, attempts };
    }
    return { chosen: null, candles: [], attempts };
  }

  return { getCandles, resolveSeries, stats: () => ({ ...stats }) };
}

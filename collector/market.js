// Merjenje tržnega vpliva (poglavje 6.1) in pomožne funkcije za cenovne serije.
//
// Sveča: { t, o, h, l, c, v, qv }  (t = čas odprtja v ms UTC, qv = volumen v kotacijski valuti)
// Donos sveče k: r_k = ln(c_k / c_prev), kjer je prev zadnja razpoložljiva sveča pred k.
// Okno dogodka: h donosov sveč z odprtjem v [c0, c0 + h), c0 = sveča, ki vsebuje t0.

import { HOUR, DAY, floorTo, intervalMs, toIso } from './lib/time.js';
import { beta as betaFn, sampleStd, sum, clip, logReturn } from './lib/stats.js';

export function normalizeCandles(candles) {
  const byT = new Map();
  for (const k of candles) {
    if (!Number.isFinite(k.t) || !(k.c > 0)) continue;
    byT.set(k.t, k);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function candleReturns(candles, stepMs) {
  const out = new Map();
  let prev = null;
  for (const k of candles) {
    if (prev) {
      out.set(k.t, {
        t: k.t,
        r: logReturn(prev.c, k.c),
        qv: Number.isFinite(k.qv) ? k.qv : 0,
        // Število manjkajočih sveč med prejšnjo in to; donos jih zajame v celoti.
        gapCandles: Math.round((k.t - prev.t) / stepMs) - 1,
      });
    }
    prev = k;
  }
  return out;
}

function windowKeys(start, end, step) {
  const keys = [];
  for (let t = start; t < end; t += step) keys.push(t);
  return keys;
}

// Ocenjevalno okno za žive dogodke: [t − 30 d − 1 d, t − 1 d), poravnano na svečo.
export function estimationWindowLive(tMs, cfg, stepMs = HOUR) {
  const m = cfg.market;
  const end = floorTo(tMs, stepMs) - m.estimationGapDays * DAY;
  return { start: end - m.estimationDays * DAY, end, rule: 'live' };
}

export function volumeFactor(V, cfg) {
  const f = cfg.market.volumeFactor;
  if (V === null || !(V > 0)) return 1;
  return 1 + f.k * clip(Math.log2(V), f.clipMin, f.clipMax);
}

export function magnitudeM24(z24, vf) {
  return z24 === null ? null : Math.abs(z24) * vf;
}

export function magnitudeM72(z24, z72, vf, cfg) {
  if (z24 === null || z72 === null) return null;
  const w = cfg.market.mWeights;
  return (w.z24 * Math.abs(z24) + w.z72 * Math.abs(z72)) * vf;
}

/**
 * Izmeri tržni vpliv za eno sredstvo.
 * benchCandles = null pomeni, da je sredstvo samo merilo (BTC): β = 0, AR = surovi donos.
 * asOfMs: okna, ki se do tega trenutka še niso iztekla (zadnja sveča ni zaprta), se ne računajo.
 */
export function measureImpact({ assetCandles, benchCandles = null, interval, t0Ms, t0Precision, estWindow, cfg, asOfMs = Infinity }) {
  const m = cfg.market;
  const step = intervalMs(interval);
  const stepHours = step / HOUR;
  const notes = [];

  const aRet = candleReturns(normalizeCandles(assetCandles), step);
  const bRet = benchCandles ? candleReturns(normalizeCandles(benchCandles), step) : null;

  // --- Ocenjevalno okno ---
  const estKeys = windowKeys(estWindow.start, estWindow.end, step);
  const estA = [];
  const estB = [];
  const estQv = [];
  for (const t of estKeys) {
    const a = aRet.get(t);
    if (!a) continue;
    if (bRet) {
      const b = bRet.get(t);
      if (!b) continue;
      estB.push(b.r);
    }
    estA.push(a.r);
    estQv.push(a.qv);
  }
  const estCoverage = estKeys.length ? estA.length / estKeys.length : 0;
  const base = { interval, estimation: { nReturns: estA.length, coverage: estCoverage } };

  const minN = m.minEstimationReturns[interval];
  if (estA.length < minN || estCoverage < m.minCoverage.estimation) {
    return {
      ...base,
      status: 'insufficient_estimation',
      reason: `ocenjevalno okno: ${estA.length} donosov, pokritost ${(estCoverage * 100).toFixed(1)} % (zahtevano ≥ ${minN} in ≥ ${m.minCoverage.estimation * 100} %)`,
    };
  }

  let b = 0;
  if (bRet) {
    b = betaFn(estA, estB);
    if (b === null) {
      return { ...base, status: 'insufficient_estimation', reason: 'varianca donosov BTC v ocenjevalnem oknu je 0' };
    }
  } else {
    notes.push('β = 0 (sredstvo je merilo BTC, surovi donos)');
  }

  const estAR = estA.map((r, i) => r - b * (bRet ? estB[i] : 0));
  const sigma = sampleStd(estAR);
  if (!(sigma > 0)) {
    return { ...base, status: 'zero_sigma', reason: 'σ abnormalnih donosov v ocenjevalnem oknu je 0' };
  }
  const estVolTotal = sum(estQv);
  const avgDailyQv = estQv.length ? (estVolTotal / estQv.length) * (DAY / step) : 0;

  // --- Okno dogodka ---
  const c0 = floorTo(t0Ms, step);
  let gapCandlesInEvent = 0;

  const windowStats = (hours) => {
    if (hours === 1 && t0Precision === 'day') return { skipped: 't0 je podan na dan natančno' };
    const n = hours / stepHours;
    if (!Number.isInteger(n) || n < 1) return { skipped: `okno ${hours} h ni izvedljivo pri intervalu ${interval}` };
    if (c0 + n * step > asOfMs) return { pending: true, skipped: `okno ${hours} h se še ni izteklo` };
    let ar = 0;
    let avail = 0;
    for (const t of windowKeys(c0, c0 + n * step, step)) {
      const a = aRet.get(t);
      if (!a) continue;
      let rb = 0;
      if (bRet) {
        const bb = bRet.get(t);
        if (!bb) continue;
        rb = bb.r;
      }
      ar += a.r - b * rb;
      gapCandlesInEvent = Math.max(gapCandlesInEvent, a.gapCandles);
      avail++;
    }
    const coverage = avail / n;
    if (coverage < m.minCoverage.event) {
      return { coverage, skipped: `pokritost okna ${hours} h je ${(coverage * 100).toFixed(1)} %` };
    }
    // Nominalni n: donos po vrzeli zajame celoten premik čez manjkajoče sveče.
    return { coverage, ar, z: ar / (sigma * Math.sqrt(n)) };
  };

  const windows = {};
  for (const h of m.windowsHours) windows[h] = windowStats(h);
  for (const [h, w] of Object.entries(windows)) {
    if (w.skipped) notes.push(`z${h}: ${w.skipped}`);
  }

  // --- Volumen ---
  const volN = m.volumeWindowHours / stepHours;
  let V = null;
  if (c0 + m.volumeWindowHours * HOUR > asOfMs) {
    notes.push('V: okno volumna se še ni izteklo');
  } else if (Number.isInteger(volN) && volN >= 1 && avgDailyQv > 0) {
    let vol = 0;
    let avail = 0;
    for (const t of windowKeys(c0, c0 + volN * step, step)) {
      const a = aRet.get(t);
      if (!a) continue;
      vol += a.qv;
      avail++;
    }
    if (avail / volN >= m.minCoverage.event) {
      V = vol / (avgDailyQv * (m.volumeWindowHours / 24));
    } else {
      notes.push('V: premajhna pokritost volumna v oknu dogodka');
    }
  } else {
    notes.push('V: povprečni dnevni volumen v ocenjevalnem oknu ni na voljo');
  }
  if (gapCandlesInEvent > 0) notes.push(`vrzel v podatkih v oknu dogodka: do ${gapCandlesInEvent} manjkajočih sveč`);

  const pick = (h, key) => (windows[h] && !windows[h].skipped ? windows[h][key] : null);
  const z24 = pick(24, 'z');
  const z72 = pick(72, 'z');
  const ar24 = pick(24, 'ar');
  const vf = volumeFactor(V, cfg);

  return {
    ...base,
    status: 'ok',
    beta: b,
    sigma,
    avgDailyQuoteVolume: avgDailyQv,
    eventStart: toIso(c0),
    coverage: {
      estimation: estCoverage,
      event24: windows[24]?.coverage ?? null,
      event72: windows[72]?.coverage ?? null,
    },
    ar1: pick(1, 'ar'),
    ar24,
    ar72: pick(72, 'ar'),
    z1: pick(1, 'z'),
    z24,
    z72,
    V,
    volumeFactor: vf,
    M24: magnitudeM24(z24, vf),
    M72: magnitudeM72(z24, z72, vf, cfg),
    direction: ar24 === null ? null : Math.sign(ar24),
    notes,
  };
}

// Največji odmik od vezave v bazičnih točkah v [c0, c0 + hours). Samo informativno.
export function maxDepegBps({ candles, peg = 1, t0Ms, interval, hours }) {
  const step = intervalMs(interval);
  const c0 = floorTo(t0Ms, step);
  const end = c0 + hours * HOUR;
  let max = null;
  let at = null;
  let n = 0;
  for (const k of normalizeCandles(candles)) {
    if (k.t < c0 || k.t >= end) continue;
    n++;
    const dev = (Math.max(Math.abs(k.h - peg), Math.abs(k.l - peg)) / peg) * 1e4;
    if (max === null || dev > max) {
      max = dev;
      at = k.t;
    }
  }
  return {
    maxDepegBps: max,
    maxDepegAt: at === null ? null : toIso(at),
    coverage: n / Math.round((end - c0) / step),
  };
}

/**
 * Sektorski indeks: urni donos kot uteženo povprečje donosov članov.
 * members: [{ candles, weight }]. Uteži se pri vsaki sveči renormalizirajo na
 * člane, ki imajo donos. Za zgodovino (knjižnica) se uporabijo enake uteži.
 */
export function sectorIndexCandles(members, interval, base = 100) {
  const step = intervalMs(interval);
  const series = members
    .filter((mbr) => mbr.weight > 0)
    .map((mbr) => ({ w: mbr.weight, ret: candleReturns(normalizeCandles(mbr.candles), step) }));
  const times = new Set();
  for (const s of series) for (const t of s.ret.keys()) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const out = [];
  let level = base;
  if (sorted.length) out.push({ t: sorted[0] - step, o: base, h: base, l: base, c: base, v: 0, qv: 0 });
  for (const t of sorted) {
    let wSum = 0;
    let rSum = 0;
    let qv = 0;
    for (const s of series) {
      const x = s.ret.get(t);
      if (!x) continue;
      wSum += s.w;
      rSum += s.w * x.r;
      qv += x.qv;
    }
    if (wSum === 0) continue;
    const prev = level;
    level = prev * Math.exp(rSum / wSum);
    out.push({ t, o: prev, h: Math.max(prev, level), l: Math.min(prev, level), c: level, v: 0, qv });
  }
  return out;
}

export function closeSeries(candles, fromMs, toMs) {
  return normalizeCandles(candles)
    .filter((k) => k.t >= fromMs && k.t < toMs)
    .map((k) => [toIso(k.t), k.c]);
}

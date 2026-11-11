// Tržni vpliv živih dogodkov (poglavje 6.1): primarni kovanec ali sektorski indeks, merilo BTC.
//
// Merjenje se izvede največ trikrat na dogodek: prvič, ko je na voljo prva zaprta urna sveča (z1),
// ob 24 h (z24, V, M24 → ExPost) in ob 72 h (z72, M72 → končno; nato zamrznjeno).
// Ocenjevalno okno: [t − 31 d, t − 1 d) (estimationWindowLive), t = firstSeenAt.

import { HOUR, floorTo, toIso } from './lib/time.js';
import { round } from './lib/stats.js';
import { estimationWindowLive, measureImpact, sectorIndexCandles } from './market.js';
import { snapshotAt } from './score.js';

export function phaseAt(event, nowMs) {
  const c0 = floorTo(Date.parse(event.firstSeenAt), HOUR);
  if (nowMs >= c0 + 72 * HOUR) return 72;
  if (nowMs >= c0 + 24 * HOUR) return 24;
  if (nowMs >= c0 + HOUR) return 1;
  return 0;
}

/** Ali je treba dogodek (ponovno) izmeriti: nova faza ali še ni meritve. */
export function needsMeasurement(event, nowMs) {
  const p = phaseAt(event, nowMs);
  if (p === 0) return false;
  const m = event.market;
  if (!m) return true;
  if (m.final) return false;
  return (m.phase ?? 0) < p;
}

function sourcesFor(symbol, cfg) {
  const configured = (cfg.assets?.[symbol]?.sources ?? []).filter((s) => s.interval === '1h' && s.provider === 'binanceApi');
  if (configured.length) return configured;
  return [{ provider: 'binanceApi', symbol: `${symbol}${cfg.scoring.sectorIndex.quote}`, interval: '1h' }];
}

function coverage(candles, start, end) {
  const exp = Math.round((end - start) / HOUR);
  if (exp <= 0) return 1;
  return new Set(candles.filter((k) => k.t >= start && k.t < end).map((k) => k.t)).size / exp;
}

/** Sveče za kovanec; upošteva in posodablja predpomnilnik "ni para". */
async function coinCandles(symbol, range, ctx) {
  const { cfg, store, nowMs, marketState } = ctx;
  const np = marketState.noPair?.[symbol];
  if (np && nowMs - Date.parse(np) < cfg.scoring.noPairRecheckHours * HOUR) return { status: 'no_pair', candles: [] };
  let sawNotFound = false;
  const errors = [];
  for (const src of sourcesFor(symbol, cfg)) {
    const r = await store.getCandles(src, range.from, range.to);
    if (r.status === 'ok' && coverage(r.candles, range.estStart, range.estEnd) >= cfg.market.minCoverage.estimation) {
      return { status: 'ok', candles: r.candles, source: `${src.provider}:${src.symbol}:1h` };
    }
    if (r.status === 'not_found') sawNotFound = true;
    errors.push(...(r.errors ?? []));
    if (r.status === 'ok') errors.push(`${src.symbol}: premajhna pokritost ocenjevalnega okna`);
  }
  if (sawNotFound) {
    marketState.noPair = { ...(marketState.noPair ?? {}), [symbol]: toIso(nowMs) };
    return { status: 'no_pair', candles: [], errors };
  }
  return { status: 'no_data', candles: [], errors };
}

function pickSector(symbol, dict) {
  const sectors = dict.entries[symbol]?.sectors ?? [];
  return sectors.length ? sectors[0] : null;
}

async function sectorIndex(sectorId, t0, range, ctx) {
  const { cfg, sectorsHistory } = ctx;
  const si = cfg.scoring.sectorIndex;
  const { snapshot, after } = snapshotAt(sectorsHistory, t0 - 24 * HOUR);
  const symbols = snapshot?.sectors?.[sectorId] ?? [];
  const members = [];
  for (const sym of symbols) {
    if (members.length >= si.topN) break;
    const cap = snapshot.marketCaps?.[sym];
    if (!(cap > 0)) continue;
    const r = await coinCandles(sym, range, ctx);
    if (r.status === 'ok') members.push({ symbol: sym, weight: cap, candles: r.candles });
  }
  if (members.length < si.minMembers) {
    return { status: 'no_data', reason: `sektorski indeks ${sectorId}: le ${members.length} članov s podatki (zahtevano ≥ ${si.minMembers})` };
  }
  return {
    status: 'ok',
    candles: sectorIndexCandles(members, '1h'),
    members: members.map((m) => ({ symbol: m.symbol, weight: m.weight })),
    weightsSnapshotAt: snapshot.fetchedAt,
    weightsSnapshotAfter: after,
  };
}

/** Serija zaključnih cen v [c0 − h, c0 + h] kot [ure od c0, cena] (za graf ±24 h v vmesniku). */
export function seriesAround(candles, c0, hours) {
  const out = [];
  for (const k of candles) {
    const h = (k.t - c0) / HOUR;
    if (h >= -hours && h <= hours) out.push([h, Math.round(k.c * 1e8) / 1e8]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Tržni indeks (rezerva): top N po market cap s parom na Binance, brez stablecoinov in zavitih žetonov,
 * enake uteži. Vir članov: posnetek marketTop (CoinGecko, brez kategorije); brez njega BTC, ETH in kovanci
 * iz posnetka sektorjev po market cap.
 */
async function marketIndex(t0, range, ctx) {
  const { cfg, sectorsHistory } = ctx;
  const mi = cfg.scoring.marketIndex;
  const { snapshot } = snapshotAt(sectorsHistory, t0 - 24 * HOUR);
  let symbols = snapshot?.marketTop ?? [];
  let source = 'CoinGecko top po market cap';
  if (!symbols.length) {
    const caps = Object.entries(snapshot?.marketCaps ?? {}).sort((a, b) => b[1] - a[1]).map(([sym]) => sym);
    symbols = [...new Set(['BTC', 'ETH', ...caps])];
    source = 'BTC, ETH + spremljani kovanci po market cap (ni posnetka tržnega vrha)';
  }
  const members = [];
  for (const sym of symbols) {
    if (members.length >= mi.topN) break;
    const r = await coinCandles(sym, range, ctx);
    if (r.status === 'ok') members.push({ symbol: sym, weight: 1, candles: r.candles });
  }
  if (members.length < mi.minMembers) {
    return { status: 'no_data', reason: `tržni indeks: le ${members.length} članov s podatki (zahtevano ≥ ${mi.minMembers})` };
  }
  return { status: 'ok', candles: sectorIndexCandles(members, '1h'), members: members.map((m) => ({ symbol: m.symbol, weight: 1 })), membersSource: source, label: mi.label };
}

/**
 * Izmeri dogodek. Vrne objekt market ali null (še ni prve zaprte sveče).
 * Merjeno sredstvo: kovanec → sektorski indeks (≥ 3 člani) → tržni indeks (top 20, enake uteži).
 * ctx: { cfg, store, nowMs, dict, sectorsHistory, marketState }
 */
export async function measureLiveEvent(event, ctx) {
  const { cfg, nowMs } = ctx;
  const phase = phaseAt(event, nowMs);
  if (phase === 0) return null;
  const t0 = Date.parse(event.firstSeenAt);
  const c0 = floorTo(t0, HOUR);
  const base = { phase, final: phase === 72, measuredAt: toIso(nowMs), eventStart: toIso(c0) };
  const primary = event.primaryAsset;
  if (!primary) return { ...base, status: 'no_asset', asset: null, reason: 'dogodek nima kovanca med glavnimi entitetami' };

  const est = estimationWindowLive(t0, cfg, HOUR);
  const range = { from: est.start - HOUR, to: Math.min(nowMs, c0 + 73 * HOUR), estStart: est.start, estEnd: est.end };

  const btc = await coinCandles(cfg.market.benchmark, range, ctx);
  if (btc.status !== 'ok') return { ...base, status: 'no_data', asset: primary, reason: `ni podatkov za merilo ${cfg.market.benchmark}`, errors: btc.errors };

  let asset = primary;
  let kind = 'coin';
  let candles;
  let source;
  let extra = {};
  if (primary === cfg.market.benchmark) {
    candles = btc.candles;
    source = btc.source;
  } else {
    const r = await coinCandles(primary, range, ctx);
    if (r.status === 'ok') {
      candles = r.candles;
      source = r.source;
    } else {
      const why = r.status === 'no_pair' ? 'ni para na Binance' : 'ni podatkov';
      const sector = pickSector(primary, ctx.dict);
      const idx = sector ? await sectorIndex(sector, t0, range, ctx) : { status: 'no_data', reason: 'kovanec nima sektorja' };
      if (idx.status === 'ok') {
        asset = `sector:${sector}`;
        kind = 'sector';
        candles = idx.candles;
        source = 'sektorski indeks (market cap uteži)';
        extra = { replaces: primary, members: idx.members, weightsSnapshotAt: idx.weightsSnapshotAt, weightsSnapshotAfter: idx.weightsSnapshotAfter };
      } else {
        const mk = await marketIndex(t0, range, ctx);
        if (mk.status !== 'ok') return { ...base, status: 'no_data', asset: primary, reason: `${primary}: ${why}; ${idx.reason}; ${mk.reason}` };
        asset = 'market:top';
        kind = 'market';
        candles = mk.candles;
        source = mk.label;
        extra = { replaces: primary, members: mk.members, membersSource: mk.membersSource, fallbackReason: `${why}; ${idx.reason}` };
      }
    }
  }

  const common = { interval: '1h', t0Ms: t0, t0Precision: 'hour', estWindow: est, cfg, asOfMs: nowMs };
  const isBench = asset === cfg.market.benchmark;
  const res = measureImpact({ ...common, assetCandles: candles, benchCandles: isBench ? null : btc.candles });
  if (res.status !== 'ok') return { ...base, status: 'no_data', asset, kind, source, reason: res.reason };
  const btcRes = isBench ? res : measureImpact({ ...common, assetCandles: btc.candles, benchCandles: null });

  const M = phase >= 72 ? res.M72 : res.M24;
  // Serije za graf ±24 h: sredstvo, BTC in (od 24 h dalje) sektorski indeks primarnega kovanca
  const W = 24;
  const series = { c0: toIso(c0), asset: seriesAround(candles, c0, W), btc: isBench ? null : seriesAround(btc.candles, c0, W), sector: null, market: null };
  if (kind === 'sector') {
    series.sector = { id: asset.slice(7), points: series.asset };
  } else if (kind === 'market') {
    series.market = { label: cfg.scoring.marketIndex.label, points: series.asset };
  } else if (phase >= 24) {
    // Primerjalna serija za graf: sektorski indeks, rezerva tržni indeks (jasno označen kot "trg").
    try {
      const sector = pickSector(primary, ctx.dict);
      const idx = sector ? await sectorIndex(sector, t0, range, ctx) : { status: 'no_data' };
      if (idx.status === 'ok') {
        series.sector = { id: sector, points: seriesAround(idx.candles, c0, W) };
      } else {
        const mk = await marketIndex(t0, range, ctx);
        if (mk.status === 'ok') series.market = { label: mk.label, points: seriesAround(mk.candles, c0, W) };
      }
    } catch {
      // primerjalna serija za graf je neobvezna
    }
  }
  return {
    ...base,
    status: 'ok',
    asset,
    kind,
    source,
    ...extra,
    beta: round(res.beta, 6),
    sigma: round(res.sigma, 8),
    ar1: round(res.ar1, 6),
    ar24: round(res.ar24, 6),
    ar72: round(res.ar72, 6),
    z1: round(res.z1, 4),
    z24: round(res.z24, 4),
    z72: round(res.z72, 4),
    V: round(res.V, 4),
    M24: round(res.M24, 4),
    M72: round(res.M72, 4),
    M: round(M ?? null, 4),
    direction: res.direction,
    btcZ24: btcRes.status === 'ok' ? round(btcRes.z24, 4) : null,
    coverage: res.coverage,
    notes: res.notes,
    series,
  };
}

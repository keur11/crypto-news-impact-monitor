// Točkovanje vseh dogodkov v enem teku (koraka 6–7 cevovoda): ExAnte, trg, ExPost, končna ocena, oznake.

import { DAY, toIso } from './lib/time.js';
import {
  computeExAnte,
  computeExPost,
  confoundingReasons,
  finalScore,
  libraryFeatures,
  sharedImpactIds,
} from './score.js';
import { measureLiveEvent, needsMeasurement } from './livemarket.js';
import { assignStories, novelty } from './stories.js';

const FLAG_ORDER = ['confounded', 'shared_impact', 'no_market_asset', 'no_market_data'];

/**
 * Pokritost koledarja makro objav (FOMC, CPI) vnaprej. Opozorilo, ko katera vrsta pokriva manj kot
 * macroEvents.minCoverageDays dni od zdaj.
 */
export function macroCalendarStatus(cfg, nowMs) {
  const min = cfg.macroEvents?.minCoverageDays ?? 60;
  const byKind = {};
  for (const m of cfg.macroEvents?.events ?? []) byKind[m.kind] = byKind[m.kind] && byKind[m.kind] > m.at ? byKind[m.kind] : m.at;
  const days = Object.fromEntries(Object.entries(byKind).map(([k, at]) => [k, Math.floor((Date.parse(at) - nowMs) / DAY)]));
  const kinds = ['fomc', 'cpi'];
  const daysAhead = Math.min(...kinds.map((k) => days[k] ?? -Infinity));
  const short = kinds.filter((k) => !(days[k] >= min));
  return {
    coveredUntil: byKind,
    daysAhead: Number.isFinite(daysAhead) ? daysAhead : null,
    minCoverageDays: min,
    warning: short.length
      ? `Koledar makro objav (${short.map((k) => k.toUpperCase()).join(', ')}) pokriva manj kot ${min} dni vnaprej – posodobi config.macroEvents`
      : null,
  };
}

/**
 * Stanje mesečnega keepalive (keepalive.yml): opozorilo, če ponovno omogočanje workflowov ni uspelo ali
 * zadnji tek ni starejši od status.keepaliveMaxAgeDays. Brez zapisa (še ni teklo) ni opozorila.
 */
export function keepaliveStatus(doc, cfg, nowMs) {
  if (!doc?.at) return { lastRunAt: null, ok: null, ageDays: null, warning: null };
  const ageDays = Math.floor((nowMs - Date.parse(doc.at)) / DAY);
  const max = cfg.status.keepaliveMaxAgeDays;
  let warning = null;
  if (doc.ok === false) warning = `Ponovno omogočanje načrtovanih workflowov ni uspelo (${doc.results ?? ''}) – cron se lahko po 60 dneh brez aktivnosti izklopi. Preveri workflow »Vzdrževanje«.`;
  else if (ageDays > max) warning = `Keepalive ni tekel ${ageDays} dni (> ${max}) – cron se lahko po 60 dneh brez aktivnosti izklopi. Preveri workflow »Vzdrževanje«.`;
  return { lastRunAt: doc.at, ok: doc.ok, ageDays, results: doc.results ?? null, warning };
}

/** Posnetek sektorjev za zgodovino (market cap po simbolu, člani sektorjev po market cap ↓). */
export function sectorsSnapshot(sectors) {
  const marketCaps = {};
  const bySector = {};
  for (const s of sectors?.sectors ?? []) {
    const coins = [...s.coins].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || a.symbol.localeCompare(b.symbol));
    bySector[s.id] = coins.map((c) => c.symbol);
    for (const c of coins) marketCaps[c.symbol] = Math.max(marketCaps[c.symbol] ?? 0, c.marketCap ?? 0);
  }
  // marketTop: tržni vrh brez stablecoinov in zavitih žetonov (za tržni indeks); ne vpliva na S
  const marketTop = (sectors?.market ?? []).map((c) => c.symbol);
  return { fetchedAt: sectors.fetchedAt, marketCaps, sectors: bySector, marketTop };
}

export function updateSectorsHistory(history, sectors, cfg, nowMs) {
  const snaps = [...(history?.snapshots ?? [])];
  if (sectors?.fetchedAt && !snaps.some((s) => s.fetchedAt === sectors.fetchedAt)) snaps.push(sectorsSnapshot(sectors));
  const minMs = nowMs - cfg.sectors.historyDays * DAY;
  const kept = snaps.filter((s) => Date.parse(s.fetchedAt) >= minMs).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  // vedno obdrži vsaj zadnji posnetek
  if (!kept.length && snaps.length) kept.push(snaps.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt)).at(-1));
  return { snapshots: kept };
}

function archiveEntry(e, nowMs) {
  return {
    id: e.id,
    title: e.title,
    firstSeenAt: e.firstSeenAt,
    type: e.type,
    primaryAsset: e.primaryAsset ?? null,
    storyId: e.storyId ?? null,
    exAnte: e.exAnte ? { score: e.exAnte.score, raw: e.exAnte.raw, T: e.exAnte.T, C: e.exAnte.C, Q: e.exAnte.Q, S: e.exAnte.S, A: e.exAnte.A, calibrated: e.exAnte.calibrated } : null,
    novelty: e.novelty ?? null,
    exAnteEff: e.exAnteEff ?? null,
    exPost: e.exPost ? { score: e.exPost.score, raw: e.exPost.raw, horizon: e.exPost.horizon } : null,
    market: e.market ? { status: e.market.status, asset: e.market.asset, z24: e.market.z24 ?? null, z72: e.market.z72 ?? null, M24: e.market.M24 ?? null, M72: e.market.M72 ?? null, direction: e.market.direction ?? null } : null,
    final: e.final,
    status: e.status,
    flags: e.flags,
    archivedAt: toIso(nowMs),
  };
}

/**
 * @param events dogodki po združevanju (s prejšnjimi polji točkovanja)
 * @param ctx { cfg, nowMs, articlesById, classifier, dict, lib, libEvents, idfModel, activeSourceCount,
 *              sectorsHistory, store (ali null = brez tržnih podatkov), marketState, archive }
 */
export async function scoreEvents(events, ctx) {
  const { cfg, nowMs, lib, libEvents, store } = ctx;
  const tierBySource = Object.fromEntries(cfg.sources.map((s) => [s.id, s.tier]));
  const tierOf = (s) => tierBySource[s] ?? cfg.scoring.defaultTier;
  const libFeatures = libraryFeatures(libEvents, ctx.dict);
  const measuredLib = lib.measured ? libEvents : [];
  const summary = { measuredNow: 0, marketErrors: 0, frozenExAnte: 0 };

  // 1. ExAnte (zamrznjen se ne spreminja)
  const pre = events.map((ev) => {
    const e = { ...ev };
    if (e.exAnte?.frozen) {
      summary.frozenExAnte++;
    } else {
      const r = computeExAnte(e, { ...ctx, libFeatures, tierOf });
      e.exAnte = r.exAnte;
      e.analogs = r.analogs;
    }
    return e;
  });

  // 2. Zgodbe (storyId je trajen; tip za novost je tip v oknu ex-ante)
  const { stories, assigned } = assignStories(pre, ctx.stories, cfg, ctx.dict, nowMs);
  const storyById = new Map(stories.stories.map((s) => [s.id, s]));
  for (const e of pre) if (assigned.has(e.id)) e.storyId = assigned.get(e.id);

  const out = [];
  for (const e of pre) {
    // Faktor novosti in učinkovit ExAnte
    const story = storyById.get(e.storyId);
    const nv = novelty(e, story, cfg);
    e.story = { id: e.storyId, index: nv.index, size: story?.events.length ?? 1, firstEventId: story?.firstEventId ?? e.id };
    e.novelty = { N: nv.N, reason: nv.reason, escalation: nv.escalation };
    const effRaw = e.exAnte.raw * nv.N;
    e.exAnteEff = { score: Math.round(effRaw), raw: Math.round(effRaw * 1000) / 1000, N: nv.N };
    // Trg (po dogodku, od lastnega firstSeenAt)
    if (store && needsMeasurement(e, nowMs)) {
      try {
        const m = await measureLiveEvent(e, { ...ctx });
        if (m) {
          e.market = m;
          summary.measuredNow++;
          if (m.status !== 'ok' && m.status !== 'no_asset') summary.marketErrors++;
        }
      } catch (err) {
        e.market = { status: 'error', phase: e.market?.phase ?? 0, final: false, measuredAt: toIso(nowMs), reason: err.message };
        summary.marketErrors++;
      }
    }
    // ExPost in končna ocena (ponovno ob vsakem teku: refs knjižnice se lahko spremenijo)
    e.exPost = computeExPost(e.market, lib, measuredLib);
    const f = finalScore(e.exAnteEff, e.exPost, cfg);
    e.final = f.final;
    e.status = f.status;
    out.push(e);
  }

  const shared = sharedImpactIds(out, cfg);
  for (const e of out) {
    const flags = new Set();
    const reasons = {};
    const conf = confoundingReasons(e, e.market, cfg);
    if (conf.length) {
      flags.add('confounded');
      reasons.confounded = conf;
    }
    if (shared.has(e.id)) flags.add('shared_impact');
    if (!e.primaryAsset || e.market?.status === 'no_asset') flags.add('no_market_asset');
    if (e.market && ['no_data', 'error'].includes(e.market.status)) {
      flags.add('no_market_data');
      reasons.no_market_data = [e.market.reason ?? 'ni podatkov'];
    }
    e.flags = FLAG_ORDER.filter((x) => flags.has(x));
    e.flagReasons = reasons;
  }

  // Arhiv potrjenih (za kalibracijo; dogodki sami se po 14 dneh izbrišejo)
  const arch = new Map((ctx.archive?.entries ?? []).map((x) => [x.id, x]));
  for (const e of out) if (e.market?.final) arch.set(e.id, archiveEntry(e, nowMs));
  const minArch = nowMs - cfg.calibration.archiveDays * DAY;
  const archive = {
    entries: [...arch.values()].filter((x) => Date.parse(x.firstSeenAt) >= minArch).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)),
  };

  const counts = { expected: 0, confirmed: 0 };
  for (const e of out) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return {
    events: out,
    archive,
    stories,
    summary: {
      ...summary,
      counts,
      calibrated: lib.measured && !lib.partial,
      libraryMeasured: lib.measured,
      market: store ? 'enabled' : 'disabled',
      maxFinal: out.reduce((m, e) => Math.max(m, e.final ?? 0), 0),
      exAnteWindowHours: cfg.scoring.exAnteWindowHours,
    },
  };
}


// Model pomembnosti (poglavje 6): ExAnte, analogi, ExPost, končna ocena, varovalke.
// Vse uteži, privzete vrednosti in pragovi so v config.scoring (vrednosti iz specifikacije).
//
// Brez izmerjene knjižnice (libraryState.measured = false):
//   T = privzeta vrednost iz configa, A = 0, ExPost se ne računa, status = "expected".

import { HOUR } from './lib/time.js';
import { mean } from './lib/stats.js';
import { cosine, tokenize, vectorize } from './lib/tfidf.js';
import { jaccard, mainEntities, primaryCoin, salient } from './entities.js';
import { seenMs } from './cluster.js';

const r3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

// ---------- knjižnica ----------

/** Relativni vpliv referenčnega dogodka: M72/M_ref72, sicer M24/M_ref24, sicer null. */
export function relativeImpact(libEvent) {
  const rel = libEvent?.measured?.relative;
  if (Number.isFinite(rel?.M72)) return rel.M72;
  if (Number.isFinite(rel?.M24)) return rel.M24;
  return null;
}

/** Značilke referenčnih dogodkov za podobnost (ozadje BTC/ETH/SOL kot pri naslovih). */
export function libraryFeatures(libEvents, dict) {
  return (libEvents ?? []).map((e) => ({
    id: e.id,
    title: e.title,
    type: e.type,
    entities: salient(e.assets ?? [], e.actors ?? [], dict),
    keywordTokens: tokenize((e.keywords ?? []).join(' ')),
    rel: relativeImpact(e),
    measured: e.measured ?? null,
  }));
}

// ---------- komponente ----------

/** T: povprečni M/M_ref knjižničnih dogodkov istega tipa (omejeno na 1), sicer privzeta vrednost. */
export function componentT(type, lib, libFeatures, cfg) {
  const defaults = cfg.scoring.typeDefaults;
  const fallback = defaults[type] ?? defaults.other;
  if (!lib.measured) return { value: fallback, source: 'default', n: 0 };
  const rels = libFeatures.filter((f) => f.type === type && Number.isFinite(f.rel)).map((f) => f.rel);
  if (!rels.length) return { value: fallback, source: 'default', n: 0 };
  return { value: Math.min(1, mean(rels)), source: 'library', n: rels.length };
}

/**
 * C: število različnih MEDIJSKIH virov v prvih 6 h / število aktivnih medijskih virov (omejeno na 1).
 * Uradni viri (official, npr. SEC) niso v števcu ne v imenovalcu – njihova prisotnost je zajeta v Q.
 * Če dogodek objavi samo uradni vir, je C = 1.
 */
export function componentC(nMedia, activeMediaCount, nOfficial = 0) {
  if (nMedia === 0) return nOfficial > 0 ? 1 : 0;
  return Math.min(1, nMedia / Math.max(1, activeMediaCount));
}

/** Q: največja utež (tier) med viri dogodka. */
export function componentQ(sources, tierOf) {
  return sources.length ? Math.max(...sources.map(tierOf)) : 0;
}

/**
 * S: percentil market cap primarnega kovanca med vsemi spremljanimi kovanci (delež kovancev z ≤ market cap);
 * BTC in ETH = 1; brez primarnega kovanca ali market cap = 0.
 */
export function componentS(primary, marketCaps, cfg) {
  if (!primary) return 0;
  if (cfg.scoring.fullSizeEntities.includes(primary)) return 1;
  const caps = Object.values(marketCaps ?? {}).filter((x) => Number.isFinite(x));
  const own = marketCaps?.[primary];
  if (!Number.isFinite(own) || caps.length === 0) return 0;
  return caps.filter((x) => x <= own).length / caps.length;
}

/**
 * Podobnost s konkretnim preteklim dogodkom (popravek formule iz specifikacije):
 *   sim = [tip_e = tip_r] · (0,6 · Jaccard(entitete+akterji_e, sredstva+akterji_r) + 0,4 · cos(TF-IDF_e, ključne besede_r))
 * Tip je pogoj in ne del vsote, zato A ne podvaja T: pri istem tipu brez skupnih entitet in besed je sim = 0.
 */
export function similarity(ev, ref, idfModel, cfg) {
  const w = cfg.scoring.similarityWeights;
  const sameType = ev.type === ref.type ? 1 : 0;
  const ent = jaccard(ev.entities, ref.entities);
  const cos = cosine(vectorize(ev.tokens, idfModel), vectorize(ref.keywordTokens, idfModel));
  const content = w.entities * ent + w.keywords * cos;
  return { sim: cfg.scoring.similarityTypeGate === false ? content : sameType * content, type: sameType, entities: ent, keywords: cos };
}

/** Analogi: do analogTopK referenčnih dogodkov s sim ≥ analogMinSim (sim ↓, id ↑). */
export function findAnalogs(ev, libFeatures, idfModel, cfg) {
  return libFeatures
    .map((f) => ({ f, s: similarity(ev, f, idfModel, cfg) }))
    .filter((x) => x.s.sim >= cfg.scoring.analogMinSim)
    .sort((a, b) => b.s.sim - a.s.sim || a.f.id.localeCompare(b.f.id))
    .slice(0, cfg.scoring.analogTopK)
    .map((x) => ({ id: x.f.id, title: x.f.title, sim: r3(x.s.sim), rel: x.f.rel, parts: { type: x.s.type, entities: r3(x.s.entities), keywords: r3(x.s.keywords) } }));
}

/** A: s podobnostjo uteženo povprečje M/M_ref izmerjenih analogov (omejeno na 1); brez knjižnice 0. */
export function componentA(analogs, lib) {
  if (!lib.measured) return 0;
  const used = analogs.filter((a) => Number.isFinite(a.rel));
  const wsum = used.reduce((s, a) => s + a.sim, 0);
  if (!used.length || wsum === 0) return 0;
  return Math.min(1, used.reduce((s, a) => s + a.sim * a.rel, 0) / wsum);
}

// ---------- ExAnte ----------

/**
 * Članki, ki jih sme uporabiti ex-ante (brez look-ahead):
 *   seen ≤ firstSeenAt + 6 h (čas objave) IN ingestedAt ≤ firstIngestedAt + 6 h (čas, ko je sistem vedel).
 */
export function exAnteArticles(event, articlesById, cfg) {
  const winMs = cfg.scoring.exAnteWindowHours * HOUR;
  const windowEnd = Date.parse(event.firstSeenAt) + winMs;
  const knownBy = Date.parse(event.firstIngestedAt) + winMs;
  const articles = event.articleIds
    .map((id) => articlesById.get(id))
    .filter((a) => a && seenMs(a) <= windowEnd && Date.parse(a.ingestedAt) <= knownBy);
  return { articles, windowEnd, knownBy };
}

/** Posnetek market cap, veljaven ob času t: zadnji s fetchedAt ≤ t, sicer najzgodnejši (označeno). */
export function snapshotAt(history, tMs) {
  const snaps = (history?.snapshots ?? []).slice().sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  if (!snaps.length) return { snapshot: null, after: false };
  const before = snaps.filter((s) => Date.parse(s.fetchedAt) <= tMs);
  return before.length ? { snapshot: before[before.length - 1], after: false } : { snapshot: snaps[0], after: true };
}

/**
 * Izračun ExAnte. Pred knownBy je ocena začasna (uporablja le članke, ki jih sistem že ima);
 * ob nowMs ≥ knownBy se zamrzne in se ne spreminja več.
 */
export function computeExAnte(event, ctx) {
  const { cfg, articlesById, classifier, dict, lib, libFeatures, idfModel, activeSourceCount, sectorsHistory, tierOf, nowMs } = ctx;
  const officialIds = new Set(cfg.sources.filter((s) => s.official).map((s) => s.id));
  const { articles, windowEnd, knownBy } = exAnteArticles(event, articlesById, cfg);
  const notes = [];
  const arts = articles.length ? articles : event.articleIds.map((id) => articlesById.get(id)).filter(Boolean).slice(0, 1);
  if (!articles.length) notes.push('v oknu ex-ante ni člankov; uporabljen prvi članek');

  const cls = classifier.classify({ articles: arts });
  const entities = mainEntities(arts, dict, cfg);
  const primary = primaryCoin(entities);
  const sources = [...new Set(arts.map((a) => a.source))].sort();
  const { snapshot, after } = snapshotAt(sectorsHistory, windowEnd);
  if (after) notes.push(`posnetek market cap je mlajši od okna ex-ante (${snapshot.fetchedAt})`);
  if (!snapshot && primary && !cfg.scoring.fullSizeEntities.includes(primary)) notes.push('ni posnetka market cap; S = 0');

  const T = componentT(cls.type, lib, libFeatures, cfg);
  const media = sources.filter((s) => !officialIds.has(s));
  const C = componentC(media.length, activeSourceCount, sources.length - media.length);
  const Q = componentQ(sources, tierOf);
  const S = componentS(primary, snapshot?.marketCaps, cfg);
  const evFeat = { type: cls.type, entities, tokens: tokenize(arts.map((a) => a.title).join(' ')) };
  const analogs = findAnalogs(evFeat, libFeatures, idfModel, cfg);
  const A = componentA(analogs, lib);

  const w = cfg.scoring.exAnteWeights;
  const raw = w.T * T.value + w.C * C + w.Q * Q + w.S * S + w.A * A;
  const frozen = nowMs >= knownBy;
  return {
    exAnte: {
      score: Math.round(100 * raw),
      raw: r3(100 * raw),
      T: r3(T.value),
      C: r3(C),
      Q: r3(Q),
      S: r3(S),
      A: r3(A),
      Tsource: T.source,
      type: cls.type,
      entities,
      primaryAsset: primary,
      nArticles: arts.length,
      nSources: sources.length,
      nMediaSources: media.length,
      sources,
      activeMediaSourceCount: activeSourceCount,
      snapshotAt: snapshot?.fetchedAt ?? null,
      windowEnd: new Date(windowEnd).toISOString(),
      knownBy: new Date(knownBy).toISOString(),
      calibrated: lib.measured,
      frozen,
      computedAt: new Date(nowMs).toISOString(),
      notes,
    },
    analogs,
  };
}

// ---------- ExPost ----------

/**
 * ExPost = 100 · min(1, M / M_ref). Po 24 h z M24/M_ref24, po 72 h z M72/M_ref72.
 * Najbližji referenčni dogodek po |M − M_r| na istem horizontu (izenačenje: id ↑).
 */
export function computeExPost(market, lib, libEvents) {
  if (!lib.measured || !market || market.status !== 'ok' || !(market.phase >= 24)) return null;
  let horizon = market.phase >= 72 ? 'M72' : 'M24';
  if (horizon === 'M72' && !Number.isFinite(market.M72)) horizon = 'M24';
  const M = market[horizon];
  const Mref = horizon === 'M72' ? lib.refs?.M_ref72 : lib.refs?.M_ref24;
  if (!Number.isFinite(M) || !(Mref > 0)) return null;
  const cands = (libEvents ?? [])
    .filter((e) => Number.isFinite(e.measured?.[horizon]))
    .map((e) => ({ id: e.id, title: e.title, Mr: e.measured[horizon], d: Math.abs(M - e.measured[horizon]) }))
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));
  const near = cands[0] ?? null;
  const raw = 100 * Math.min(1, M / Mref);
  return {
    score: Math.round(raw),
    raw: r3(raw),
    phase: market.phase,
    horizon,
    M: r3(M),
    Mref: r3(Mref),
    nearestRef: near?.id ?? null,
    nearestTitle: near?.title ?? null,
    ratioToNearest: near && near.Mr > 0 ? r3(M / near.Mr) : null,
  };
}

/**
 * Končna ocena: pred potrditvijo ExAnte_eff (pričakovan), po njej 0,3·ExAnte_eff + 0,7·ExPost (potrjen).
 * ExAnte_eff = ExAnte · N (faktor novosti zgodbe); brez zgodbe N = 1.
 */
export function finalScore(exAnte, exPost, cfg) {
  if (!exAnte) return { final: null, status: 'expected' };
  if (!exPost) return { final: exAnte.score, status: 'expected' };
  const w = cfg.scoring.finalWeights;
  return { final: Math.round(w.exAnte * exAnte.raw + w.exPost * exPost.raw), status: 'confirmed' };
}

// ---------- varovalke ----------

/** confounded: |z24(BTC)| > prag in dogodek ne zadeva BTC, ali makro objava v ±macroWindowHours. */
export function confoundingReasons(event, market, cfg) {
  const c = cfg.scoring.confounding;
  const out = [];
  const t0 = Date.parse(event.firstSeenAt);
  if (market && Number.isFinite(market.btcZ24) && Math.abs(market.btcZ24) > c.btcAbsZ24 && !(event.entities ?? []).includes('BTC')) {
    out.push(`|z24(BTC)| = ${Math.abs(market.btcZ24).toFixed(2)} > ${c.btcAbsZ24}`);
  }
  for (const m of cfg.macroEvents?.events ?? []) {
    if (Math.abs(Date.parse(m.at) - t0) <= c.macroWindowHours * HOUR) out.push(`${m.label} (${m.at})`);
  }
  return out;
}

/**
 * shared_impact: ista merjena entiteta pri več dogodkih RAZLIČNIH zgodb v ±sharedImpactWindowHours.
 * Znotraj zgodbe je prekrivanje pričakovano in se ne označuje. Vrne množico ID-jev.
 */
export function sharedImpactIds(events, cfg) {
  const win = cfg.scoring.sharedImpactWindowHours * HOUR;
  // Tržni indeks ni entiteta dogodka: takšni dogodki se primerjajo po primarnem kovancu.
  const keyOf = (e) => (e.market?.kind === 'market' ? e.primaryAsset : e.market?.asset ?? e.primaryAsset) || null;
  const ids = new Set();
  const list = events.filter(keyOf).map((e) => ({ id: e.id, key: keyOf(e), story: e.storyId ?? e.id, t: Date.parse(e.firstSeenAt) }));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].story === list[j].story) continue;
      if (list[i].key === list[j].key && Math.abs(list[i].t - list[j].t) <= win) {
        ids.add(list[i].id);
        ids.add(list[j].id);
      }
    }
  }
  return ids;
}


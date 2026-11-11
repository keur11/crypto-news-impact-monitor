// En tek zbiralnika brez datotečnega I/O (testabilno): sektorji → RSS → označevanje → dogodki → status.
// Tržni podatki in točkovanje (koraka 6–7 cevovoda) pridejo v 4. koraku.

import { DAY, HOUR, toIso } from './lib/time.js';
import { buildIdf, tokenize, vectorize } from './lib/tfidf.js';
import { buildDictionary, findActors, findEntities, salient, sectorsOf } from './entities.js';
import { createClassifier } from './classify.js';
import { assignArticles, seenMs } from './cluster.js';
import { fetchSource } from './sources/rss.js';
import { needsRefresh, refreshSectors } from './sources/coingecko.js';
import { libraryState } from './library.js';
import { keepaliveStatus, macroCalendarStatus, scoreEvents, updateSectorsHistory } from './scoring.js';

const SCORING_DEFAULTS = { exAnte: null, market: null, exPost: null, analogs: [], final: null, status: 'expected', flags: [] };
const SCORING_KEYS = Object.keys(SCORING_DEFAULTS);

export function tagArticle(a, dict, classifier) {
  const titleEntities = findEntities(a.title, dict);
  const entities = [...new Set([...titleEntities, ...findEntities(a.summary, dict)])];
  const titleActors = findActors(a.title, dict);
  const actors = [...new Set([...titleActors, ...findActors(a.summary, dict)])];
  return {
    ...a,
    titleEntities,
    entities,
    titleActors,
    actors,
    titleSalient: salient(titleEntities, titleActors, dict),
    salient: salient(entities, actors, dict),
    sectors: sectorsOf(entities, dict),
    typeMatch: classifier.classifyArticle(a),
  };
}

/**
 * @param state { articles, events, sectors, sectorsHistory, marketState, archive, prevStatus, library, libraryInput }
 * @param store shramba cen (createPriceStore) ali null = brez tržnih podatkov (ExPost se ne računa)
 * @returns { articles, events, sectors, sectorsHistory, marketState, archive, status }
 */
export async function runCollector({ cfg, http, nowMs, env = process.env, state, store = null }) {
  const started = nowMs;
  const errors = [];
  const warnings = [];
  const prevSources = state.prevStatus?.sources ?? {};

  // 1. Sektorji (enkrat dnevno)
  let sectors = state.sectors ?? null;
  const cg = { refreshed: false, ok: null, error: null, fetchedAt: sectors?.fetchedAt ?? null, invalidCategories: [] };
  if (needsRefresh(sectors, cfg, nowMs)) {
    const r = await refreshSectors(http, cfg, nowMs, env);
    cg.ok = r.ok;
    if (r.ok) {
      sectors = r.data;
      cg.refreshed = true;
      cg.fetchedAt = r.data.fetchedAt;
    } else {
      cg.error = r.error;
      (r.skipped ? warnings : errors).push(`CoinGecko: ${r.error}${sectors ? ' – uporabljeni prejšnji sektorji' : ' – sektorji niso na voljo, entitete samo iz configa'}`);
    }
    for (const w of r.warnings ?? []) warnings.push(`CoinGecko: ${w}`);
  } else {
    cg.ok = true;
  }
  cg.invalidCategories = Object.entries(sectors?.categories ?? {})
    .filter(([, v]) => !v.valid)
    .map(([k]) => k);

  const dict = buildDictionary(cfg, sectors);
  const classifier = createClassifier(cfg, dict);

  // 2. Zbiranje
  const byId = new Map((state.articles ?? []).map((a) => [a.id, a]));
  const fresh = [];
  const sources = {};
  for (const src of cfg.sources) {
    const prev = prevSources[src.id] ?? {};
    if (!src.enabled) {
      sources[src.id] = { name: src.name, enabled: false, tier: src.tier, note: src.note ?? null };
      continue;
    }
    const r = await fetchSource(http, cfg, src, nowMs, env);
    let added = 0;
    for (const a of r.articles) {
      if (byId.has(a.id)) continue; // duplikat po URL-ju (tudi med viri)
      if (seenMs(a) < nowMs - cfg.retention.articleDays * DAY) continue;
      byId.set(a.id, a);
      fresh.push(a);
      added++;
    }
    sources[src.id] = {
      name: src.name,
      enabled: true,
      tier: src.tier,
      ok: r.ok,
      skipped: Boolean(r.skipped),
      format: r.format ?? null,
      items: r.articles.length,
      rejected: r.rejected.length,
      new: added,
      lastAttemptAt: toIso(nowMs),
      lastSuccessAt: r.ok ? toIso(nowMs) : prev.lastSuccessAt ?? null,
      lastError: r.ok ? null : r.error,
      lastErrorAt: r.ok ? prev.lastErrorAt ?? null : toIso(nowMs),
    };
    if (!r.ok) (r.skipped ? warnings : errors).push(`${src.name}: ${r.error}`);
  }

  // 3. Označevanje novih člankov (obstoječe oznake ostanejo zamrznjene)
  for (const a of fresh) byId.set(a.id, tagArticle(a, dict, classifier));

  // Retencija
  const minSeen = nowMs - cfg.retention.articleDays * DAY;
  const articles = [...byId.values()].filter((a) => seenMs(a) >= minSeen);
  const articlesById = new Map(articles.map((a) => [a.id, a]));
  const freshTagged = fresh.map((a) => articlesById.get(a.id)).filter(Boolean);

  // 4. Združevanje
  const idfModel = buildIdf(articles.map((a) => tokenize(a.title)));
  const vectors = new Map(articles.map((a) => [a.id, vectorize(tokenize(a.title), idfModel)]));
  const minEvent = nowMs - cfg.retention.eventDays * DAY;
  const prevEvents = (state.events ?? [])
    .filter((e) => Date.parse(e.firstSeenAt) >= minEvent)
    .map((e) => ({ ...e, articleIds: e.articleIds.filter((x) => articlesById.has(x)) }))
    .filter((e) => e.articleIds.length > 0);
  const prevById = new Map(prevEvents.map((e) => [e.id, e]));
  const ctx = { cfg, vectors, articlesById, classifier, dict };
  const { events: clustered, assignments } = assignArticles(prevEvents, freshTagged, ctx);

  const merged = clustered.map((e) => {
    const prev = prevById.get(e.id);
    const scoring = Object.fromEntries(SCORING_KEYS.map((k) => [k, prev?.[k] ?? SCORING_DEFAULTS[k]]));
    return { ...e, ...scoring };
  });

  // 5. Knjižnica in koledar makro objav
  const lib = libraryState(state.library, cfg);
  if (lib.warning) warnings.push(lib.warning);
  const macroCalendar = macroCalendarStatus(cfg, nowMs);
  if (macroCalendar.warning) warnings.push(macroCalendar.warning);
  const keepalive = keepaliveStatus(state.keepalive, cfg, nowMs);
  if (keepalive.warning) warnings.push(keepalive.warning);

  // Aktivni viri: uspešno branje v tem teku in ≥ minArticles članek v zadnjih lookbackHours
  const since = nowMs - cfg.activeSource.lookbackHours * HOUR;
  const recentBySource = new Map();
  for (const a of articles) if (seenMs(a) >= since) recentBySource.set(a.source, (recentBySource.get(a.source) ?? 0) + 1);
  for (const [id, s] of Object.entries(sources)) {
    if (!s.enabled) continue;
    s.recent24h = recentBySource.get(id) ?? 0;
    s.active = s.ok && s.recent24h >= cfg.activeSource.minArticles;
  }
  const activeSources = Object.entries(sources)
    .filter(([, s]) => s.active)
    .map(([id]) => id);

  // 6.–7. Trg in točkovanje
  const sectorsHistory = updateSectorsHistory(state.sectorsHistory, sectors, cfg, nowMs);
  const marketState = { noPair: { ...(state.marketState?.noPair ?? {}) } };
  // Analogi: izmerjena knjižnica; brez nje ročni vnos (samo podobnost za prikaz, A = 0).
  const libEvents = state.library?.events ?? state.libraryInput ?? [];
  const scored = await scoreEvents(merged, {
    cfg, nowMs, articlesById, classifier, dict, lib, libEvents, idfModel,
    // imenovalec C: aktivni medijski viri (brez uradnih)
    activeSourceCount: activeSources.filter((id) => !cfg.sources.find((x) => x.id === id)?.official).length,
    sectorsHistory, store, marketState, archive: state.archive, stories: state.stories,
  });
  const events = scored.events;

  const newEventIds = new Set(assignments.filter((x) => x.reason === 'new').map((x) => x.eventId));
  const status = {
    schema: 1,
    version: cfg.app.version,
    runAt: toIso(started),
    finishedAt: null,
    durationMs: null,
    ok: true,
    articles: { total: articles.length, new: freshTagged.length },
    events: { total: events.length, new: newEventIds.size, updated: new Set(assignments.filter((x) => x.reason !== 'new').map((x) => x.eventId)).size },
    sources,
    activeSources,
    activeSourceCount: activeSources.length,
    coingecko: cg,
    entityConflicts: dict.conflicts,
    library: lib,
    macroCalendar,
    keepalive,
    stories: { total: scored.stories.stories.length },
    calibrated: lib.measured && !lib.partial,
    scoring: scored.summary,
    priceStore: store?.stats ? store.stats() : null,
    warnings,
    errors,
    httpCalls: http?.stats ? http.stats() : {},
  };

  return { articles, events, sectors, sectorsHistory, marketState, archive: scored.archive, stories: scored.stories, status, assignments };
}

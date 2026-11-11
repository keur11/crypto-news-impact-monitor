// Združevanje člankov v dogodke (inkrementalno, z obstojnimi ID-ji dogodkov).
//
// Članek se pridruži dogodku, če je |seen(članek) − firstSeen(dogodek)| ≤ windowHours in velja:
//   (a) največja kosinusna podobnost TF-IDF naslova s člani dogodka ≥ cosineThreshold (0,55), ali
//   (b) Jaccard(pomenske entitete naslova, glavne entitete dogodka) ≥ entityJaccardMin (0,5)
//       in tip članka = tip dogodka (≠ other, če requireTypeNotOther) in TF-IDF ≥ entityCosineMin (0,25).
// Pomenske entitete = kovanci brez ozadja BTC/ETH/SOL (če je v naslovu drug kovanec) + akterji.
// Med več kandidati zmaga največja podobnost, nato zgodnejši dogodek, nato ID.
// Novi članki se obdelajo po vrsti (seen, id); obstoječe dodelitve se ne spreminjajo, zato so ID-ji stabilni.

import { HOUR, toIso } from './lib/time.js';
import { cosine } from './lib/tfidf.js';
import { jaccard, mainEntities, primaryCoin } from './entities.js';

export function seenMs(a) {
  const ing = Date.parse(a.ingestedAt);
  const pub = a.publishedAt ? Date.parse(a.publishedAt) : NaN;
  return Number.isFinite(pub) ? Math.min(pub, ing) : ing;
}

export function eventId(firstArticle) {
  const d = toIso(seenMs(firstArticle)).slice(0, 10).replaceAll('-', '');
  return `evt_${d}_${firstArticle.id.slice(0, 6)}`;
}

/** Povzetek dogodka iz članov (čista funkcija). */
export function summarizeEvent(id, memberIds, ctx) {
  const { articlesById, classifier, dict, cfg } = ctx;
  const arts = memberIds
    .map((x) => articlesById.get(x))
    .filter(Boolean)
    .sort((a, b) => seenMs(a) - seenMs(b) || a.id.localeCompare(b.id));
  if (arts.length === 0) return null;
  const first = arts[0];
  const cls = classifier.classify({ articles: arts });
  const sources = [...new Set(arts.map((a) => a.source))].sort();
  const entities = cls.entities.length ? cls.entities : mainEntities(arts, dict, cfg);
  return {
    id,
    firstSeenAt: toIso(seenMs(first)),
    firstIngestedAt: arts.map((a) => a.ingestedAt).sort()[0],
    firstSource: first.source,
    title: first.title,
    type: cls.type,
    typeConfidence: Math.round(cls.confidence * 1000) / 1000,
    typeVotes: cls.votes,
    entities,
    primaryAsset: primaryCoin(entities),
    sectors: [...new Set(arts.flatMap((a) => a.sectors ?? []))].sort(),
    nSources: sources.length,
    sources,
    articleIds: arts.map((a) => a.id),
    articles: arts.map((a) => ({
      id: a.id,
      url: a.url,
      title: a.title,
      source: a.source,
      publishedAt: a.publishedAt,
      ingestedAt: a.ingestedAt,
      type: a.typeMatch?.type ?? null,
    })),
  };
}

/**
 * @param events obstoječi dogodki [{ id, articleIds, ... }]
 * @param newArticles novi (že označeni) članki z .vec, .titleEntities, .typeMatch
 * @param ctx { articlesById (vključuje nove), vectors: Map(id → vec), classifier, dict, cfg }
 * @returns { events, assignments: [{ articleId, eventId, reason, sim }] }
 */
export function assignArticles(events, newArticles, ctx) {
  const { cfg, vectors } = ctx;
  const winMs = cfg.clustering.windowHours * HOUR;
  const thr = cfg.clustering.cosineThreshold;
  const byId = new Map(events.map((e) => [e.id, { ...e }]));
  const assignments = [];

  const ordered = [...newArticles].sort((a, b) => seenMs(a) - seenMs(b) || a.id.localeCompare(b.id));
  for (const a of ordered) {
    const t = seenMs(a);
    const va = vectors.get(a.id);
    let best = null;
    for (const ev of byId.values()) {
      if (Math.abs(t - Date.parse(ev.firstSeenAt)) > winMs) continue;
      let sim = 0;
      for (const mid of ev.articleIds) {
        const vm = vectors.get(mid);
        if (vm) sim = Math.max(sim, cosine(va, vm));
      }
      const aType = a.typeMatch?.type ?? 'other';
      const jac = jaccard(a.titleSalient ?? [], ev.entities ?? []);
      const entityMatch =
        jac >= cfg.clustering.entityJaccardMin &&
        aType === ev.type &&
        !(cfg.clustering.requireTypeNotOther && aType === 'other') &&
        sim >= cfg.clustering.entityCosineMin;
      if (sim < thr && !entityMatch) continue;
      const cand = { ev, sim, reason: sim >= thr ? 'tfidf' : 'entities+type' };
      if (
        !best ||
        cand.sim > best.sim + 1e-12 ||
        (Math.abs(cand.sim - best.sim) <= 1e-12 &&
          (Date.parse(cand.ev.firstSeenAt) < Date.parse(best.ev.firstSeenAt) ||
            (cand.ev.firstSeenAt === best.ev.firstSeenAt && cand.ev.id < best.ev.id)))
      ) {
        best = cand;
      }
    }
    if (best) {
      const updated = summarizeEvent(best.ev.id, [...best.ev.articleIds, a.id], ctx);
      byId.set(best.ev.id, updated);
      assignments.push({ articleId: a.id, eventId: best.ev.id, reason: best.reason, sim: Math.round(best.sim * 1000) / 1000 });
    } else {
      let id = eventId(a);
      if (byId.has(id)) id = `${id}${a.id.slice(6, 10)}`; // izjemno redek trk predpone
      byId.set(id, summarizeEvent(id, [a.id], ctx));
      assignments.push({ articleId: a.id, eventId: id, reason: 'new', sim: null });
    }
  }
  const out = [...byId.values()].sort((x, y) => Date.parse(x.firstSeenAt) - Date.parse(y.firstSeenAt) || x.id.localeCompare(y.id));
  return { events: out, assignments };
}

// Klasifikacija tipa dogodka s pravili (ključne besede iz configa).
//
// Ključna beseda:
//  - z malimi črkami → brez razlikovanja velikosti ("ban" ujame "Ban");
//  - z velikimi črkami → z razlikovanjem ("SEC", "Fed", "ETF" – "fed up" ne sproži macro);
//  - zvezdica na koncu → predpona ("hack*" ujame hack, hacked, hackers);
//  - vedno na meji besede ("rate" ne ujame "corporate").
// Negativne fraze (npr. "reward hacking") se pred iskanjem odstranijo iz besedila za ta tip.
//
// Kripto kontekst: tipi iz classification.requireCryptoContext (hack, insolvency, protocol_failure) veljajo
// le, če naslov ali povzetek vsebuje kovanec ali kripto akterja (actors[].crypto: borza, protokol, izdajatelj).
// Sicer se tip preskoči in iskanje nadaljuje po prioriteti (npr. "A stolen iPhone … crypto theft" → other).
// Članek: prvi tip po prioriteti, ki se ujema v naslovu; če ga ni, v povzetku; sicer "other".
// Dogodek (grozd): večinski tip člankov; glas članka = tier vira × (naslov 1 | povzetek 0,5 | other 1).
//   Tudi "other" je glas. Izenačenje razreši prioriteta ("other" je zadnji). Tako en naslov
//   (npr. o odtokih iz ETF zaradi hacka) ne spremeni tipa grozda, ki ga drugi viri uvrščajo drugače.
//
// Vmesnik classify(event) → { type, confidence, entities } omogoča kasnejšo zamenjavo z LLM.

import { escapeRegex } from './lib/text.js';
import { findActors, findEntities, mainEntities } from './entities.js';

export function compileTerm(raw) {
  const prefix = raw.endsWith('*');
  const base = prefix ? raw.slice(0, -1) : raw;
  const caseSensitive = /[A-Z]/.test(base);
  const body = base.split(/\s+/).map(escapeRegex).join('[\\s\\-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${prefix ? '[\\p{L}\\p{N}]*' : ''}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
}

export function compileRules(cfg) {
  const c = cfg.classification;
  const needCrypto = new Set(c.requireCryptoContext ?? []);
  return c.priority.map((type) => ({
    type,
    requiresCrypto: needCrypto.has(type),
    terms: (c.keywords[type] ?? []).map((k) => ({ raw: k, re: compileTerm(k) })),
    negatives: (c.negative?.[type] ?? []).map((k) => new RegExp(compileTerm(k).source, `${compileTerm(k).flags}g`)),
  }));
}

/** Prvi tip po prioriteti, ki se ujema v besedilu (tipi s kripto pogojem le ob kripto kontekstu). */
export function matchType(text, rules, cryptoContext = true, suppressed = null) {
  if (!text) return null;
  for (const r of rules) {
    let t = text;
    for (const neg of r.negatives) t = t.replace(neg, ' ');
    const hit = r.terms.find((term) => term.re.test(t));
    if (!hit) continue;
    if (r.requiresCrypto && !cryptoContext) {
      if (suppressed && !suppressed.includes(r.type)) suppressed.push(r.type);
      continue;
    }
    return { type: r.type, keyword: hit.raw };
  }
  return null;
}

/** Ali besedilo vsebuje kovanec ali kripto akterja. */
export function hasCryptoContext(text, dict, cryptoActorIds) {
  if (!dict) return true;
  if (findEntities(text, dict).length) return true;
  return findActors(text, dict).some((a) => cryptoActorIds.has(a));
}

export function classifyArticle(article, rules, ctx = {}) {
  const text = `${article.title ?? ''} ${article.summary ?? ''}`;
  const crypto = ctx.dict ? hasCryptoContext(text, ctx.dict, ctx.cryptoActorIds ?? new Set()) : true;
  const suppressed = [];
  const inTitle = matchType(article.title, rules, crypto, suppressed);
  const extra = suppressed.length ? { suppressed: [...suppressed], cryptoContext: crypto } : { cryptoContext: crypto };
  if (inTitle) return { type: inTitle.type, keyword: inTitle.keyword, where: 'title', ...extra };
  const inSummary = matchType(article.summary, rules, crypto, suppressed);
  const extra2 = suppressed.length ? { suppressed: [...suppressed], cryptoContext: crypto } : { cryptoContext: crypto };
  if (inSummary) return { type: inSummary.type, keyword: inSummary.keyword, where: 'summary', ...extra2 };
  return { type: 'other', keyword: null, where: null, ...extra2 };
}

export function createClassifier(cfg, dict) {
  const rules = compileRules(cfg);
  const cryptoActorIds = new Set((cfg.actors ?? []).filter((a) => a.crypto).map((a) => a.id));
  const ctx = { dict, cryptoActorIds };
  const c = cfg.classification;
  const order = [...c.priority, 'other'];

  const tierBySource = Object.fromEntries((cfg.sources ?? []).map((s) => [s.id, s.tier]));
  const defaultTier = cfg.scoring?.defaultTier ?? 0.4;
  const tierOf = (source) => tierBySource[source] ?? defaultTier;

  function classify(event) {
    const arts = event.articles ?? [];
    const score = new Map();
    let total = 0;
    for (const a of arts) {
      const r = a.typeMatch ?? classifyArticle(a, rules, ctx);
      const w = tierOf(a.source) * (r.where === 'summary' ? c.summaryWeight : c.titleWeight);
      score.set(r.type, (score.get(r.type) ?? 0) + w);
      total += w;
    }
    let type = 'other';
    let best = -1;
    for (const t of order) {
      const s = score.get(t) ?? 0;
      if (s > best + 1e-12) {
        best = s;
        type = t;
      }
    }
    const confidence = arts.length === 0 || type === 'other' ? 0 : best / total;
    const votes = Object.fromEntries(order.filter((t) => score.has(t)).map((t) => [t, Math.round(score.get(t) * 1e6) / 1e6]));
    return { type, confidence, entities: mainEntities(arts, dict, cfg), votes };
  }

  return { classify, classifyArticle: (a) => classifyArticle(a, rules, ctx), rules };
}

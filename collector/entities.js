// Slovar entitet (kovanci in akterji) in iskanje entitet v besedilu.
//
// Kovanci (ključ = ticker, npr. "BNB"):
//  - ticker: samo velike črke kot cela beseda ("SOL", "$SOL"); enočrkovni samo s $ (cashtag);
//    tickerji s tickerStopList (AI, SEC, ETF …) se ne ujemajo;
//  - ime: brez razlikovanja velikosti, cela fraza; dvoumna imena (ambiguousNames: "Near", "Base" …) se ne
//    ujemajo – zanje veljata le ticker in večbesedni alias ("NEAR Protocol");
//  - prekrivanje: daljše ujemanje zmaga ("Bitcoin Cash" → BCH, ne BTC).
// Akterji (ključ = "@ID", npr. "@SEC", "@NORTH_KOREA"): regulatorji, organi, skupine, borze in protokoli brez
//  lastnega kovanca; imena se ujemajo z razlikovanjem velikosti (lastna imena, kratice).
// Ozadje (entities.background = BTC, ETH, SOL): v naslovu je tržni kontekst, kadar naslov vsebuje vsaj en drug
//  kovanec; kot glavna entiteta šteje le, če je edini kovanec v naslovu.

import { escapeRegex } from './lib/text.js';

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

export const isActor = (id) => typeof id === 'string' && id.startsWith('@');

export function buildDictionary(cfg, sectorsData) {
  const ec = cfg.entities;
  const stop = new Set(ec.tickerStopList.map((s) => s.toUpperCase()));
  const ambiguous = new Set(ec.ambiguousNames.map((s) => s.toLowerCase()));
  const map = new Map();
  const conflicts = [];

  const get = (symbol) => {
    const key = symbol.toUpperCase();
    if (!map.has(key)) {
      map.set(key, { symbol: key, names: new Set(), sectors: new Set(), marketCap: null, coingeckoId: null });
    }
    return map.get(key);
  };

  for (const sector of sectorsData?.sectors ?? []) {
    for (const c of sector.coins) {
      const e = get(c.symbol);
      if (e.coingeckoId && e.coingeckoId !== c.id) {
        // Isti ticker za različna kovanca: obdrži večjega po market cap.
        if ((c.marketCap ?? 0) <= (e.marketCap ?? 0)) {
          conflicts.push({ symbol: e.symbol, kept: e.coingeckoId, dropped: c.id });
          continue;
        }
        conflicts.push({ symbol: e.symbol, kept: c.id, dropped: e.coingeckoId });
        e.names.clear();
        e.sectors.clear();
      }
      e.coingeckoId = c.id;
      e.marketCap = c.marketCap ?? e.marketCap;
      e.names.add(c.name);
      e.sectors.add(sector.id);
    }
  }
  for (const s of ec.static) {
    const e = get(s.symbol);
    for (const n of s.names) e.names.add(n);
  }
  for (const [sym, names] of Object.entries(ec.synonyms ?? {})) for (const n of names) get(sym).names.add(n);

  const aliases = ec.aliases ?? {};
  const patterns = [];
  for (const e of map.values()) {
    if (!stop.has(e.symbol) && e.symbol.length >= 1) {
      const t = escapeRegex(e.symbol);
      const src = e.symbol.length === 1 ? `\\$${t}${E}` : `(?<![\\p{L}\\p{N}$])\\$?${t}${E}`;
      patterns.push({ symbol: e.symbol, kind: 'ticker', re: new RegExp(src, 'gu') });
    }
    const phrases = new Set();
    for (const n of e.names) {
      if (!n || ambiguous.has(n.toLowerCase())) continue;
      if (n === e.symbol) continue; // ime je dobesedno ticker (npr. "BNB") – pokrije ga pravilo za ticker
      phrases.add(n);
    }
    for (const a of aliases[e.symbol] ?? []) phrases.add(a);
    for (const p of phrases) {
      const src = `${B}${p.split(/\s+/).map(escapeRegex).join('\\s+')}${E}`;
      patterns.push({ symbol: e.symbol, kind: 'name', re: new RegExp(src, 'giu') });
    }
  }

  const actors = {};
  const actorPatterns = [];
  for (const a of cfg.actors ?? []) {
    actors[a.id] = { id: a.id, label: a.label, kind: a.kind, names: [...a.names] };
    for (const n of a.names) {
      const src = `${B}${n.split(/\s+/).map(escapeRegex).join('\\s+')}${E}`;
      actorPatterns.push({ symbol: a.id, kind: 'actor', re: new RegExp(src, 'gu') });
    }
  }

  const entries = Object.fromEntries(
    [...map.values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((e) => [
        e.symbol,
        { symbol: e.symbol, names: [...e.names].sort(), sectors: [...e.sectors].sort(), marketCap: e.marketCap, coingeckoId: e.coingeckoId },
      ]),
  );
  return { entries, patterns, actors, actorPatterns, background: new Set(ec.background ?? []), conflicts };
}

function scan(text, patterns) {
  if (!text) return [];
  const hits = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      hits.push({ symbol: p.symbol, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  // Daljše ujemanje izpodrine krajša, ki jih vsebuje.
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const h of hits) {
    const len = h.end - h.start;
    const covered = kept.some((k) => h.start >= k.start && h.end <= k.end && k.end - k.start > len);
    if (!covered) kept.push(h);
  }
  kept.sort((a, b) => a.start - b.start);
  const out = [];
  for (const h of kept) if (!out.includes(h.symbol)) out.push(h.symbol);
  return out;
}

/** Kovanci v besedilu (tickerji) v vrstnem redu prve pojavitve. */
export function findEntities(text, dict) {
  return scan(text, dict.patterns);
}

/** Akterji v besedilu ("@ID") v vrstnem redu prve pojavitve. */
export function findActors(text, dict) {
  return scan(text, dict.actorPatterns ?? []);
}

/**
 * Glavne (pomenske) entitete enega naslova: kovanci brez ozadja (če je prisoten drug kovanec) + akterji.
 */
export function salient(coins, actors, dict) {
  const bg = dict.background ?? new Set();
  const nonBg = coins.filter((c) => !bg.has(c));
  return [...(nonBg.length ? nonBg : coins), ...actors];
}

export function sectorsOf(symbols, dict) {
  const s = new Set();
  for (const sym of symbols) for (const sec of dict.entries[sym]?.sectors ?? []) s.add(sec);
  return [...s].sort();
}

/**
 * Glavne entitete dogodka: pomenske entitete naslovov (titleSalient), ki se pojavijo v ≥ mainEntityMinShare
 * člankov. Če v naslovih ni entitet, se uporabijo pomenske entitete naslova in povzetka (salient).
 * Razvrščeno: pogostost ↓, kovanci pred akterji, market cap ↓, simbol.
 */
export function mainEntities(articles, dict, cfg) {
  const ec = cfg.entities;
  const pick = (key) => {
    const count = new Map();
    for (const a of articles) for (const s of new Set(a[key] ?? [])) count.set(s, (count.get(s) ?? 0) + 1);
    const min = Math.max(1, Math.ceil(ec.mainEntityMinShare * articles.length));
    return [...count.entries()]
      .filter(([, n]) => n >= min)
      .sort(
        ([sa, na], [sb, nb]) =>
          nb - na ||
          Number(isActor(sa)) - Number(isActor(sb)) ||
          (dict.entries[sb]?.marketCap ?? -1) - (dict.entries[sa]?.marketCap ?? -1) ||
          sa.localeCompare(sb),
      )
      .map(([s]) => s)
      .slice(0, ec.maxMainEntities);
  };
  const fromTitles = pick('titleSalient');
  return fromTitles.length ? fromTitles : pick('salient');
}

/** Primarni kovanec dogodka (prvi kovanec med glavnimi entitetami) ali null. */
export function primaryCoin(entities) {
  return (entities ?? []).find((e) => !isActor(e)) ?? null;
}

export function jaccard(a, b) {
  const A = new Set(a);
  const Bs = new Set(b);
  if (A.size === 0 && Bs.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (Bs.has(x)) inter++;
  return inter / (A.size + Bs.size - inter);
}

// CoinGecko Demo API: preverjanje ID-jev kategorij, top N kovancev po sektorju, izločanje stablecoinov.
// Ključ: okoljska spremenljivka (config.providers.coingecko.apiKeyEnv), nikoli v repozitoriju.

import { toIso } from '../lib/time.js';

function headers(cfg, env) {
  const p = cfg.providers.coingecko;
  const key = env[p.apiKeyEnv];
  return key ? { [p.apiKeyHeader]: key } : null;
}

export function needsRefresh(prev, cfg, nowMs) {
  if (!prev?.fetchedAt) return true;
  const ageH = (nowMs - Date.parse(prev.fetchedAt)) / 3600000;
  if (!(ageH < cfg.providers.coingecko.refreshHours)) return true;
  // Nov sektor v configu sproži osvežitev; preverjen, a neveljaven ID ne (sicer bi se osveževalo ob vsakem teku).
  const known = new Set([...(prev.sectors ?? []).map((s) => s.id), ...Object.keys(prev.categories ?? {})]);
  return cfg.sectors.list.some((s) => !known.has(s.id));
}

export function makeExcluder(cfg, stablecoinIds) {
  const ex = cfg.sectors.exclude;
  const symbols = new Set(ex.symbols.map((s) => s.toUpperCase()));
  const re = ex.namePattern ? new RegExp(ex.namePattern, 'i') : null;
  return (coin) => {
    if (stablecoinIds.has(coin.id)) return 'stablecoin';
    if (symbols.has(String(coin.symbol).toUpperCase())) return 'izločen simbol';
    if (re && re.test(coin.name ?? '')) return 'zavit/vložen žeton';
    return null;
  };
}

/**
 * Osveži sektorje. Vrne { ok, data, error, warnings }.
 * data: { fetchedAt, categories: { id: { valid, name } }, sectors: [{ id, name, coins: [...] }], excludedCount }
 */
export async function refreshSectors(http, cfg, nowMs, env = process.env) {
  const p = cfg.providers.coingecko;
  const h = headers(cfg, env);
  if (!h) return { ok: false, skipped: true, error: `manjka okoljska spremenljivka ${p.apiKeyEnv}` };
  const warnings = [];

  try {
    const { data: list } = await http.request('coingecko', `${p.baseUrl}/coins/categories/list`, { headers: h });
    if (!Array.isArray(list)) throw new Error('nepričakovan odgovor /coins/categories/list');
    const byId = new Map(list.map((c) => [c.category_id, c.name]));
    const wanted = [...cfg.sectors.list.map((s) => s.id), ...cfg.sectors.libraryOnly, cfg.sectors.exclude.stablecoinCategory];
    const categories = {};
    for (const id of new Set(wanted)) {
      categories[id] = { valid: byId.has(id), name: byId.get(id) ?? null };
      if (!byId.has(id)) warnings.push(`kategorija ${id} ne obstaja v /coins/categories/list`);
    }

    const stableIds = new Set();
    if (categories[cfg.sectors.exclude.stablecoinCategory]?.valid) {
      const url = `${p.baseUrl}/coins/markets?vs_currency=usd&category=${cfg.sectors.exclude.stablecoinCategory}&order=market_cap_desc&per_page=${cfg.sectors.exclude.stablecoinFetchPerPage}&page=1`;
      const { data } = await http.request('coingecko', url, { headers: h });
      for (const c of data ?? []) stableIds.add(c.id);
    }
    const exclude = makeExcluder(cfg, stableIds);

    const sectors = [];
    let excludedCount = 0;
    for (const s of cfg.sectors.list) {
      if (!categories[s.id]?.valid) continue;
      const url = `${p.baseUrl}/coins/markets?vs_currency=usd&category=${encodeURIComponent(s.id)}&order=market_cap_desc&per_page=${cfg.sectors.fetchPerPage}&page=1`;
      const { data } = await http.request('coingecko', url, { headers: h });
      const coins = [];
      for (const c of data ?? []) {
        if (!(c.market_cap > 0)) continue;
        const why = exclude(c);
        if (why) {
          excludedCount++;
          continue;
        }
        coins.push({
          id: c.id,
          symbol: String(c.symbol).toUpperCase(),
          name: c.name,
          marketCap: c.market_cap,
          marketCapRank: c.market_cap_rank ?? null,
        });
        if (coins.length >= cfg.sectors.topN) break;
      }
      sectors.push({ id: s.id, name: s.name, coingeckoName: categories[s.id].name, coins });
    }
    // Tržni vrh (brez kategorije) za tržni indeks – rezerva, ko sektorski indeks nima dovolj članov.
    const market = [];
    {
      const url = `${p.baseUrl}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${cfg.sectors.marketFetchPerPage}&page=1`;
      const { data } = await http.request('coingecko', url, { headers: h });
      for (const c of data ?? []) {
        if (!(c.market_cap > 0) || exclude(c)) continue;
        market.push({ id: c.id, symbol: String(c.symbol).toUpperCase(), name: c.name, marketCap: c.market_cap });
        if (market.length >= cfg.sectors.marketTopN) break;
      }
    }
    return {
      ok: true,
      warnings,
      data: { fetchedAt: toIso(nowMs), categories, sectors, market, stablecoinIds: [...stableIds].sort(), excludedCount },
    };
  } catch (err) {
    return { ok: false, error: err.message, warnings };
  }
}

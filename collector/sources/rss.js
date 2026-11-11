// RSS 2.0 in Atom: branje, normalizacija člankov.
// Članek: { id, url, title, summary, source, publishedAt, ingestedAt }
//   id = sha256(kanonični URL), publishedAt = čas iz feeda (ali null), ingestedAt = čas prvega zajema.

import { XMLParser } from 'fast-xml-parser';
import { canonicalUrl, cleanText, decodeEntities, shortHash } from '../lib/text.js';
import { toIso } from '../lib/time.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false, // entitete dekodiramo sami (enako za CDATA in navadno besedilo)
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  removeNSPrefix: false,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

function text(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') return text(node['#text'] ?? '');
  return '';
}

function parseDate(...candidates) {
  for (const c of candidates) {
    const s = text(c).trim();
    if (!s) continue;
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function atomLink(links) {
  if (!Array.isArray(links)) return '';
  const alt = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  const pick = alt ?? links[0];
  return typeof pick === 'object' ? pick['@_href'] ?? text(pick) : text(pick);
}

/** Vrne { format, items: [{ url, title, summary, publishedMs }] }. Vrže napako, če vsebina ni feed. */
export function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`XML ni berljiv: ${err.message}`);
  }
  if (doc?.rss?.channel) {
    const ch = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
    const items = (ch.item ?? []).map((it) => ({
      url: text(it.link) || (typeof it.guid === 'object' && it.guid['@_isPermaLink'] !== 'false' ? text(it.guid) : ''),
      title: text(it.title),
      summary: text(it.description) || text(it['content:encoded']),
      publishedMs: parseDate(it.pubDate, it['dc:date'], it.published, it.updated),
    }));
    return { format: 'rss2', items };
  }
  if (doc?.feed) {
    const items = (doc.feed.entry ?? []).map((e) => ({
      url: atomLink(e.link),
      title: text(e.title),
      summary: text(e.summary) || text(e.content),
      publishedMs: parseDate(e.published, e.updated),
    }));
    return { format: 'atom', items };
  }
  if (doc?.['rdf:RDF']) {
    const items = (doc['rdf:RDF'].item ?? []).map((it) => ({
      url: text(it.link),
      title: text(it.title),
      summary: text(it.description),
      publishedMs: parseDate(it['dc:date']),
    }));
    return { format: 'rss1', items };
  }
  throw new Error('vsebina ni RSS ali Atom feed');
}

/**
 * Normalizira postavke feeda v članke. Postavke brez URL-ja ali naslova se zavržejo.
 * Prihodnji publishedAt (napačna ura vira) se omeji na nowMs.
 */
export function normalizeItems(items, sourceId, nowMs, { summaryMaxLen = 500 } = {}) {
  const out = [];
  const rejected = [];
  for (const it of items) {
    // processEntities je izklopljen, zato je "&amp;" v povezavi še kodiran.
    const url = canonicalUrl(decodeEntities(String(it.url ?? '').trim()));
    const title = cleanText(it.title, 300);
    if (!url || !title) {
      rejected.push({ reason: !url ? 'neveljaven URL' : 'prazen naslov', raw: String(it.url ?? '').slice(0, 120) });
      continue;
    }
    const pub = it.publishedMs === null ? null : Math.min(it.publishedMs, nowMs);
    out.push({
      id: shortHash(url, 16),
      url,
      title,
      summary: cleanText(it.summary, summaryMaxLen),
      source: sourceId,
      publishedAt: pub === null ? null : toIso(pub),
      ingestedAt: toIso(nowMs),
    });
  }
  return { articles: out, rejected };
}

export function contactUserAgent(cfg, env = process.env) {
  const contact = String(env[cfg.app.contactEnv] ?? '').trim();
  if (!contact) return null;
  if (!/^[\x21-\x7e]+$/.test(contact)) return null; // samo ASCII brez presledkov (HTTP glava)
  return `${cfg.app.userAgent} contact: ${contact}`;
}

/** Prebere en vir. Vrne { ok, format, articles, rejected, error }. Nikoli ne vrže napake. */
export async function fetchSource(http, cfg, source, nowMs, env = process.env) {
  try {
    const headers = { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' };
    if (source.requiresContact) {
      const ua = contactUserAgent(cfg, env);
      if (!ua) {
        return { ok: false, skipped: true, articles: [], rejected: [], error: `manjka ali neveljavna okoljska spremenljivka ${cfg.app.contactEnv} (vir zahteva kontakt v User-Agent; samo ASCII)` };
      }
      headers['User-Agent'] = ua;
    }
    const { data } = await http.request(`rss:${source.id}`, source.url, { as: 'text', headers });
    const feed = parseFeed(data);
    const { articles, rejected } = normalizeItems(feed.items, source.id, nowMs);
    return { ok: true, format: feed.format, articles, rejected, error: null };
  } catch (err) {
    return { ok: false, articles: [], rejected: [], error: err.message };
  }
}

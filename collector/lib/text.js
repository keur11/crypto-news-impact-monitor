// Besedilni pripomočki: HTML entitete, odstranjevanje oznak, kanonični URL, zgoščevanje.

import { createHash } from 'node:crypto';

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•',
};

export function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

export function stripHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

export function cleanText(s, maxLen = Infinity) {
  // Entitete najprej, da &lt;p&gt; postane oznaka in se odstrani; nato še enkrat za dvojno kodirane.
  const t = decodeEntities(stripHtml(decodeEntities(String(s ?? '')))).replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1).replace(/\s+\S*$/, '')}…`;
}

const TRACKING = /^(utm_|mc_|fbclid$|gclid$|ref$|ref_src$|cmpid$|ocid$)/i;

export function canonicalUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = u.toString();
  if (u.pathname.length > 1 && s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s;
}

export function shortHash(s, len = 12) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, len);
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

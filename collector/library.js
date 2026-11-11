// Referenčna knjižnica: validacija ročnega vnosa, ocenjevalno okno, M_ref, kriterij sprejema.

import { DAY, HOUR, parseIso, startOfUtcDay, toIso, floorTo } from './lib/time.js';
import { median } from './lib/stats.js';
import { snowflakeToMs, tweetIdFromUrl } from './lib/snowflake.js';

const REQUIRED = ['id', 'title', 't0', 't0Precision', 'type', 'primaryAsset', 'assets', 'milestones', 'confounders'];
const URL_RE = /^https?:\/\//;

export function t0SourceUrl(src) {
  if (typeof src === 'string') return src;
  return src && typeof src === 'object' ? src.url : null;
}

/**
 * t0Source je URL (niz) ali objekt:
 *   { url, method: 'x_snowflake' | 'publication_time', tweetId?, timestampMs?, formula?, corroboration?: [...] }
 * Pri method 'x_snowflake' se preveri, da se tweetId ujema z URL-jem, timestampMs z izračunom
 * in t0 s timestampMs (t0 je zaokrožen na sekundo navzdol).
 */
function validateT0Source(e, t0) {
  const errors = [];
  const src = e.t0Source;
  const url = t0SourceUrl(src);
  if (typeof url !== 'string' || !URL_RE.test(url)) {
    errors.push('pri t0Precision "hour" je t0Source z URL-jem obvezen');
    return errors;
  }
  if (typeof src !== 'object') return errors;
  if (!['x_snowflake', 'publication_time'].includes(src.method)) {
    errors.push('t0Source.method mora biti "x_snowflake" ali "publication_time"');
  }
  const checkTweet = (obj, label) => {
    if (tweetIdFromUrl(obj.url) !== obj.tweetId) errors.push(`${label}: tweetId se ne ujema z URL-jem`);
    let ms;
    try {
      ms = snowflakeToMs(obj.tweetId);
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return null;
    }
    if (obj.timestampMs !== ms) errors.push(`${label}: timestampMs (${obj.timestampMs}) ≠ izračun iz ID (${ms})`);
    return ms;
  };
  if (src.method === 'x_snowflake') {
    const ms = checkTweet(src, 't0Source');
    if (ms !== null && t0 !== undefined && t0 !== Math.floor(ms / 1000) * 1000) {
      errors.push(`t0 (${e.t0}) se ne ujema s časom tweeta (${toIso(Math.floor(ms / 1000) * 1000)})`);
    }
  }
  for (const [i, c] of (src.corroboration ?? []).entries()) {
    if (c.tweetId) checkTweet(c, `t0Source.corroboration[${i}]`);
  }
  return errors;
}

export function validateLibraryEntry(e) {
  const errors = [];
  for (const f of REQUIRED) if (e[f] === undefined) errors.push(`manjka polje ${f}`);
  if (errors.length) return errors;

  if (!/^[a-z0-9_]+$/.test(e.id)) errors.push('id sme vsebovati le male črke, številke in _');
  let t0;
  try {
    t0 = parseIso(e.t0);
  } catch (err) {
    errors.push(err.message);
  }
  if (!['hour', 'day'].includes(e.t0Precision)) {
    errors.push('t0Precision mora biti "hour" ali "day"');
  } else if (e.t0Precision === 'hour') {
    errors.push(...validateT0Source(e, t0));
  } else if (t0 !== undefined && t0 !== startOfUtcDay(t0)) {
    errors.push('pri t0Precision "day" mora biti t0 ob 00:00:00Z');
  }
  if (!Array.isArray(e.assets) || e.assets.length === 0) errors.push('assets mora biti neprazna tabela');
  else if (!e.assets.includes(e.primaryAsset)) errors.push('primaryAsset mora biti v assets');
  if (e.actors !== undefined && (!Array.isArray(e.actors) || e.actors.some((a) => typeof a !== 'string' || !a.startsWith('@')))) {
    errors.push('actors mora biti tabela ID-jev akterjev ("@SEC" …)');
  }

  const t0Day = t0 === undefined ? null : startOfUtcDay(t0);
  for (const key of ['milestones', 'confounders']) {
    if (!Array.isArray(e[key])) {
      errors.push(`${key} mora biti tabela`);
      continue;
    }
    e[key].forEach((x, i) => {
      if (!x || typeof x.label !== 'string') errors.push(`${key}[${i}]: manjka label`);
      let d;
      try {
        d = parseIso(x.date);
      } catch {
        errors.push(`${key}[${i}]: neveljaven datum ${x?.date}`);
        return;
      }
      // Pri vnosih pred dnem t0 mora biti odločitev o oknu eksplicitna.
      if (t0Day !== null && startOfUtcDay(d) < t0Day && typeof x.affectsEstimation !== 'boolean') {
        errors.push(`${key}[${i}] (${x.date}) je pred dnem t0: affectsEstimation (true/false) je obvezen`);
      }
      if (x.affectsEstimation !== undefined && typeof x.affectsEstimation !== 'boolean') {
        errors.push(`${key}[${i}]: affectsEstimation mora biti true ali false`);
      }
    });
  }
  return errors;
}

export function validateLibrary(entries) {
  if (!Array.isArray(entries)) throw new Error('library.json mora vsebovati tabelo dogodkov');
  const ids = new Set();
  const problems = [];
  for (const e of entries) {
    const errs = validateLibraryEntry(e);
    if (ids.has(e.id)) errs.push('podvojen id');
    ids.add(e.id);
    for (const msg of errs) problems.push(`${e.id ?? '(brez id)'}: ${msg}`);
  }
  if (problems.length) throw new Error(`Neveljavna knjižnica:\n  ${problems.join('\n  ')}`);
  return entries;
}

/**
 * Ocenjevalno okno za referenčni dogodek.
 * Konča se estimationGapDays pred prvim mejnikom ali sočasnim dejavnikom z
 * affectsEstimation = true, ki je pred dnem t0 (predhodniki dogodka, izredni dejavniki).
 * Načrtovane makro objave (affectsEstimation = false) okna ne premaknejo – sodijo v σ.
 * Če takega vnosa ni, se okno konča estimationGapDays pred t0 (kot pri živih dogodkih).
 * Žive dogodke obravnava market.estimationWindowLive.
 */
export function libraryEstimationWindow(entry, cfg, stepMs = HOUR) {
  const m = cfg.market;
  const t0 = parseIso(entry.t0);
  const t0Day = startOfUtcDay(t0);
  const pre = [...entry.milestones, ...entry.confounders]
    .filter((x) => x.affectsEstimation === true)
    .map((x) => ({ ms: startOfUtcDay(parseIso(x.date)), label: x.label, date: x.date }))
    .filter((x) => x.ms < t0Day)
    .sort((a, b) => a.ms - b.ms);

  if (pre.length) {
    const end = pre[0].ms - m.estimationGapDays * DAY;
    return {
      start: end - m.estimationDays * DAY,
      end,
      rule: 'first_pre_event',
      anchor: { date: pre[0].date, label: pre[0].label },
    };
  }
  const end = floorTo(t0, stepMs) - m.estimationGapDays * DAY;
  return { start: end - m.estimationDays * DAY, end, rule: 'before_t0', anchor: null };
}

export function windowToIso(w) {
  return { start: toIso(w.start), end: toIso(w.end), rule: w.rule, anchor: w.anchor ?? null };
}

/**
 * M_ref24 in M_ref72 = mediana M24 / M72 primarnih sredstev knjižnice.
 * events: [{ id, measured: { M24, M72 } }]
 */
export function computeRefs(events) {
  const with24 = events.filter((e) => Number.isFinite(e.measured?.M24));
  const with72 = events.filter((e) => Number.isFinite(e.measured?.M72));
  return {
    M_ref24: median(with24.map((e) => e.measured.M24)),
    M_ref72: median(with72.map((e) => e.measured.M72)),
    n24: with24.length,
    n72: with72.length,
    events24: with24.map((e) => e.id),
    events72: with72.map((e) => e.id),
  };
}

/**
 * Stanje izmerjene knjižnice (data/library.json) za zbiralnik in vmesnik.
 * measured = obstaja M_ref24 in vsaj en dogodek z M24. Brez tega ocene niso kalibrirane:
 * T iz privzetih vrednosti, A = 0, brez ExPost, status "expected" (uveljavi 4. korak).
 */
export function libraryState(libJson, cfg) {
  const w = cfg.status.libraryWarnings;
  if (!libJson || !Array.isArray(libJson.events)) {
    return { exists: Boolean(libJson), measured: false, partial: false, nEvents: 0, nMeasured: 0, refs: null, warning: w.unmeasured };
  }
  const nEvents = libJson.events.length;
  const nMeasured = libJson.events.filter((e) => Number.isFinite(e.measured?.M24)).length;
  const refsOk = Number.isFinite(libJson.refs?.M_ref24);
  const measured = refsOk && nMeasured > 0;
  const partial = measured && nMeasured < nEvents;
  return {
    exists: true,
    measured,
    partial,
    nEvents,
    nMeasured,
    refs: measured ? { M_ref24: libJson.refs.M_ref24, M_ref72: libJson.refs.M_ref72 ?? null } : null,
    warning: !measured ? w.unmeasured : partial ? `${w.partial} (${nMeasured}/${nEvents})` : null,
  };
}

// Rang dogodka po vrednosti valueOf(e) padajoče (1 = največji). null, če vrednosti ni.
export function rankBy(events, id, valueOf) {
  const sorted = events
    .map((e) => ({ id: e.id, v: valueOf(e) }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v);
  const idx = sorted.findIndex((x) => x.id === id);
  return idx === -1 ? null : idx + 1;
}

export const rankByM72 = (events, id) => rankBy(events, id, (e) => e.measured?.M72);
export const rankByAbsAR72 = (events, id) =>
  rankBy(events, id, (e) => (Number.isFinite(e.measured?.AR72) ? Math.abs(e.measured.AR72) : null));

/**
 * Kriterij sprejema za ciljni dogodek (privzeto LUNC pri luna_crash_2022):
 *   rang po |AR72| ≤ maxRankAbsAR72  IN  rang po M72 ≤ maxRankM72.
 * |AR72| je surovi abnormalni donos (nedvoumen), M72 je normaliziran s σ pred dogodkom,
 * zato ima lahko sredstvo z nizko predhodno volatilnostjo legitimno višji M72.
 */
export function evaluateLargestImpact(events, { event, maxRankAbsAR72, maxRankM72 }) {
  const rankAR = rankByAbsAR72(events, event);
  const rankM = rankByM72(events, event);
  let result;
  if (rankAR === null || rankM === null) result = 'n/a';
  else result = rankAR <= maxRankAbsAR72 && rankM <= maxRankM72 ? 'pass' : 'fail';
  const detail =
    result === 'n/a'
      ? `${event}: |AR72| ali M72 primarnega sredstva ni izračunan (glej measured.primaryReason)`
      : `${event}: rang po |AR72| = ${rankAR} (zahtevano ≤ ${maxRankAbsAR72}), rang po M72 = ${rankM} (zahtevano ≤ ${maxRankM72})`;
  return { event, rankAbsAR72: rankAR, rankM72: rankM, maxRankAbsAR72, maxRankM72, result, detail };
}

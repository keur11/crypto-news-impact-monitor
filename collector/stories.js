// Zgodbe (story) nad dogodki in faktor novosti N.
//
// Pripenjanje: dogodek se pripne obstoječi zgodbi, če se ujema z njenim PRVIM dogodkom in je zadnji
// dogodek zgodbe mlajši od maxGapDays (7 dni). Ujemanje (prag jaccardMin = 0,5):
//   - če ima vsaj ena stran specifičen kovanec (ne ozadje BTC/ETH/SOL): Jaccard specifičnih kovancev;
//   - sicer: Jaccard(ozadje ∪ akterji), le če je prisoten vsaj en akter (sam "BTC" ne veriži zgodb).
// Dodelitev je inkrementalna in trajna (storyId se ne spreminja).
//
// Faktor novosti: prvi dogodek N = 1,0; nadaljnji N = 0,5; eskalacija (prehod v višjo stopnjo po pravilih
// config.stories.escalation, tip se v zgodbi pojavi prvič) N = 1,0. ExAnte_eff = ExAnte · N.

import { DAY, toIso } from './lib/time.js';
import { isActor, jaccard } from './entities.js';

const PASSIVE_ACTOR_KINDS = new Set(['regulator', 'authority', 'central_bank']);

export function storyKey(entities, dict) {
  const bg = dict.background ?? new Set();
  const coins = (entities ?? []).filter((e) => !isActor(e));
  return {
    specific: coins.filter((c) => !bg.has(c)),
    generic: coins.filter((c) => bg.has(c)),
    actors: (entities ?? []).filter(isActor),
  };
}

export function keysMatch(a, b, cfg) {
  const min = cfg.stories.jaccardMin;
  if (a.specific.length || b.specific.length) return jaccard(a.specific, b.specific) >= min;
  if (!a.actors.length && !b.actors.length) return false;
  return jaccard([...a.generic, ...a.actors], [...b.generic, ...b.actors]) >= min;
}

/** Glavna entiteta zgodbe (cilj pravila "regulation proti glavni entiteti"). */
export function storyPrimary(key, dict) {
  if (key.specific.length) return key.specific[0];
  const target = key.actors.find((a) => !PASSIVE_ACTOR_KINDS.has(dict.actors?.[a]?.kind));
  if (target) return target;
  return key.generic[0] ?? null;
}

const evType = (e) => e.exAnte?.type ?? e.type;

/**
 * Dodeli storyId dogodkom brez njega in posodobi zgodbe.
 * @returns { stories: { stories: [...] }, assigned: Map(eventId → storyId) }
 */
export function assignStories(events, storiesDoc, cfg, dict, nowMs) {
  const sc = cfg.stories;
  const stories = new Map((storiesDoc?.stories ?? []).map((s) => [s.id, { ...s, events: [...s.events] }]));
  const assigned = new Map();

  // Posodobi znane dogodke (tip se lahko spremeni, dokler ExAnte ni zamrznjen)
  for (const e of events) {
    if (!e.storyId || !stories.has(e.storyId)) continue;
    const s = stories.get(e.storyId);
    const i = s.events.findIndex((x) => x.id === e.id);
    const rec = { id: e.id, firstSeenAt: e.firstSeenAt, type: evType(e) };
    if (i === -1) s.events.push(rec);
    else s.events[i] = rec;
  }

  const fresh = events
    .filter((e) => !e.storyId || !stories.has(e.storyId))
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  for (const e of fresh) {
    const t = Date.parse(e.firstSeenAt);
    const key = storyKey(e.entities, dict);
    let best = null;
    for (const s of stories.values()) {
      if (t - Date.parse(s.lastSeenAt) > sc.maxGapDays * DAY) continue;
      if (!keysMatch(key, s.key, cfg)) continue;
      if (!best || s.lastSeenAt > best.lastSeenAt || (s.lastSeenAt === best.lastSeenAt && s.id < best.id)) best = s;
    }
    const rec = { id: e.id, firstSeenAt: e.firstSeenAt, type: evType(e) };
    if (best) {
      best.events.push(rec);
      assigned.set(e.id, best.id);
    } else {
      const id = `sty_${e.id.replace(/^evt_/, '')}`;
      stories.set(id, { id, firstEventId: e.id, firstSeenAt: e.firstSeenAt, lastSeenAt: e.firstSeenAt, key, primary: storyPrimary(key, dict), events: [rec] });
      assigned.set(e.id, id);
    }
  }

  const minKeep = nowMs - sc.retentionDays * DAY;
  const out = [];
  for (const s of stories.values()) {
    s.events.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
    s.lastSeenAt = s.events.reduce((m, x) => (x.firstSeenAt > m ? x.firstSeenAt : m), s.firstSeenAt);
    if (Date.parse(s.lastSeenAt) >= minKeep) out.push(s);
  }
  out.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  return { stories: { updatedAt: toIso(nowMs), stories: out }, assigned };
}

/** Faktor novosti za dogodek glede na prejšnje dogodke njegove zgodbe. */
export function novelty(event, story, cfg) {
  const sc = cfg.stories;
  const list = story?.events ?? [];
  const idx = list.findIndex((x) => x.id === event.id);
  if (!story || idx <= 0) return { N: sc.novelty.first, reason: 'first', index: 1, escalation: null };
  const prev = list.slice(0, idx);
  const prevTypes = new Set(prev.map((x) => x.type));
  const type = evType(event);
  if (!prevTypes.has(type)) {
    for (const r of sc.escalation) {
      if (r.to !== type) continue;
      if (r.from !== '*' && !r.from.some((f) => prevTypes.has(f))) continue;
      if (r.requireTargetsStoryPrimary && !(story.primary && (event.entities ?? []).includes(story.primary))) continue;
      const from = r.from === '*' ? prev[prev.length - 1].type : r.from.find((f) => prevTypes.has(f));
      return { N: sc.novelty.escalation, reason: 'escalation', index: idx + 1, escalation: { from, to: type, label: r.label } };
    }
  }
  return { N: sc.novelty.followUp, reason: 'follow_up', index: idx + 1, escalation: null };
}

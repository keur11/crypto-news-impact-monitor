// Zgodbe, faktor novosti, shared_impact med zgodbami, koledar makro objav.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDictionary } from '../collector/entities.js';
import { assignStories, keysMatch, novelty, storyKey, storyPrimary } from '../collector/stories.js';
import { sharedImpactIds } from '../collector/score.js';
import { macroCalendarStatus } from '../collector/scoring.js';
import { DAY, HOUR, toIso } from '../collector/lib/time.js';
import { loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const dict = buildDictionary(cfg, JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sectors.json'), 'utf8')));
const T0 = Date.parse('2026-10-29T21:49:16Z');
const ev = (id, h, entities, type) => ({ id, firstSeenAt: toIso(T0 + h * HOUR), entities, exAnte: { type } });
const key = (ents) => storyKey(ents, dict);

test('config: parametri zgodb in novosti', () => {
  assert.deepEqual(cfg.stories.novelty, { first: 1, followUp: 0.5, escalation: 1 });
  assert.equal(cfg.stories.jaccardMin, 0.5);
  assert.equal(cfg.stories.maxGapDays, 7);
});

test('ujemanje s prvim dogodkom zgodbe: specifični kovanci, ozadje, akterji', () => {
  assert.ok(keysMatch(key(['BNB', '@FBI', '@NORTH_KOREA']), key(['BNB']), cfg), 'FBI ↔ Binance hack: specifičen BNB');
  assert.ok(keysMatch(key(['BNB', 'RUNE']), key(['BNB']), cfg), 'J = 1/2');
  assert.ok(!keysMatch(key(['BNB', 'RUNE', 'HYPE']), key(['BNB']), cfg), 'J = 1/3');
  assert.ok(!keysMatch(key(['BTC']), key(['BTC']), cfg), 'sam BTC (brez akterjev) ne veriži zgodb');
  assert.ok(!keysMatch(key(['@SEC', '@COINBASE']), key(['BTC', '@SEC']), cfg), 'SEC/Coinbase ↔ SEC/BTC ETF: J = 1/3');
  assert.ok(keysMatch(key(['@SEC', '@COINBASE']), key(['@COINBASE', '@SEC']), cfg));
  assert.ok(keysMatch(key(['BTC', '@CN_REGULATORS']), key(['@CN_REGULATORS']), cfg), 'Kitajska: J = 1/2 z akterjem');
  assert.ok(!keysMatch(key(['ETH', '@SEC']), key(['BTC', '@SEC']), cfg), 'ETH ETF ↔ BTC ETF');
  assert.ok(!keysMatch(key(['BNB']), key(['BTC', '@SEC']), cfg), 'specifičen proti generičnemu');
});

test('glavna entiteta zgodbe: specifičen kovanec, sicer akter, ki ni regulator', () => {
  assert.equal(storyPrimary(key(['BNB', '@FBI']), dict), 'BNB');
  assert.equal(storyPrimary(key(['@SEC', '@COINBASE']), dict), '@COINBASE');
  assert.equal(storyPrimary(key(['BTC', '@CN_REGULATORS']), dict), 'BTC');
});

test('dodelitev: časovna vrzel 7 dni, stabilni storyId, pripenjanje k prvemu dogodku', () => {
  const evs = [
    ev('evt_a', 0, ['BNB'], 'hack'),
    ev('evt_b', 30, ['BNB', '@FBI'], 'hack'),
    ev('evt_c', 40, ['LINK'], 'hack'),
    ev('evt_d', 30 + 8 * 24, ['BNB'], 'hack'), // 8 dni po zadnjem (b) → nova zgodba
  ];
  const r1 = assignStories(evs.slice(0, 3), null, cfg, dict, T0 + 2 * DAY);
  assert.equal(r1.assigned.get('evt_a'), 'sty_a');
  assert.equal(r1.assigned.get('evt_b'), 'sty_a');
  assert.equal(r1.assigned.get('evt_c'), 'sty_c');
  const withIds = evs.slice(0, 3).map((e) => ({ ...e, storyId: r1.assigned.get(e.id) }));
  const r2 = assignStories([...withIds, evs[3]], r1.stories, cfg, dict, T0 + 10 * DAY);
  assert.equal(r2.assigned.size, 1, 'obstoječi dogodki ohranijo storyId');
  assert.equal(r2.assigned.get('evt_d'), 'sty_d', 'vrzel > 7 dni');
  const sa = r2.stories.stories.find((s) => s.id === 'sty_a');
  assert.deepEqual(sa.events.map((x) => x.id), ['evt_a', 'evt_b']);
  assert.equal(sa.lastSeenAt, evs[1].firstSeenAt);
  assert.equal(sa.primary, 'BNB');
});

test('novost: prvi 1,0, nadaljnji 0,5, eskalacija 1,0 (hack → insolvency, → regulation proti glavni entiteti, → protocol_failure)', () => {
  const story = (types, primary = 'BNB') => ({ primary, events: types.map((t, i) => ({ id: `e${i}`, firstSeenAt: toIso(T0 + i * HOUR), type: t })) });
  const at = (s, i, entities = ['BNB']) => novelty({ id: `e${i}`, entities, exAnte: { type: s.events[i].type } }, s, cfg);

  const s1 = story(['hack', 'hack', 'insolvency', 'insolvency', 'regulation', 'protocol_failure', 'listing']);
  assert.deepEqual(at(s1, 0), { N: 1, reason: 'first', index: 1, escalation: null });
  assert.equal(at(s1, 1).N, 0.5, 'hack → hack');
  assert.deepEqual(at(s1, 2).escalation, { from: 'hack', to: 'insolvency', label: 'hack → insolvency' });
  assert.equal(at(s1, 2).N, 1);
  assert.equal(at(s1, 3).N, 0.5, 'insolvency drugič ni eskalacija');
  assert.equal(at(s1, 4).N, 1, 'regulation, ki zadeva BNB');
  assert.equal(at(s1, 4).escalation.from, 'insolvency');
  assert.equal(at(s1, 4, ['@SEC']).N, 0.5, 'regulation, ki ne zadeva glavne entitete');
  assert.equal(at(s1, 5).N, 1, '→ protocol_failure iz katerega koli tipa');
  assert.equal(at(s1, 6).N, 0.5, 'listing ni eskalacija');

  const s2 = story(['upgrade', 'insolvency']);
  assert.equal(at(s2, 1).N, 0.5, 'insolvency brez predhodnega hacka ni eskalacija');
  assert.equal(novelty({ id: 'x', entities: [] }, null, cfg).N, 1, 'brez zgodbe');
});

test('shared_impact samo med dogodki različnih zgodb', () => {
  const t = (h) => toIso(T0 + h * HOUR);
  const evs = [
    { id: 'e1', storyId: 's1', firstSeenAt: t(0), market: { asset: 'BNB' } },
    { id: 'e2', storyId: 's1', firstSeenAt: t(5), market: { asset: 'BNB' } },
    { id: 'e3', storyId: 's2', firstSeenAt: t(10), market: { asset: 'BNB' } },
    { id: 'e4', storyId: 's3', firstSeenAt: t(40), market: { asset: 'BNB' } },
  ];
  assert.deepEqual([...sharedImpactIds(evs, cfg)].sort(), ['e1', 'e2', 'e3'], 'e1–e2 ista zgodba; e3 z obema; e4 izven 24 h');
  assert.deepEqual([...sharedImpactIds(evs.slice(0, 2), cfg)], [], 'znotraj zgodbe se ne označuje');
  const mk = [
    { id: 'm1', storyId: 'a', firstSeenAt: t(0), primaryAsset: 'HYPE', market: { kind: 'market', asset: 'market:top' } },
    { id: 'm2', storyId: 'b', firstSeenAt: t(1), primaryAsset: 'XYZ', market: { kind: 'market', asset: 'market:top' } },
  ];
  assert.deepEqual([...sharedImpactIds(mk, cfg)], [], 'tržni indeks ni skupna entiteta');
});

test('koledar makro objav: opozorilo, ko pokriva < 60 dni vnaprej', () => {
  const ok = macroCalendarStatus(cfg, Date.parse('2026-11-02T00:00:00Z'));
  assert.equal(ok.warning, null);
  assert.equal(ok.coveredUntil.fomc, '2027-12-08T19:00:00Z');
  assert.equal(ok.coveredUntil.cpi, '2027-12-10T13:30:00Z');
  const late = macroCalendarStatus(cfg, Date.parse('2027-10-15T00:00:00Z'));
  assert.match(late.warning, /FOMC, CPI.*60 dni/);
  assert.equal(late.daysAhead, 54);
  const cpiOnly = macroCalendarStatus({ ...cfg, macroEvents: { ...cfg.macroEvents, events: cfg.macroEvents.events.filter((m) => m.kind === 'fomc' || m.at < '2027-01-01') } }, Date.parse('2026-11-02T00:00:00Z'));
  assert.match(cpiOnly.warning, /\(CPI\)/);
});

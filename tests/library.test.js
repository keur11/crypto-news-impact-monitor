import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRefs,
  evaluateLargestImpact,
  libraryEstimationWindow,
  rankByAbsAR72,
  rankByM72,
  validateLibrary,
  validateLibraryEntry,
} from '../collector/library.js';
import { snowflakeToMs, tweetIdFromUrl } from '../collector/lib/snowflake.js';
import { DAY, HOUR, parseIso, toIso } from '../collector/lib/time.js';
import { loadConfig, loadLibrary } from './helpers.js';

const cfg = loadConfig();
const lib = loadLibrary();
const byId = Object.fromEntries(lib.map((e) => [e.id, e]));

test('config/library.json je veljaven', () => {
  assert.doesNotThrow(() => validateLibrary(lib));
  assert.equal(lib.length, 5);
  const actorIds = new Set(cfg.actors.map((a) => a.id));
  for (const e of lib) {
    assert.ok(cfg.assets[e.primaryAsset], `${e.id}: primaryAsset ${e.primaryAsset} v config.assets`);
    for (const a of e.actors ?? []) assert.ok(actorIds.has(a), `${e.id}: akter ${a} v config.actors`);
  }
  assert.ok(validateLibraryEntry({ ...byId.mtgox_2014, actors: ['SEC'] }).some((m) => m.includes('actors')));
});

test('X Snowflake: (id >> 22) + 1288834974657', () => {
  // Ročno: 1590012124864348160 >> 22 = 379088431564; + 1288834974657 = 1667923406221
  assert.equal(snowflakeToMs('1590012124864348160'), 1667923406221);
  assert.equal(new Date(snowflakeToMs('1590012124864348160')).toISOString(), '2022-11-08T16:03:26.221Z');
  assert.equal(new Date(snowflakeToMs('1590013613586411520')).toISOString(), '2022-11-08T16:09:21.160Z');
  assert.equal(new Date(snowflakeToMs('1125839310891053057')).toISOString(), '2019-05-07T19:06:23.456Z');
  assert.equal(snowflakeToMs('1125839310891053057'), 1557255983456);
  assert.equal(tweetIdFromUrl('https://twitter.com/SBF_FTX/status/1590012124864348160'), '1590012124864348160');
  assert.equal(tweetIdFromUrl('https://x.com/a/status/42?s=19'), '42');
  assert.throws(() => snowflakeToMs('12a'));
});

test('t0 iz vira: FTX iz tweeta SBF (na sekundo), Kitajska in Binance iz časa objave', () => {
  assert.equal(parseIso(byId.ftx_collapse_2022.t0), Math.floor(1667923406221 / 1000) * 1000);
  assert.equal(byId.china_mining_ban_2021.t0, '2021-05-21T14:00:00Z', 'gov.cn 22:00 Asia/Shanghai');
  assert.equal(byId.binance_hack_2019.t0, '2019-05-07T23:34:00Z');
  assert.ok(byId.binance_hack_2019.milestones.some((m) => m.date === '2019-05-07T17:15:24Z'), 'vdor kot mejnik');
  assert.ok(byId.ftx_collapse_2022.milestones.some((m) => m.date === '2022-11-08T11:37:00Z'), 'zadnja transakcija kot mejnik');
});

test('validacija t0Source: Snowflake se mora ujemati z ID, URL in t0', () => {
  const ftx = byId.ftx_collapse_2022;
  assert.deepEqual(validateLibraryEntry(ftx), []);
  const bad = (patch) => validateLibraryEntry({ ...ftx, t0Source: { ...ftx.t0Source, ...patch } });
  assert.ok(bad({ timestampMs: 1667923406000 }).some((m) => m.includes('timestampMs')));
  assert.ok(bad({ tweetId: '1590013613586411520' }).some((m) => m.includes('ne ujema z URL')));
  assert.ok(
    validateLibraryEntry({ ...ftx, t0: '2022-11-08T16:00:00Z' }).some((m) => m.includes('ne ujema s časom tweeta')),
  );
  const badCorr = structuredClone(ftx);
  badCorr.t0Source.corroboration[0].timestampMs += 1;
  assert.ok(validateLibraryEntry(badCorr).some((m) => m.includes('corroboration[0]')));
  assert.ok(validateLibraryEntry({ ...ftx, t0Source: null }).some((m) => m.includes('t0Source')));
  assert.ok(validateLibraryEntry({ ...ftx, t0Source: { url: 'https://a.b', method: 'guess' } }).some((m) => m.includes('method')));
  assert.deepEqual(validateLibraryEntry({ ...ftx, t0Source: 'https://example.com/x' }), [], 'navaden URL je dovoljen');
});

test('validacija: dan natančno, primaryAsset, podvojen id', () => {
  const base = structuredClone(byId.mtgox_2014);
  assert.deepEqual(validateLibraryEntry(base), []);
  assert.ok(validateLibraryEntry({ ...base, t0: '2014-02-24T05:00:00Z' }).some((m) => m.includes('00:00:00Z')));
  assert.ok(validateLibraryEntry({ ...base, primaryAsset: 'XRP' }).some((m) => m.includes('primaryAsset')));
  assert.throws(() => validateLibrary([base, base]), /podvojen id/);
});

test('validacija: affectsEstimation je obvezen pri vnosih pred dnem t0', () => {
  const e = structuredClone(byId.luna_crash_2022);
  delete e.confounders[0].affectsEstimation; // FOMC 4. 5.
  assert.ok(validateLibraryEntry(e).some((m) => m.includes('affectsEstimation')));
  const after = structuredClone(byId.luna_crash_2022);
  delete after.confounders[1].affectsEstimation; // CPI 11. 5. je po t0 → ni obvezen
  assert.deepEqual(validateLibraryEntry(after), []);
  const wrongType = structuredClone(byId.luna_crash_2022);
  wrongType.confounders[1].affectsEstimation = 'no';
  assert.ok(validateLibraryEntry(wrongType).some((m) => m.includes('true ali false')));
});

test('ocenjevalno okno knjižnice: konec 1 dan pred prvim vnosom z affectsEstimation = true', () => {
  const cases = {
    ftx_collapse_2022: ['2022-10-02T00:00:00Z', '2022-11-01T00:00:00Z', '2022-11-02'],
    // FOMC 4. 5. ima affectsEstimation = false → okno se konča pred razvezavo UST 7. 5.
    luna_crash_2022: ['2022-04-06T00:00:00Z', '2022-05-06T00:00:00Z', '2022-05-07'],
    china_mining_ban_2021: ['2021-04-11T00:00:00Z', '2021-05-11T00:00:00Z', '2021-05-12'],
    mtgox_2014: ['2014-01-07T00:00:00Z', '2014-02-06T00:00:00Z', '2014-02-07'],
  };
  for (const [id, [start, end, anchor]] of Object.entries(cases)) {
    const w = libraryEstimationWindow(byId[id], cfg, HOUR);
    assert.equal(toIso(w.start), start, `${id} start`);
    assert.equal(toIso(w.end), end, `${id} end`);
    assert.equal(w.rule, 'first_pre_event');
    assert.equal(w.anchor.date, anchor);
  }
});

test('makro dejavnik z affectsEstimation = false okna ne premakne', () => {
  const e = structuredClone(byId.luna_crash_2022);
  e.confounders[0].affectsEstimation = true;
  assert.equal(toIso(libraryEstimationWindow(e, cfg, HOUR).end), '2022-05-03T00:00:00Z', 'kontrola: s true se premakne');
  const none = {
    ...byId.binance_hack_2019,
    confounders: [{ date: '2019-05-01', label: 'FOMC', affectsEstimation: false }],
  };
  assert.equal(libraryEstimationWindow(none, cfg, HOUR).rule, 'before_t0');
});

test('ocenjevalno okno brez predhodnikov: t0 − 1 d na meji sveče; mejniki na dan t0 se ne štejejo', () => {
  const w = libraryEstimationWindow(byId.binance_hack_2019, cfg, HOUR);
  assert.equal(w.rule, 'before_t0', 'vdor 17:15 in tweet 19:06 sta na dan t0');
  assert.equal(toIso(w.end), '2019-05-06T23:00:00Z');
  assert.equal(w.end - w.start, 30 * DAY);
  assert.equal(toIso(libraryEstimationWindow(byId.binance_hack_2019, cfg, DAY).end), '2019-05-06T00:00:00Z');
});

test('M_ref24 in M_ref72 kot mediani; rangi po M72 in |AR72|', () => {
  const ev = [
    { id: 'a', measured: { M24: 1, M72: 10, AR72: -0.5 } },
    { id: 'b', measured: { M24: 3, M72: 2, AR72: -2 } },
    { id: 'c', measured: { M24: 2, M72: null, AR72: null } },
    { id: 'd', measured: { M24: null, M72: 4, AR72: 0.9 } },
  ];
  const r = computeRefs(ev);
  assert.equal(r.M_ref24, 2);
  assert.equal(r.n24, 3);
  assert.equal(r.M_ref72, 4);
  assert.deepEqual(r.events72, ['a', 'b', 'd']);
  assert.equal(rankByM72(ev, 'a'), 1);
  assert.equal(rankByM72(ev, 'b'), 3);
  assert.equal(rankByM72(ev, 'c'), null);
  assert.equal(rankByAbsAR72(ev, 'b'), 1);
  assert.equal(rankByAbsAR72(ev, 'd'), 2);
});

test('kriterij največjega vpliva: |AR72| rang 1 in M72 rang ≤ 2', () => {
  const rule = { event: 'luna', maxRankAbsAR72: 1, maxRankM72: 2 };
  const ev = (luna, ftt, btc) => [
    { id: 'luna', measured: luna },
    { id: 'ftx', measured: ftt },
    { id: 'china', measured: btc },
  ];
  // FTT ima višji M72 (nizka predhodna σ), LUNC večji surovi padec → pass
  const pass = evaluateLargestImpact(ev({ AR72: -9, M72: 20 }, { AR72: -1.5, M72: 35 }, { AR72: -0.1, M72: 3 }), rule);
  assert.equal(pass.result, 'pass');
  assert.equal(pass.rankAbsAR72, 1);
  assert.equal(pass.rankM72, 2);
  // LUNC tretji po M72 → fail
  const failM = evaluateLargestImpact(ev({ AR72: -9, M72: 2 }, { AR72: -1.5, M72: 35 }, { AR72: -0.1, M72: 3 }), rule);
  assert.equal(failM.result, 'fail');
  // LUNC ni največji po |AR72| → fail
  const failAR = evaluateLargestImpact(ev({ AR72: -1, M72: 40 }, { AR72: -1.5, M72: 35 }, { AR72: -0.1, M72: 3 }), rule);
  assert.equal(failAR.result, 'fail');
  // brez podatkov → n/a
  assert.equal(evaluateLargestImpact(ev({ AR72: null, M72: null }, { AR72: -1, M72: 1 }, {}), rule).result, 'n/a');
});

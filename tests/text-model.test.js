// TF-IDF, entitete in klasifikacija.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIdf, cosine, stem, tokenize, vectorize } from '../collector/lib/tfidf.js';
import { buildDictionary, findActors, findEntities, mainEntities, sectorsOf } from '../collector/entities.js';
import { createClassifier, compileTerm } from '../collector/classify.js';
import { approx, loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const sectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sectors.json'), 'utf8'));
const dict = buildDictionary(cfg, sectors);
const { classifyArticle, classify } = createClassifier(cfg, dict);
const typeOf = (title, summary = '') => classifyArticle({ title, summary }).type;

// ---------- TF-IDF ----------

test('tokenizacija: enote zneskov, svojilni sklon, stop-besede, krnjenje', () => {
  assert.deepEqual(tokenize('Binance Sets Aside $6.34B to Cover Hack Losses'), ['binance', 'set', 'aside', '6.34', 'billion', 'cover', 'hack', 'loss']);
  assert.deepEqual(tokenize("North Korea's role in $6 billion hack"), ['north', 'korea', 'role', 'billion', 'hack'], 'enoznakovni žetoni (tudi "6") se zavržejo');
  assert.deepEqual(tokenize('HYPE surges 15%'), ['hype', 'surge', '15', 'percent']);
  assert.equal(stem('losses'), 'loss');
  assert.equal(stem('brothers'), 'brother');
  assert.equal(stem('hacking'), 'hack');
  assert.equal(stem('status'), 'status');
});

test('TF-IDF in kosinus (ročni primer)', () => {
  // dokumenti: [a b], [a c]; N = 2; df(a) = 2, df(b) = df(c) = 1
  // idf(a) = ln(3/3) + 1 = 1; idf(b) = idf(c) = ln(3/2) + 1
  // cos = 1·1 / (1 + idf_b²) = 1 / (1 + (ln 1,5 + 1)²)
  const idf = buildIdf([['aa', 'bb'], ['aa', 'cc']]);
  const v1 = vectorize(['aa', 'bb'], idf);
  const v2 = vectorize(['aa', 'cc'], idf);
  const ib = Math.log(1.5) + 1;
  assert.ok(approx(cosine(v1, v2), 1 / (1 + ib * ib)));
  assert.ok(approx(cosine(v1, v1), 1));
  assert.equal(cosine(v1, vectorize([], idf)), 0);
});

// ---------- entitete ----------

test('ticker samo v velikih črkah in kot cela beseda', () => {
  assert.deepEqual(findEntities('SOL rallies; $LINK too', dict), ['SOL', 'LINK']);
  assert.deepEqual(findEntities('the sol of the link', dict), []);
  assert.deepEqual(findEntities('OPEN letter, ONE more', dict), [], 'OP ni del OPEN; ONE je na stop-listi');
  assert.deepEqual(findEntities('OP jumps', dict), ['OP']);
  assert.deepEqual(findEntities('SEC sues; AI boom; ETF flows', dict), [], 'stop-lista');
});

test('imena: brez razlikovanja velikosti, dvoumna samo prek aliasa, daljše ujemanje zmaga', () => {
  assert.deepEqual(findEntities('Bitcoin redemption freeze puts $136 million Aave market under scrutiny', dict), ['BTC', 'AAVE']);
  assert.deepEqual(findEntities('the core issue', dict), [], '"Core" je dvoumno ime');
  assert.deepEqual(findEntities('drain 97 million CORE from Bitcoin staking', dict), ['CORE', 'BTC'], 'ticker velja');
  assert.deepEqual(findEntities('Jupiter rallies', dict), [], '"Jupiter" je dvoumno ime');
  assert.deepEqual(findEntities('Jupiter Exchange rallies', dict), ['JUP'], 'alias');
  assert.deepEqual(findEntities('Polygon adds Solana to payment stack', dict), ['POL', 'SOL'], 'sinonim Polygon → POL');
  assert.deepEqual(findEntities('Curve Finance launches on Stellar', dict), ['CRV'], 'Stellar je dvoumno, Curve Finance alias');
  assert.deepEqual(findEntities('Binance’s $6.4B Hack Overshadows Hyperliquid’s Biggest Day', dict), ['BNB', 'HYPE']);
});

test('sektorji in glavne entitete dogodka', () => {
  assert.deepEqual(sectorsOf(['BNB', 'RUNE', 'BTC'], dict), ['centralized-exchange-token-cex', 'decentralized-finance-defi']);
  const arts = [
    { titleSalient: ['BNB'], salient: ['BNB'] },
    { titleSalient: ['BNB', 'ETH'], salient: ['BNB', 'ETH'] },
    { titleSalient: ['BNB', 'RUNE', '@FBI'], salient: ['BNB', 'RUNE', '@FBI'] },
  ];
  assert.deepEqual(mainEntities(arts, dict, cfg), ['BNB'], 'ETH, RUNE in @FBI so v 1/3 naslovov (< 50 %)');
  assert.deepEqual(mainEntities([{ titleSalient: [], salient: ['ETH'] }], dict, cfg), ['ETH'], 'nadomestek: povzetek');
  assert.deepEqual(mainEntities([{ titleSalient: ['@SEC', 'BNB'] }], dict, cfg), ['BNB', '@SEC'], 'kovanci pred akterji');
});

// ---------- klasifikacija ----------

test('zahtevani primeri: SEC approves spot ETF / SEC sues / corporate', () => {
  assert.equal(typeOf('SEC approves spot ETF'), 'etf_institutional', 'etf_institutional ima prednost pred regulation');
  assert.equal(typeOf('SEC sues Coinbase'), 'regulation');
  assert.equal(typeOf('SEC sues'), 'regulation');
  assert.equal(typeOf('Corporate bond market update'), 'other', '"rate" se ne ujame v "corporate"');
  assert.equal(typeOf('corporate'), 'other');
});

test('pravila ujemanja: meja besede, velike črke, predpona, negativne fraze', () => {
  assert.ok(compileTerm('hack*').test('Hackers drained'));
  assert.ok(!compileTerm('ban').test('Binance urban plan'));
  assert.equal(typeOf('Fed holds rates steady'), 'macro');
  assert.equal(typeOf('Users fed up with fees'), 'other', '"Fed" je občutljiv na velikost');
  assert.equal(typeOf('Powell signals interest rate cuts'), 'macro');
  assert.equal(typeOf('Why AI Models Cheat: Reward Hacking, Explained'), 'other', 'negativna fraza');
  assert.equal(typeOf('Aave market exploited', 'Attackers drained the pool'), 'hack');
  assert.deepEqual(classifyArticle({ title: 'Weekly recap', summary: 'Kraken halts withdrawals' }), {
    type: 'insolvency',
    keyword: 'halts withdrawals',
    where: 'summary',
    cryptoContext: true,
  });
});

test('pravi naslovi iz feedov (zajem 2026-11-02)', () => {
  const cases = [
    ['Two Entities Charged in $130 Million Fraud Scheme That Used False SEC Filings to Boost Investor Confidence', 'regulation'],
    ['Crypto scammers used SEC’s website to lure investors into alleged $130 million fraud', 'regulation'],
    ['Bank of Korea probes financial firms’ exposure to crypto risks', 'regulation'],
    ['Binance investigating hack as suspicious outflows reach up to $5.8 billion', 'hack'],
    ['Polymarket resumes trading after $2.65 million exploit, says third-party provider was compromised', 'hack'],
    ['Zero-token withdrawals let a hacker drain 97 million CORE from Bitcoin staking platform b14g', 'hack'],
    ['Here’s how an Ethereum upgrade helped drain part of Binance’s $6 billion loss', 'hack'],
    ['Blockchain investigator Chainalysis hit by cybersecurity incident', 'hack'],
    ['OneKey founder warns BlackRock’s Bitcoin ETF could be a North Korean target', 'etf_institutional'],
    ['Spot bitcoin ETFs see largest daily outflows in four months following record Binance hack', 'hack'],
    ['$8 Million Crypto Kidnapping Lands Texas Brothers 15-Year Prison Terms', 'other'],
    ['Coinbase Q3 net income jumps 66% as prediction markets gain traction', 'other'],
    ['Intel Stock Suffers Worst Crash in 50 Years as Weak Forecast Overshadows AI Chip Demand', 'other'],
    ['Curve Finance launches on Stellar in first native deployment outside EVM ecosystem', 'other'],
  ];
  for (const [title, type] of cases) assert.equal(typeOf(title), type, title);
});

test('classify(event): večina uteženih člankov, izenačenje po prioriteti, vmesnik {type, confidence, entities}', () => {
  const art = (title, ents = []) => ({ title, summary: '', titleEntities: ents, entities: ents });
  const r = classify({
    articles: [
      art('Binance hack drains $6B', ['BNB']),
      art('Binance arranges funds to cover hack losses', ['BNB']),
      art('SEC comments on Binance', ['BNB']),
    ].map((a) => ({ ...a, titleSalient: a.titleEntities })),
  });
  for (const k of ['type', 'confidence', 'entities']) assert.ok(k in r, k);
  assert.equal(r.type, 'hack');
  assert.ok(approx(r.confidence, 2 / 3));
  assert.deepEqual(r.entities, ['BNB']);
  const tie = classify({ articles: [art('SEC sues exchange'), art('Exchange lists new token')] });
  assert.equal(tie.type, 'regulation', 'izenačenje 1 : 1 → višja prioriteta');
  const rec = classify({ articles: [art('Weekly recap')] });
  assert.equal(rec.type, 'other');
  assert.equal(rec.confidence, 0);
  assert.deepEqual(rec.entities, []);
});

test('tip grozda: večina uteženo s tierom vira; en naslov ne preglasi grozda', () => {
  const a = (source, type) => ({ title: '', summary: '', source, typeMatch: { type, where: 'title' }, titleSalient: [] });
  // En naslov o odtokih iz ETF zaradi hacka (hack po prioriteti) v grozdu, ki ga drugi viri uvrščajo kot ETF
  assert.equal(classify({ articles: [a('theblock', 'hack'), a('coindesk', 'etf_institutional'), a('decrypt', 'etf_institutional')] }).type, 'etf_institutional');
  // … in obratno
  assert.equal(classify({ articles: [a('coindesk', 'etf_institutional'), a('theblock', 'hack'), a('decrypt', 'hack')] }).type, 'hack');
  // Tier: SEC (1,0) proti dvema CryptoSlate (0,4 + 0,4)
  const r = classify({ articles: [a('sec', 'regulation'), a('cryptoslate', 'etf_institutional'), a('cryptoslate', 'etf_institutional')] });
  assert.equal(r.type, 'regulation');
  assert.ok(approx(r.confidence, 1 / 1.8));
  assert.deepEqual(r.votes, { etf_institutional: 0.8, regulation: 1 });
  // Izenačenje 0,7 : 0,7 → prioriteta (hack pred etf_institutional)
  assert.equal(classify({ articles: [a('coindesk', 'etf_institutional'), a('theblock', 'hack')] }).type, 'hack');
  // "other" je glas: dva "other" iz 0,7 preglasita en hack iz 0,7
  assert.equal(classify({ articles: [a('theblock', 'hack'), a('coindesk', 'other'), a('decrypt', 'other')] }).type, 'other');
  // povzetek šteje pol
  const half = classify({ articles: [{ ...a('coindesk', 'hack'), typeMatch: { type: 'hack', where: 'summary' } }, a('cryptoslate', 'listing')] });
  assert.equal(half.type, 'listing', 'hack iz povzetka: 0,7 · 0,5 = 0,35 < listing iz naslova CryptoSlate 0,4');
});

test('akterji: z razlikovanjem velikosti; ne mešajo se s kovanci', () => {
  assert.deepEqual(findActors('FBI blames North Korea for record $6.3B Binance hack', dict), ['@FBI', '@NORTH_KOREA']);
  assert.deepEqual(findActors('SEC sues Coinbase; the sec said', dict), ['@SEC', '@COINBASE']);
  assert.deepEqual(findActors("People's Bank of China and Lazarus Group", dict), ['@CN_REGULATORS', '@NORTH_KOREA']);
  assert.deepEqual(findEntities('FBI blames North Korea', dict), []);
});

test('kripto kontekst: hack/insolvency/protocol_failure zahtevajo kovanec ali kripto akterja', () => {
  const r = classifyArticle({ title: "A stolen iPhone, $14,000 in losses and London's crypto theft problem", summary: '' });
  assert.equal(r.type, 'other');
  assert.deepEqual(r.suppressed, ['hack']);
  assert.equal(r.cryptoContext, false);
  assert.equal(typeOf('Hackers hijack a dozen DeFi websites, all registered with Name.com, and steal about $138,000'), 'other', 'brez entitete');
  assert.equal(typeOf('Polymarket resumes trading after $2.65 million exploit, says third-party provider was compromised'), 'hack', 'kripto akter (protokol)');
  assert.equal(typeOf('Blockchain investigator Chainalysis hit by cybersecurity incident'), 'hack', 'kripto akter');
  assert.equal(typeOf('Retailer files for bankruptcy'), 'other');
  assert.equal(typeOf('Retailer files for bankruptcy', 'It held bitcoin on its balance sheet'), 'insolvency', 'kontekst v povzetku');
  assert.equal(typeOf('Bank hacked, regulators probe'), 'regulation', 'hack preskočen → naslednji tip po prioriteti');
  assert.equal(typeOf('SEC charges hacker in Coinbase breach'), 'hack', 'kripto akter Coinbase');
  assert.equal(typeOf('Federal Reserve hacked'), 'macro', '@FED ni kripto akter');
});

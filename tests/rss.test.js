import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFeed, normalizeItems } from '../collector/sources/rss.js';
import { canonicalUrl, cleanText, decodeEntities } from '../collector/lib/text.js';
import { ROOT } from './helpers.js';

const fixture = (name) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/feeds', name), 'utf8');
const NOW = Date.parse('2026-11-02T08:00:00Z');

test('pravi feedi (zajem 2026-11-02): RSS 2.0 in število postavk', () => {
  const expected = { coindesk: 20, cointelegraph: 20, decrypt: 20, theblock: 20, cryptoslate: 10, sec: 1 };
  for (const [id, n] of Object.entries(expected)) {
    const f = parseFeed(fixture(`${id}.xml`));
    assert.equal(f.format, 'rss2', id);
    assert.equal(f.items.length, n, id);
    const { articles, rejected } = normalizeItems(f.items, id, NOW);
    assert.equal(articles.length, n, id);
    assert.equal(rejected.length, 0, id);
    for (const a of articles) {
      assert.match(a.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(a.ingestedAt, '2026-11-02T08:00:00Z');
    }
  }
});

test('CryptoSlate: numerične entitete v naslovu se dekodirajo', () => {
  const { articles } = normalizeItems(parseFeed(fixture('cryptoslate.xml')).items, 'cryptoslate', NOW);
  assert.equal(articles[1].title, 'Crypto scammers used SEC’s website to lure investors into alleged $130 million fraud');
});

test('Cointelegraph: parametri utm_ se odstranijo iz URL-ja in ID-ja', () => {
  const { articles } = normalizeItems(parseFeed(fixture('cointelegraph.xml')).items, 'cointelegraph', NOW);
  assert.equal(articles[0].url, 'https://cointelegraph.com/news/btcpay-server-hot-wallet-thefts-older-versions');
  assert.equal(articles[14].title, 'Binance $6.3B record hack sparks pre-election political clashes', 'zadnji presledek odstranjen');
});

test('SEC: pubDate z zamikom −0400 se pretvori v UTC', () => {
  const { articles } = normalizeItems(parseFeed(fixture('sec.xml')).items, 'sec', NOW);
  assert.equal(articles[0].publishedAt, '2026-10-29T16:42:37Z');
});

test('Atom (sintetično): alternate povezava, HTML povzetek, brez povezave, prihodnji datum', () => {
  const f = parseFeed(fixture('synthetic-atom.xml'));
  assert.equal(f.format, 'atom');
  const { articles, rejected } = normalizeItems(f.items, 'x', NOW);
  assert.equal(articles.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'neveljaven URL');
  assert.equal(articles[0].url, 'https://example.com/a');
  assert.equal(articles[0].title, 'Protocol "X" patches bug');
  assert.equal(articles[0].summary, 'Short summary with & entity.');
  assert.equal(articles[1].title, 'CDATA naslov & znak');
  assert.equal(articles[1].summary, 'Vsebina v CDATA');
  assert.equal(articles[1].url, 'https://example.com/c');
  assert.equal(articles[1].publishedAt, '2026-11-02T08:00:00Z', 'prihodnji čas omejen na čas zajema');
});

test('vsebina, ki ni feed, vrže jasno napako', () => {
  assert.throws(() => parseFeed('<html><body>Not a feed</body></html>'), /ni RSS ali Atom/);
});

test('pripomočki: entitete, HTML, kanonični URL', () => {
  assert.equal(decodeEntities('A &amp; B &#8217; &#x2014; &rsquo; &bogus;'), 'A & B ’ — ’ &bogus;');
  assert.equal(cleanText('<p>a&nbsp;&nbsp;b</p><script>x()</script>'), 'a b');
  assert.equal(cleanText('ena dva tri štiri', 10), 'ena dva…');
  assert.equal(canonicalUrl('HTTPS://Example.COM/a/?b=2&a=1&utm_x=3#f'), 'https://example.com/a/?a=1&b=2');
  assert.equal(canonicalUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
});

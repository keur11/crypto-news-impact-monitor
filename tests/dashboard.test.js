// data/bundle.js in dashboard (index.html).
// Test brskalnika se izvede le, če je na voljo Playwright (lokalno); sicer se preskoči.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createHttpClient } from '../collector/lib/http.js';
import { runOnce } from '../collector/run.js';
import { buildBundle, uiConfig } from '../collector/bundle.js';
import { loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const NOW = Date.parse('2026-11-02T08:00:00Z');
const FEEDS = { 'www.coindesk.com': 'coindesk', 'cointelegraph.com': 'cointelegraph', 'decrypt.co': 'decrypt', 'www.theblock.co': 'theblock', 'cryptoslate.com': 'cryptoslate', 'www.sec.gov': 'sec' };
const http = () => createHttpClient(cfg, {
  sleep: async () => {},
  fetchImpl: async (url) => {
    const body = fs.readFileSync(path.join(ROOT, 'tests/fixtures/feeds', `${FEEDS[new URL(url).hostname]}.xml`), 'utf8');
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
  },
});

async function makeSite({ library = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-site-'));
  await fsp.mkdir(path.join(root, 'config'), { recursive: true });
  await fsp.copyFile(path.join(ROOT, 'index.html'), path.join(root, 'index.html'));
  await fsp.copyFile(path.join(ROOT, 'config/library.json'), path.join(root, 'config/library.json'));
  if (library) {
    await fsp.mkdir(path.join(root, 'data'), { recursive: true });
    await fsp.copyFile(path.join(ROOT, 'tests/fixtures/library-measured-synthetic.json'), path.join(root, 'data/library.json'));
  }
  await runOnce({ root, cfg, http: http(), nowMs: NOW, env: { CONTACT_EMAIL: 'secret.contact@example.com' }, market: false });
  return root;
}

function loadBundle(file) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.__DATA__)); // objekti iz drugega konteksta vm → navadni objekti
}

test('bundle.js: window.__DATA__ z dogodki, zgodbami, statusom, configom; skrivnosti maskirane', async () => {
  const root = await makeSite();
  const file = path.join(root, cfg.paths.bundle);
  const txt = fs.readFileSync(file, 'utf8');
  assert.ok(!txt.includes('secret.contact@example.com'));
  const d = loadBundle(file);
  assert.ok(d.events.length > 50);
  assert.ok(d.stories.length > 10 && d.stories.length < d.events.length, 'zgodbe združujejo dogodke');
  assert.equal(d.status.library.measured, false);
  assert.equal(d.library, null);
  assert.equal(d.libraryInput.length, 5, 'brez meritev: ročni vnos za zavihek referenčnih dogodkov');
  assert.deepEqual(d.config, uiConfig(cfg));
  assert.ok(d.events.every((e) => e.storyId && e.novelty && e.exAnteEff));
  assert.ok(d.events.every((e) => e.articleIds === undefined), 'bundle ne nosi odvečnih polj');
  await fsp.rm(root, { recursive: true, force: true });
});

test('bundle.js z izmerjeno (sintetično) knjižnico: library namesto libraryInput', async () => {
  const root = await makeSite({ library: true });
  const d = loadBundle(path.join(root, cfg.paths.bundle));
  assert.equal(d.libraryInput, null);
  assert.equal(d.library.refs.M_ref72, 4);
  assert.equal(d.status.library.measured, true);
  await fsp.rm(root, { recursive: true, force: true });
});

test('buildBundle brez podatkov: prazni seznami, brez napake', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-empty-'));
  const r = await buildBundle(cfg, { root, env: {} });
  assert.equal(r.events, 0);
  const d = loadBundle(path.join(root, cfg.paths.bundle));
  assert.equal(d.status, null);
  assert.deepEqual(d.events, []);
  await fsp.rm(root, { recursive: true, force: true });
});

test('index.html: ena datoteka, CDN s fiksno verzijo, bundle prek file://, izpis brez innerHTML iz neočiščenih podatkov', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<script src="data\/bundle\.js"/);
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4\.5\.1\/chart\.umd\.min\.js/);
  assert.match(html, /ni investicijski nasvet/);
  assert.match(html, /Europe\/Ljubljana/);
  assert.match(html, /sl-SI/);
  assert.ok(!/fetch\(['"]https?:/.test(html), 'dashboard ne kliče zunanjih API-jev');
  // vsako vstavljanje naslova gre skozi esc()
  for (const m of html.matchAll(/\$\{([^}]*\.title)\}/g)) assert.fail(`neočiščen naslov: ${m[0]}`);
});

// ---------- brskalnik (neobvezno) ----------
function findPlaywright() {
  const req = createRequire(import.meta.url);
  for (const base of [ROOT, (() => { try { return execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch { return null; } })()]) {
    if (!base) continue;
    try { return req(req.resolve('playwright', { paths: [base] })); } catch { /* ni na voljo */ }
  }
  return null;
}
const pw = findPlaywright();

test('dashboard v brskalniku: 375 px brez vodoravnega drsenja, opozorilo knjižnice, podrobnosti, prazno stanje', { skip: pw ? false : 'Playwright ni nameščen' }, async () => {
  const root = await makeSite();
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(/cdnjs|jsdelivr/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Chart=undefined;' }));
    await page.goto(`file://${path.join(root, 'index.html')}`);
    await page.waitForSelector('.card');
    assert.ok((await page.locator('.card').count()) > 5);
    assert.match(await page.locator('.alert.strong').first().textContent(), /Referenčna knjižnica ni izmerjena – ocene niso kalibrirane/);
    const ov = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(ov[0] <= ov[1], `vodoravno drsenje: ${ov}`);
    await page.locator('.card h2 button').first().click();
    await page.waitForSelector('#drawer.open');
    assert.match(await page.locator('#drawer').textContent(), /N – novost/);
    await page.keyboard.press('Escape');
    // XSS: naslov z oznako se izpiše kot besedilo
    await page.evaluate(() => { window.__DATA__.events[0].title = '<img src=x onerror="window.__xss=1">'; });
    await page.locator('#fConfirmed').click();
    await page.locator('#fConfirmed').click();
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(errors, []);

    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-nob-'));
    await fsp.copyFile(path.join(ROOT, 'index.html'), path.join(empty, 'index.html'));
    await page.goto(`file://${path.join(empty, 'index.html')}`);
    await page.waitForSelector('.empty');
    assert.match(await page.locator('.empty').textContent(), /Ni podatkov.*npm run collect/s);
    await fsp.rm(empty, { recursive: true, force: true });
  } finally {
    await browser.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

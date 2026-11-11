// GitHub Actions: struktura workflowov, objava na vejo data (lokalni goli repozitorij), keepalive status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { keepaliveStatus } from '../collector/scoring.js';
import { loadConfig, ROOT } from './helpers.js';

const cfg = loadConfig();
const wf = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

test('workflowi: skupna skupina concurrency, cron, vrata, brez commitov na main', () => {
  for (const name of ['collect.yml', 'backfill.yml', 'keepalive.yml']) {
    const y = wf(name);
    assert.match(y, /concurrency:\s*\n\s*group: data-branch\s*\n\s*cancel-in-progress: false/, `${name}: concurrency`);
    assert.ok(!/git push[^\n]*\bmain\b/.test(y), `${name}: brez potiskanja na main`);
    assert.ok(!/allow-empty/.test(y), `${name}: brez praznih commitov`);
  }
  const c = wf('collect.yml');
  assert.match(c, /cron: '7,37 \* \* \* \*'/);
  assert.match(c, /workflow_dispatch:/);
  assert.match(c, /CRON_ENABLED: \$\{\{ vars\.CRON_ENABLED \}\}/);
  assert.match(c, /\[ -f data\/library\.json \]/);
  assert.match(c, /actions\/upload-pages-artifact@v4/);
  assert.match(c, /actions\/deploy-pages@v4/);
  assert.match(c, /CONTACT_EMAIL: \$\{\{ secrets\.CONTACT_EMAIL \}\}/);
  assert.ok(!/configure-pages/.test(c), 'configure-pages ni potreben');
  const b = wf('backfill.yml');
  assert.match(b, /publish:/);
  assert.match(b, /inputs\.publish && steps\.backfill\.outputs\.code == '0'/);
  assert.match(b, /CONTACT_EMAIL: \$\{\{ secrets\.CONTACT_EMAIL \}\}/);
  const k = wf('keepalive.yml');
  assert.match(k, /actions: write/);
  assert.match(k, /gh api -X PUT "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/workflows\/\$\{wf\}\/enable"/);
  assert.match(k, /for wf in collect\.yml keepalive\.yml/);
  assert.match(k, /npm run --silent calibrate/);
});

test('varnost javnega repozitorija: brez pull_request*, secrets samo v potrebnih korakih, najmanjše pravice', () => {
  for (const name of ['collect.yml', 'backfill.yml', 'keepalive.yml']) {
    const y = wf(name);
    assert.ok(!/pull_request/.test(y), `${name}: brez pull_request / pull_request_target`);
    assert.match(y, /^on:\n(  (schedule|workflow_dispatch):[\s\S]*?)\n\n/m, `${name}: samo schedule/workflow_dispatch`);
    assert.ok(!/^    env:\n(      .*\n)*?      [A-Z_]+: \$\{\{ secrets\./m.test(y), `${name}: secrets niso na ravni joba`);
    // korak: »      - run:« ali »        run:« (ne izhod joba »outputs: run:«); v run ni nobenega ${{ … }}
    const runLines = y.split('\n').filter((l) => /^(      - |        )run: /.test(l));
    assert.ok(runLines.length > 0);
    for (const l of runLines) assert.ok(!/\$\{\{/.test(l), `${name}: brez izrazov v run: ${l}`);
    const runBlocks = y.split(/\n(?:      - |        )run: \|\n/).slice(1).map((b) => b.split(/\n(?! {10})/)[0]);
    for (const b of runBlocks) assert.ok(!/\$\{\{/.test(b), `${name}: brez izrazov v večvrstičnem run`);
    assert.match(y, /npm ci --ignore-scripts/, `${name}: npm ci brez namestitvenih skript`);
  }
  for (const name of ['collect.yml', 'backfill.yml']) {
    const y = wf(name);
    const steps = y.split(/\n      - /).filter((st) => /secrets\./.test(st));
    for (const st of steps) assert.match(st, /npm run --silent (collect|smoke|backfill)/, `${name}: secrets samo v korakih zbiralnika/smoke/backfill`);
  }
  const c = wf('collect.yml');
  assert.match(c, /^permissions:\n  contents: read\n/m, 'collect: privzeto samo branje');
  assert.match(c, /  collect:[\s\S]*?permissions:\n      contents: write/);
  assert.match(c, /  deploy:[\s\S]*?permissions:\n      pages: write[^\n]*\n      id-token: write/);
  assert.match(wf('backfill.yml'), /^permissions:\n  contents: write\n/m);
  assert.match(wf('keepalive.yml'), /^permissions:\n  contents: write\n  actions: write\n/m);
});

test('index.html: noindex za GitHub Pages', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /<meta name="robots" content="noindex">/);
});

function hasGit() {
  try { execFileSync('git', ['--version']); return true; } catch { return false; }
}

test('publish-data-branch.sh: en commit brez zgodovine, vsebuje data/, glavna veja nespremenjena', { skip: hasGit() ? false : 'git ni na voljo' }, async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cnim-pub-'));
  const bare = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = path.join(tmp, 'work');
  await fsp.mkdir(path.join(work, 'data'), { recursive: true });
  const env = { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', PUBLISH_REMOTE_URL: bare };
  const run = (msg) => execFileSync('bash', [path.join(ROOT, 'scripts/publish-data-branch.sh'), msg], { cwd: work, env, encoding: 'utf8' });
  await fsp.writeFile(path.join(work, 'data/status.json'), '{"a":1}');
  await fsp.writeFile(path.join(work, 'data/x.tmp'), 'začasno');
  run('prvi');
  await fsp.writeFile(path.join(work, 'data/status.json'), '{"a":2}');
  const out = run('drugi');
  assert.match(out, /Objavljeno na vejo data/);
  const log = execFileSync('git', ['--git-dir', bare, 'log', '--format=%s', 'data'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(log.length, 1, 'force-push brez zgodovine');
  assert.match(log[0], /^drugi \(/);
  const files = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'data'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['data/status.json'], '*.tmp se ne objavi');
  assert.equal(execFileSync('git', ['--git-dir', bare, 'show', 'data:data/status.json'], { encoding: 'utf8' }), '{"a":2}');
  const heads = execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'], { encoding: 'utf8' }).trim();
  assert.equal(heads, 'refs/heads/data', 'main ni bil ustvarjen ali spremenjen');
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('keepalive status: brez zapisa ni opozorila; neuspeh ali > 35 dni → opozorilo', () => {
  const now = Date.parse('2026-12-10T00:00:00Z');
  assert.equal(keepaliveStatus(null, cfg, now).warning, null);
  assert.equal(keepaliveStatus({ at: '2026-12-01T04:23:00Z', ok: true }, cfg, now).warning, null);
  assert.match(keepaliveStatus({ at: '2026-12-01T04:23:00Z', ok: false, results: 'collect.yml=napaka: 403' }, cfg, now).warning, /ni uspelo.*403/);
  const old = keepaliveStatus({ at: '2026-11-01T04:23:00Z', ok: true }, cfg, now);
  assert.equal(old.ageDays, 38);
  assert.match(old.warning, /ni tekel 38 dni/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isAllowedPath } from '../../ci/check-upstream-untouched.mjs';

const SCRIPT = fileURLToPath(new URL('../../ci/check-upstream-untouched.mjs', import.meta.url));

test('selfhost paths, prefixed workflows and the five root docs are allowed', () => {
  for (const p of ['selfhost/server.mjs', 'selfhost/docs/PLAN.md', '.github/workflows/selfhost-ci.yml',
    'UPSTREAM.md', 'SELFHOSTED.md', 'ARCHITECTURE.md', 'CHANGELOG-SELFHOSTED.md', 'UPGRADE.md']) {
    assert.ok(isAllowedPath(p), p);
  }
});

test('upstream files are not allowed', () => {
  for (const p of ['server.mjs', 'package.json', 'public/index.html', 'public/js/util.js',
    '.github/workflows/release.yml', '.github/workflows/selfhost.yml.bak', 'README.md', 'selfhostx/a.js']) {
    assert.ok(!isAllowedPath(p), p);
  }
});

/**
 * Builds a throwaway repository: upstream release v1.0.0 (a.txt, run.sh, gone.txt), an upstream
 * main one commit ahead (fixes a.txt, deletes gone.txt), and a fork branch to mutate per test.
 */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'untouched-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'fork');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  writeFileSync(path.join(dir, 'run.sh'), 'echo hi\n');
  writeFileSync(path.join(dir, 'gone.txt'), 'old\n');
  g('add', '-A'); g('commit', '-qm', 'release'); g('tag', 'v1.0.0');
  g('switch', '-q', '-c', 'up');
  writeFileSync(path.join(dir, 'a.txt'), 'v1 fixed\n');
  g('rm', '-q', 'gone.txt');
  g('commit', '-qam', 'upstream fix');
  g('update-ref', 'refs/remotes/upstream/main', 'HEAD');
  g('switch', '-q', 'fork');
  const run = () => spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
  const commit = (msg) => { g('add', '-A'); g('commit', '-qm', msg); };
  return { dir, g, run, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('selfhost additions pass; an edited upstream file fails', () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.dir, 'selfhost'));
    writeFileSync(path.join(f.dir, 'selfhost/x.mjs'), 'ok\n');
    f.commit('selfhost');
    assert.equal(f.run().status, 0);
    writeFileSync(path.join(f.dir, 'a.txt'), 'local change\n');
    f.commit('edit upstream');
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /✖ a\.txt/);
  } finally { f.cleanup(); }
});

test('a file identical to upstream main (cherry-picked fix) passes', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, 'a.txt'), 'v1 fixed\n');
    f.commit('cherry-pick');
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cherry-picked fix\): a\.txt/);
  } finally { f.cleanup(); }
});

test('a mode-only change to an upstream file fails', () => {
  const f = fixture();
  try {
    chmodSync(path.join(f.dir, 'run.sh'), 0o755);
    f.commit('chmod');
    assert.equal(f.run().status, 1);
  } finally { f.cleanup(); }
});

test('deleting an upstream file fails, even when upstream main deleted it too', () => {
  const f = fixture();
  try {
    f.g('rm', '-q', 'gone.txt');
    f.commit('delete');
    assert.equal(f.run().status, 1);
  } finally { f.cleanup(); }
});

test('UPSTREAM_PATCHES.json entries need a real reason and an upstream file', () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.dir, 'selfhost'));
    writeFileSync(path.join(f.dir, 'a.txt'), 'patched\n');
    const patches = (list) => { writeFileSync(path.join(f.dir, 'selfhost/UPSTREAM_PATCHES.json'), JSON.stringify({ patches: list })); f.commit('patches'); };

    patches([{ file: 'a.txt', reason: '' }]);
    let r = f.run();
    assert.equal(r.status, 1); assert.match(r.stderr, /needs a real "reason"/);

    patches([{ file: 'nope.txt', reason: 'a sufficiently long reason' }]);
    r = f.run();
    assert.equal(r.status, 1); assert.match(r.stderr, /does not exist in upstream/);

    patches([{ file: 'selfhost/x.mjs', reason: 'a sufficiently long reason' }]);
    r = f.run();
    assert.equal(r.status, 1); assert.match(r.stderr, /selfhost path/);

    patches([{ file: 'a.txt', reason: 'hook needed until upstream PR lands' }]);
    r = f.run();
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /patched upstream file \(documented\): a\.txt/);
  } finally { f.cleanup(); }
});

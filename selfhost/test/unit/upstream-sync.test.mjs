import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, newestStable, marker, touchedPoints, upstreamWorkflowChanges,
  sanitizeUpstreamText, prBody, conflictBody, rollingBody,
} from '../../ci/upstream-sync.mjs';

test('versions sort numerically and pre-releases rank below their release', () => {
  assert.equal(newestStable(['v0.1.9', 'v0.1.10', 'v0.1.2', 'v0.2.0-rc.1', 'nightly']), 'v0.1.10');
  assert.ok(compareVersions(parseVersion('v1.0.0-rc.1'), parseVersion('v1.0.0')) < 0);
  assert.equal(parseVersion('1.0.0'), null);
  assert.equal(newestStable([]), null);
});

test('markers are unique per kind and version', () => {
  assert.notEqual(marker('pr', 'v0.1.9'), marker('conflict', 'v0.1.9'));
  assert.match(marker('pr', 'v0.1.9'), /^<!-- upstream-sync:pr:v0\.1\.9 -->$/);
});

test('touched integration points match plain files, comma lists and globs', () => {
  const points = [
    { id: 'a', file: 'server.mjs' },
    { id: 'b', file: 'public/js/drawings.js, public/js/scripts.js' },
    { id: 'c', file: 'public/js/**' },
    { id: 'd', file: 'lib/proxy.mjs' },
  ];
  const t = touchedPoints(points, ['server.mjs', 'public/js/scripts.js', 'README.md']);
  assert.deepEqual(t.map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(t.find((p) => p.id === 'b').files, ['public/js/scripts.js']);
  assert.deepEqual(touchedPoints(points, ['serverXmjs']), [], 'dots are literal');
});

test('only upstream workflow changes are flagged', () => {
  assert.deepEqual(upstreamWorkflowChanges(['.github/workflows/release.yml', '.github/workflows/selfhost-ci.yml', 'x.yml']), ['.github/workflows/release.yml']);
});

test('upstream text cannot mention people, cross-link our issues, or hide markers', () => {
  const s = sanitizeUpstreamText('Thanks @alice and @bob-2! Fixes #12 (see #3). <!-- upstream-sync:pr:v9.9.9 --> email a@b.c', 'up/stream');
  assert.ok(!/(^|[^\w`])@alice/.test(s) && s.includes('@​alice') && s.includes('@​bob-2'));
  assert.ok(s.includes('up/stream#12') && s.includes('(see up/stream#3)'));
  assert.ok(!s.includes('upstream-sync:pr:v9.9.9'), 'upstream text must not forge a duplicate-guard marker');
  assert.ok(s.includes('a@b.c'), 'emails are not mentions');
  assert.ok(sanitizeUpstreamText('x'.repeat(10), 'u/r', 5).includes('truncated'));
});

const report = {
  version: 'v0.2.0', previous: 'v0.1.9', base: 'selfhosted', upstreamRepo: 'keptaduona/wickline', skipped: ['v0.1.10'],
  points: [{ id: 'server-start', contract: 'startServer…', files: ['server.mjs'], test: 'test/contract/server.test.mjs' }],
  workflows: ['.github/workflows/new.yml'], notes: 'Big release by @someone, fixes #5', commits: ['abc123 Do things'],
  conflicts: ['server.mjs'], unreleased: ['def456 WIP'], generatedAt: '2026-11-24T00:00:00Z',
};

test('PR body carries the marker, report sections and a safe changelog', () => {
  const b = prBody(report, { ok: true, summary: 'all green' });
  assert.ok(b.startsWith(marker('pr', 'v0.2.0')));
  for (const s of ['server-start', '.github/workflows/new.yml', 'v0.1.10', 'all green', 'keptaduona/wickline#5', 'merge commit']) assert.ok(b.includes(s), s);
  assert.ok(!/(^|[^\w`])@someone/.test(b));
  assert.ok(!/\n{3,}/.test(b));
});

test('conflict and rolling bodies carry their markers', () => {
  assert.ok(conflictBody(report).startsWith(marker('conflict', 'v0.2.0')));
  assert.ok(conflictBody(report).includes('git merge --no-ff v0.2.0'));
  assert.ok(rollingBody(report).startsWith(marker('unreleased', 'rolling')));
});

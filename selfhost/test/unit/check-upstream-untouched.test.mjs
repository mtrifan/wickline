import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPath } from '../../ci/check-upstream-untouched.mjs';

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

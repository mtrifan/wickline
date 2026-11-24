// Contract: every key upstream persists is classified in sync/key-classes.json, so a key added
// by an upstream release is never synced (or dropped) without a decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { upstreamPath, point } from './helpers.mjs';

const classes = JSON.parse(readFileSync(new URL('../../sync/key-classes.json', import.meta.url), 'utf8')).keys;

// Known pass-through wrappers around store (file: wrapper call). Their callers are scanned instead.
const WRAPPERS = { 'env.js': /settings\.set\(\s*(['"`])([^'"`]*)\1/g };

function upstreamKeys() {
  const dir = upstreamPath('public/js');
  const keys = new Set();
  const dynamic = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/store\.(?:get|set)\(\s*(['"`])([^'"`]*)\1/g)) {
      if (m[2].includes('${')) dynamic.push(`${file}: ${m[2]}`);
      else keys.add(m[2]);
    }
    for (const m of src.matchAll(/store\.(?:get|set)\(\s*(?!['"`])([^,)]+)/g)) {
      if (file in WRAPPERS && m[1].trim() === 'key') continue;
      dynamic.push(`${file}: store.*(${m[1].trim()})`);
    }
    for (const re of Object.values(WRAPPERS)) for (const m of src.matchAll(re)) keys.add(m[2]);
    for (const m of src.matchAll(/const KEY = 'wickline\.([^']+)'/g)) keys.add(m[1]);
    if (/`wickline\.drawings\.\$\{/.test(src)) keys.add('drawings.*');
  }
  return { keys, dynamic };
}

test('every upstream storage key is classified', () => {
  const { keys } = upstreamKeys();
  const missing = [...keys].filter((k) => !(k in classes));
  assert.deepEqual(missing, [], `${point('storage-keys')} classify these in selfhost/sync/key-classes.json`);
});

test('no storage key is computed at runtime (the allow-list must stay exact)', () => {
  const { dynamic } = upstreamKeys();
  assert.deepEqual(dynamic, [], `${point('storage-keys')} a computed key cannot be allow-listed by name`);
});

test('every classified key has a known policy', () => {
  for (const [k, v] of Object.entries(classes)) {
    assert.ok(['cas', 'merge', 'lww', 'local'].includes(v.policy), `${k}: ${v.policy}`);
  }
});

test('stale classifications are reported (keys upstream no longer uses)', (t) => {
  const { keys } = upstreamKeys();
  const stale = Object.keys(classes).filter((k) => !keys.has(k));
  if (stale.length) t.diagnostic(`classified but unused upstream: ${stale.join(', ')}`);
});

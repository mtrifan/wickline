#!/usr/bin/env node
// Fails when the self-hosted branch modifies an upstream file. Self-hosting code must live in
// selfhost/ (see ARCHITECTURE.md §4). Compares HEAD with the newest upstream release merged into
// it. A differing upstream file is still accepted when:
//   - it is identical to upstream's main (an upstream fix cherry-picked ahead of a release), or
//   - it is listed in selfhost/UPSTREAM_PATCHES.json with a reason (deliberate, documented patch).
//
// Usage: node selfhost/ci/check-upstream-untouched.mjs [--root <checkout>] [--base <ref>] [--upstream-main <ref>]
// Needs upstream tags and main fetched locally, e.g.
//   git fetch --no-tags https://github.com/keptaduona/wickline.git '+refs/tags/v*:refs/tags/v*' '+refs/heads/main:refs/remotes/upstream/main'

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

// --root checks another checkout (CI runs this trusted copy against the merged upstream tree).
const ROOT = path.resolve(arg('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };

export const ALLOWED = [
  /^selfhost\//,
  /^\.github\/workflows\/selfhost-[\w.-]+\.ya?ml$/,
  /^(UPSTREAM|SELFHOSTED|ARCHITECTURE|CHANGELOG-SELFHOSTED|UPGRADE)\.md$/,
];

export const isAllowedPath = (file) => ALLOWED.some((re) => re.test(file));

function main() {
  const base = arg('--base') || tryGit('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  if (!base) {
    console.error('No upstream release tag reachable from HEAD. Fetch upstream tags first (see the header of this script).');
    process.exit(2);
  }
  const upstreamMain = arg('--upstream-main') || (tryGit('rev-parse', '--verify', '-q', 'upstream/main') ? 'upstream/main' : null);

  const patchesFile = path.join(ROOT, 'selfhost/UPSTREAM_PATCHES.json');
  const patches = existsSync(patchesFile) ? JSON.parse(readFileSync(patchesFile, 'utf8')).patches || [] : [];
  const patched = new Map(patches.map((p) => [p.file, p.reason]));

  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const violations = [];
  const notes = [];
  for (const file of changed) {
    if (isAllowedPath(file)) continue;
    if (patched.has(file)) { notes.push(`patched upstream file (documented): ${file} — ${patched.get(file)}`); continue; }
    if (upstreamMain) {
      const ours = tryGit('rev-parse', `HEAD:${file}`);
      const theirs = tryGit('rev-parse', `${upstreamMain}:${file}`);
      if (ours === theirs) { notes.push(`matches upstream main (cherry-picked fix): ${file}`); continue; }
    }
    violations.push(file);
  }

  console.log(`Compared HEAD with upstream ${base}${upstreamMain ? ` (and ${upstreamMain})` : ''}: ${changed.length} changed file(s).`);
  for (const n of notes) console.log(`  ok  ${n}`);
  if (violations.length) {
    console.error('\nUpstream files modified outside selfhost/ (move the change into selfhost/, or document it in selfhost/UPSTREAM_PATCHES.json):');
    for (const v of violations) console.error(`  ✖ ${v}`);
    process.exit(1);
  }
  console.log('No upstream file is modified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

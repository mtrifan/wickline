#!/usr/bin/env node
// Fails when the self-hosted branch modifies an upstream file. Self-hosting code must live in
// selfhost/ (see selfhost/docs/PLAN.md §4). Compares HEAD with the newest upstream release merged into
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

/** `<mode> <type> <sha>` of a path at a ref, or null when absent. */
const entry = (ref, file) => { const out = tryGit('ls-tree', ref, '--', file); return out ? out.split('\t')[0] : null; };

/** Reads and validates selfhost/UPSTREAM_PATCHES.json against the base release. */
export function loadPatches(base) {
  const file = path.join(ROOT, 'selfhost/UPSTREAM_PATCHES.json');
  if (!existsSync(file)) return new Map();
  const patches = JSON.parse(readFileSync(file, 'utf8')).patches;
  if (!Array.isArray(patches)) throw new Error('UPSTREAM_PATCHES.json: "patches" must be an array');
  const out = new Map();
  for (const p of patches) {
    if (!p || typeof p.file !== 'string' || !p.file) throw new Error('UPSTREAM_PATCHES.json: every entry needs a "file"');
    if (typeof p.reason !== 'string' || p.reason.trim().length < 10) throw new Error(`UPSTREAM_PATCHES.json: ${p.file} needs a real "reason"`);
    if (isAllowedPath(p.file)) throw new Error(`UPSTREAM_PATCHES.json: ${p.file} is a selfhost path, not an upstream file`);
    if (!entry(base, p.file)) throw new Error(`UPSTREAM_PATCHES.json: ${p.file} does not exist in upstream ${base}`);
    out.set(p.file, p.reason);
  }
  return out;
}

/** Compares HEAD of ROOT with an upstream release; returns { base, changed, violations, notes }. */
export function checkUntouched({ base, upstreamMain } = {}) {
  base ||= tryGit('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  if (!base) throw Object.assign(new Error('No upstream release tag reachable from HEAD. Fetch upstream tags first (see the header of this script).'), { code: 2 });
  if (upstreamMain === undefined) upstreamMain = tryGit('rev-parse', '--verify', '-q', 'upstream/main') ? 'upstream/main' : null;
  const patched = loadPatches(base);
  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  const violations = [];
  const notes = [];
  for (const file of changed) {
    if (isAllowedPath(file)) continue;
    if (patched.has(file)) { notes.push(`patched upstream file (documented): ${file} — ${patched.get(file)}`); continue; }
    if (upstreamMain) {
      // Same content and mode as upstream main (an upstream fix cherry-picked ahead of a release).
      const ours = entry('HEAD', file);
      if (ours && ours === entry(upstreamMain, file)) { notes.push(`matches upstream main (cherry-picked fix): ${file}`); continue; }
    }
    violations.push(file);
  }
  return { base, upstreamMain, changed, violations, notes };
}

function main() {
  let r;
  try { r = checkUntouched({ base: arg('--base') || undefined, upstreamMain: arg('--upstream-main') || undefined }); }
  catch (e) { console.error(e.message); process.exit(e.code || 1); }
  console.log(`Compared HEAD with upstream ${r.base}${r.upstreamMain ? ` (and ${r.upstreamMain})` : ''}: ${r.changed.length} changed file(s).`);
  for (const n of r.notes) console.log(`  ok  ${n}`);
  if (r.violations.length) {
    console.error('\nUpstream files modified outside selfhost/ (move the change into selfhost/, or document it in selfhost/UPSTREAM_PATCHES.json):');
    for (const v of r.violations) console.error(`  ✖ ${v}`);
    process.exit(1);
  }
  console.log('No upstream file is modified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

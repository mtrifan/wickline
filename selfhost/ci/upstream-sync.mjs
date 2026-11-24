#!/usr/bin/env node
// Upstream synchronisation for the self-hosted fork (see UPSTREAM.md and ARCHITECTURE.md §5.3).
//
//   prepare  (job A: read-only token, no secrets) finds the newest upstream release, merges it into a
//            temporary integration branch, and writes report.json + merged.bundle into --out.
//   publish  (job C: SYNC_TOKEN, runs no upstream code) asserts repository settings, fast-forwards
//            main, and opens or updates exactly one PR or issue from the report and the validation
//            result of job B.
//
// Every git/gh call passes arguments as an array (no shell), so text from upstream (release notes,
// commit subjects, file names) can never become a command.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MARKER_PREFIX = 'upstream-sync';
export const LABEL = 'upstream-sync';
const ROLLING_TITLE = 'Upstream: unreleased changes';

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------------------------

/** Parses 'v1.2.3' (optionally with a pre-release suffix) into a comparable tuple, else null. */
export function parseVersion(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag || '');
  return m ? { tag, nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null } : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1; // a release ranks above its pre-releases
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Newest stable tag among the given names (pre-releases ignored). */
export function newestStable(tags) {
  return tags.map(parseVersion).filter((v) => v && !v.pre).sort(compareVersions).at(-1)?.tag ?? null;
}

/** Hidden marker that identifies the PR/issue for one upstream version (duplicate guard). */
export const marker = (kind, version) => `<!-- ${MARKER_PREFIX}:${kind}:${version} -->`;

/** Converts a glob-ish integration-point file spec into a matcher. */
function fileMatcher(spec) {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const res = parts.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`));
  return (file) => res.some((re) => re.test(file));
}

/** Integration points whose upstream files appear in `changedFiles`. */
export function touchedPoints(points, changedFiles) {
  return points
    .map((p) => ({ ...p, files: changedFiles.filter(fileMatcher(p.file)) }))
    .filter((p) => p.files.length);
}

/**
 * Workflow files in an upstream-only diff. Every one counts, whatever its name: an upstream file
 * named selfhost-*.yml is still upstream code.
 */
export const upstreamWorkflowChanges = (upstreamChangedFiles) =>
  upstreamChangedFiles.filter((f) => /^\.github\/workflows\//.test(f));

/** Upstream files that land in paths this fork owns (selfhost/, selfhost-* workflows, root docs). */
export const forkPathCollisions = (upstreamChangedFiles) =>
  upstreamChangedFiles.filter((f) => /^selfhost\//.test(f) || /^\.github\/workflows\/selfhost-/.test(f)
    || /^(UPSTREAM|SELFHOSTED|ARCHITECTURE|CHANGELOG-SELFHOSTED|UPGRADE)\.md$/.test(f));

/**
 * Makes upstream text safe to post in this repository: no @-mentions (they would notify upstream
 * people), issue references point at upstream instead of this fork, and the text is bounded.
 */
export function sanitizeUpstreamText(text, upstreamRepo, max = 6000) {
  let s = String(text || '').replace(/\r\n/g, '\n');
  s = s.replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g, '$1@\u200b$2');
  s = s.replace(/(^|[\s(])#(\d+)\b/g, `$1${upstreamRepo}#$2`);
  // Strip HTML comments until none are left (a single pass can be defeated by nesting), then
  // defang the marker prefix so upstream text can never imitate a duplicate-guard marker.
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/<!--[\s\S]*?-->/g, ''); }
  s = s.replace(/<!--/g, '&lt;!--').replace(new RegExp(MARKER_PREFIX, 'gi'), `${MARKER_PREFIX.slice(0, 8)}\u200b${MARKER_PREFIX.slice(8)}`);
  return s.length > max ? `${s.slice(0, max)}\n\n… (truncated)` : s;
}

/** True when `body` was written by this bot for `kind` (and `version`, if given): marker at the very start. */
export const hasMarker = (body, kind, version) =>
  typeof body === 'string' && (version ? body.startsWith(marker(kind, version)) : body.startsWith(`<!-- ${MARKER_PREFIX}:${kind}:`));

/**
 * Validation verdict from GitHub's own step outcomes (passed in by the workflow through `needs`
 * outputs), never from files upstream code could have written.
 */
export const VALIDATION_CHECKS = [
  ['npmci', 'npm ci --ignore-scripts'],
  ['upstream', 'upstream tests (npm test)'],
  ['selfhost', 'selfhost unit + contract tests'],
  ['untouched', 'no upstream file modified'],
];
export function validationFromOutcomes(outcomes, runUrl) {
  const rows = VALIDATION_CHECKS.map(([id, label]) => ({ id, label, outcome: outcomes[id] || 'not run' }));
  const ok = rows.every((r) => r.outcome === 'success');
  const summary = [
    '| Check | Result |', '|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.outcome === 'success' ? '✅ success' : `❌ ${r.outcome}`} |`),
    '', runUrl ? `Logs: ${runUrl}` : '',
  ].join('\n').trim();
  return { ok, summary, rows };
}

const list = (items, fmt = (x) => `- \`${x}\``) => (items.length ? items.map(fmt).join('\n') : '_none_');

export function prBody(r, validation) {
  return [
    marker('pr', r.version),
    `## Integrate upstream ${r.version}`,
    '',
    `Merges upstream release [${r.version}](https://github.com/${r.upstreamRepo}/releases/tag/${r.version}) into \`${r.base}\` (previously integrated: \`${r.previous}\`).`,
    r.skipped.length ? `Skipped intermediate releases (contained in this one): ${r.skipped.map((t) => `\`${t}\``).join(', ')}.` : '',
    '',
    '### Validation (job B, no secrets)',
    validation.summary,
    '',
    '### Self-hosting integration points touched',
    r.points.length
      ? r.points.map((p) => `- **${p.id}**: ${p.contract}\n  - files: ${p.files.map((f) => `\`${f}\``).join(', ')}\n  - test: \`selfhost/${p.test}\``).join('\n')
      : '_none — no upstream file the self-hosted edition depends on changed_',
    '',
    '### Upstream workflow files added or changed',
    r.workflows.length ? `${list(r.workflows)}\n\n> New upstream workflows are active by default in this fork. Disable them under Actions unless needed (see UPSTREAM.md).` : '_none_',
    '',
    '### Upstream release notes',
    r.notes ? sanitizeUpstreamText(r.notes, r.upstreamRepo) : '_none published_',
    '',
    `<details><summary>Upstream commits (${r.commits.length})</summary>\n\n${list(r.commits, (c) => `- ${sanitizeUpstreamText(c, r.upstreamRepo, 300)}`)}\n\n</details>`,
    '',
    '### Reviewer checklist',
    '- [ ] Release notes reviewed for behaviour the self-hosted edition must follow',
    '- [ ] Touched integration points still hold (contract tests green)',
    '- [ ] New upstream workflows disabled, or deliberately kept',
    '- [ ] `CHANGELOG-SELFHOSTED.md` updated if user-visible',
    '- [ ] Merge with a **merge commit** (squash/rebase are disabled; release detection relies on it)',
    '',
    '_Opened by `selfhost-upstream-sync`. Never auto-merged._',
  ].filter((l) => l !== null && l !== false).join('\n').replace(/\n{3,}/g, '\n\n');
}

export function conflictBody(r) {
  return [
    marker('conflict', r.version),
    `Merging upstream **${r.version}** into \`${r.base}\` conflicts. No PR was opened.`,
    '',
    '### Conflicting files',
    list(r.conflicts),
    '',
    '### Integration points involved',
    list(r.points.map((p) => `${p.id} (${p.files.join(', ')})`)),
    '',
    '### Resolve locally',
    '```sh',
    `git fetch --no-tags https://github.com/${r.upstreamRepo}.git 'refs/tags/${r.version}:refs/tags/${r.version}'`,
    `git switch -c integrate/upstream-${r.version} origin/${r.base}`,
    `git merge --no-ff ${r.version}`,
    '# resolve, keeping upstream files identical to upstream and moving changes into selfhost/',
    'npm ci --ignore-scripts && npm test && (cd selfhost && npm test) && node selfhost/ci/check-upstream-untouched.mjs',
    `git push -u origin integrate/upstream-${r.version}   # then open a PR into ${r.base}`,
    '```',
    '',
    '### Upstream release notes',
    r.notes ? sanitizeUpstreamText(r.notes, r.upstreamRepo) : '_none published_',
  ].join('\n');
}

export function workflowsChangedBody(r) {
  return [
    marker('workflows', r.version),
    `Upstream **${r.version}** changes GitHub Actions workflow files. The bot does not push upstream workflow changes, because that would run new upstream workflow code in this repository. Integrate this release by hand.`,
    '',
    '### Workflow files changed upstream',
    list(r.workflows),
    '',
    '### Upstream files in paths this fork owns',
    list(r.collisions || []),
    '',
    '### Steps',
    '1. Review each workflow change upstream.',
    '2. Integrate locally (commands below) and push the branch from your own machine.',
    '3. After merging, keep every non-`selfhost-*` workflow disabled under **Actions** unless deliberately wanted.',
    '',
    '```sh',
    `git fetch --no-tags https://github.com/${r.upstreamRepo}.git 'refs/tags/${r.version}:refs/tags/${r.version}'`,
    `git switch -c integrate/upstream-${r.version} origin/${r.base}`,
    `git merge --no-ff ${r.version}`,
    'npm ci --ignore-scripts && npm test && (cd selfhost && npm test) && node selfhost/ci/check-upstream-untouched.mjs',
    `git push -u origin integrate/upstream-${r.version}`,
    '```',
    '',
    '### Integration points touched',
    list(r.points.map((p) => `${p.id} → selfhost/${p.test}`)),
    '',
    '### Upstream release notes',
    r.notes ? sanitizeUpstreamText(r.notes, r.upstreamRepo) : '_none published_',
  ].join('\n');
}

export function validationFailedBody(r, validation, branchUrl) {
  return [
    marker('validation', r.version),
    `Upstream **${r.version}** merges cleanly into \`${r.base}\` but validation failed. No PR was opened.`,
    '',
    `Branch for debugging: ${branchUrl}`,
    '',
    '### Validation',
    validation.summary,
    '',
    '### Integration points touched',
    list(r.points.map((p) => `${p.id} → selfhost/${p.test}`)),
  ].join('\n');
}

export function rollingBody(r) {
  return [
    marker('unreleased', 'rolling'),
    `Upstream \`main\` is **${r.unreleased.length}** commit(s) ahead of its latest release \`${r.version}\`.`,
    'These are not integrated automatically; an upstream release, or a manual cherry-pick (`hotfix/upstream-<sha>`, see UPSTREAM.md), brings them in.',
    '',
    list(r.unreleased, (c) => `- ${sanitizeUpstreamText(c, r.upstreamRepo, 300)}`),
    '',
    `_Updated ${r.generatedAt} by \`selfhost-upstream-sync\`._`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------------

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tryRun = (cmd, args, opts) => { try { return run(cmd, args, opts); } catch { return null; } };
const git = (...a) => run('git', a);
const tryGit = (...a) => tryRun('git', a);
const gh = (...a) => run('gh', a);
const ghJson = (...a) => JSON.parse(gh(...a) || 'null');

function args() {
  const out = {};
  const a = process.argv.slice(3);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1]?.startsWith('--') || a[i + 1] == null ? true : a[++i];
  return out;
}

function env(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') { if (fallback === undefined) throw new Error(`${name} is required`); return fallback; }
  return v;
}

// ---------------------------------------------------------------------------------------------
// prepare (job A)
// ---------------------------------------------------------------------------------------------

function prepare() {
  const o = args();
  const out = path.resolve(o.out || 'sync-out');
  mkdirSync(out, { recursive: true });
  const repo = env('REPO');
  const upstreamRepo = env('UPSTREAM_REPO', 'keptaduona/wickline');
  const base = env('BASE_BRANCH', 'selfhosted');
  const forced = o.version && o.version !== true ? o.version : null;

  // Upstream refs live only in this runner: tags under refs/tags, main under refs/remotes/upstream.
  git('fetch', '--no-tags', '--quiet', `https://github.com/${upstreamRepo}.git`, '+refs/tags/v*:refs/tags/v*', '+refs/heads/main:refs/remotes/upstream/main');
  git('fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`);

  // Published releases (drafts are invisible to other repos; pre-releases ignored). Tags as fallback.
  let releases = [];
  try { releases = ghJson('api', `repos/${upstreamRepo}/releases?per_page=30`).filter((x) => !x.draft && !x.prerelease); } catch { /* fall back to tags */ }
  const releaseTags = releases.map((x) => x.tag_name).filter((t) => tryGit('rev-parse', '-q', '--verify', `refs/tags/${t}`));
  const allTags = git('tag', '--list', 'v*').split('\n').filter(Boolean);
  const version = forced || newestStable(releaseTags.length ? releaseTags : allTags);
  if (!version) throw new Error('No upstream release found');

  const baseRef = `refs/remotes/origin/${base}`;
  const previous = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', baseRef) || null;
  const integrated = tryGit('merge-base', '--is-ancestor', `refs/tags/${version}`, baseRef) !== null;

  const prevV = previous && parseVersion(previous);
  const curV = parseVersion(version);
  const skipped = allTags.map(parseVersion).filter((v) => v && !v.pre && prevV && compareVersions(v, prevV) > 0 && compareVersions(v, curV) < 0).sort(compareVersions).map((v) => v.tag);

  const range = previous ? `${previous}..${version}` : version;
  const changed = previous ? git('diff', '--name-only', previous, version).split('\n').filter(Boolean) : [];
  const commits = git('log', '--no-merges', '--format=%h %s', range).split('\n').filter(Boolean).slice(0, 200);
  const unreleased = git('log', '--no-merges', '--format=%h %s', `${version}..refs/remotes/upstream/main`).split('\n').filter(Boolean).slice(0, 200);
  const points = touchedPoints(JSON.parse(readFileSync(path.join(ROOT, 'selfhost/INTEGRATION_POINTS.json'), 'utf8')).points, changed);

  const report = {
    generatedAt: new Date().toISOString(), repo, upstreamRepo, base, version, previous, skipped,
    integrated, branch: `integrate/upstream-${version}`, status: integrated ? 'up-to-date' : 'pending',
    conflicts: [], points, workflows: upstreamWorkflowChanges(changed), collisions: forkPathCollisions(changed), commits, unreleased,
    notes: releases.find((x) => x.tag_name === version)?.body || '',
    upstreamMain: git('rev-parse', 'refs/remotes/upstream/main'),
    existing: { pr: null, issue: null },
  };

  // Duplicate guard: an open PR for the branch, or an open issue carrying this version's marker.
  if (!integrated) {
    const prs = ghJson('pr', 'list', '--repo', repo, '--state', 'open', '--head', report.branch, '--json', 'number,url');
    report.existing.pr = prs[0] || null;
    const issues = ghJson('issue', 'list', '--repo', repo, '--state', 'open', '--label', LABEL, '--limit', '100', '--json', 'number,url,body');
    report.existing.issue = issues.find((i) => ['conflict', 'validation', 'workflows'].some((k) => hasMarker(i.body, k, version))) || null;
  }

  if (!integrated) {
    git('switch', '--quiet', '-C', report.branch, baseRef);
    const merged = tryRun('git', ['-c', 'user.name=selfhost-upstream-sync', '-c', 'user.email=selfhost-upstream-sync@users.noreply.github.com',
      'merge', '--no-ff', '--no-edit', '-m', `chore(upstream): integrate ${version}`, `refs/tags/${version}`]);
    if (merged === null) {
      report.conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      tryGit('merge', '--abort');
      report.status = 'conflict';
    } else if (report.workflows.length || report.collisions.length) {
      // Upstream changed its workflow files. Pushing them would let new upstream workflow code run
      // in this repository, so this release is integrated by hand (see UPSTREAM.md).
      report.status = 'workflows-changed';
    } else {
      report.status = 'merged';
      git('bundle', 'create', path.join(out, 'merged.bundle'), `refs/heads/${report.branch}`);
    }
  }

  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`upstream ${version} (previous ${previous ?? 'none'}): ${report.status}; ${points.length} integration point(s) touched; ${unreleased.length} unreleased upstream commit(s)`);
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) writeFileSync(ghOut, `status=${report.status}\nversion=${version}\nbranch=${report.branch}\n`, { flag: 'a' });
}

// ---------------------------------------------------------------------------------------------
// publish (job C)
// ---------------------------------------------------------------------------------------------

function assertSettings(repo) {
  const r = ghJson('api', `repos/${repo}`);
  const problems = [];
  if (r.allow_squash_merge) problems.push('squash merging is enabled (release detection needs merge commits)');
  if (r.allow_rebase_merge) problems.push('rebase merging is enabled (release detection needs merge commits)');
  if (!r.allow_merge_commit) problems.push('merge commits are disabled');
  const wf = ghJson('api', `repos/${repo}/actions/workflows?per_page=100`).workflows;
  for (const w of wf) {
    if (!/^\.github\/workflows\/selfhost-/.test(w.path) && w.state === 'active') problems.push(`upstream workflow is active: ${w.path} (disable it under Actions)`);
  }
  return problems;
}

function upsertIssue({ repo, title, body, existing, dry }) {
  if (dry) { console.log(`[dry-run] ${existing ? `update issue #${existing.number}` : 'create issue'}: ${title}`); return; }
  if (existing) gh('issue', 'edit', String(existing.number), '--repo', repo, '--body', body);
  else gh('issue', 'create', '--repo', repo, '--title', title, '--label', LABEL, '--body', body);
}

function publish() {
  const o = args();
  const dir = path.resolve(o.in || 'sync-out');
  const dry = o['dry-run'] === true || o['dry-run'] === 'true';
  const r = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
  // Outcomes come from the workflow (`needs.validate.outputs`), set by the runner itself.
  const validation = validationFromOutcomes({
    npmci: process.env.V_NPMCI, upstream: process.env.V_UPSTREAM, selfhost: process.env.V_SELFHOST, untouched: process.env.V_UNTOUCHED,
  }, process.env.RUN_URL);
  const repo = r.repo;

  if (!dry) tryRun('gh', ['label', 'create', LABEL, '--repo', repo, '--color', '0E8A16', '--description', 'Automated upstream integration', '--force']);

  // 1. Repository settings the strategy relies on (not stored in git, so checked every run).
  const problems = assertSettings(repo);
  if (problems.length) {
    const body = [marker('settings', 'current'), 'The upstream sync requires these repository settings:', '', ...problems.map((p) => `- ${p}`)].join('\n');
    const existing = ghJson('issue', 'list', '--repo', repo, '--state', 'open', '--label', LABEL, '--json', 'number,body').find((i) => hasMarker(i.body, 'settings'));
    upsertIssue({ repo, title: 'Upstream sync: repository settings need attention', body, existing, dry });
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }

  // 2. main mirrors upstream/main: fast-forward only, branch only (tags are never pushed).
  // A mirror push that adds or changes workflow files would activate upstream workflow code here,
  // so those updates wait for the owner (the token can push workflow files).
  git('fetch', '--no-tags', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const mirrorWorkflows = upstreamWorkflowChanges(git('diff', '--name-only', 'refs/remotes/origin/main', r.upstreamMain).split('\n').filter(Boolean));
  let ff = 'skipped';
  if (mirrorWorkflows.length) {
    const existing = ghJson('issue', 'list', '--repo', repo, '--state', 'open', '--label', LABEL, '--json', 'number,body').find((i) => hasMarker(i.body, 'mirror-workflows'));
    upsertIssue({ repo, title: 'Upstream sync: main not mirrored (upstream workflow files changed)', existing, dry,
      body: [marker('mirror-workflows', 'main'), 'Upstream `main` changes workflow files, so the bot did not fast-forward this fork\'s `main` (that would run new upstream workflow code here).', '', list(mirrorWorkflows), '',
        'Review the changes, then mirror by hand and keep non-`selfhost-*` workflows disabled:', '```sh', `git fetch --no-tags https://github.com/${r.upstreamRepo}.git main`, 'git push origin FETCH_HEAD:refs/heads/main', '```'].join('\n') });
  } else if (!dry) {
    ff = tryGit('push', 'origin', `${r.upstreamMain}:refs/heads/main`);
  }
  if (ff === null) {
    const existing = ghJson('issue', 'list', '--repo', repo, '--state', 'open', '--label', LABEL, '--json', 'number,body').find((i) => hasMarker(i.body, 'mirror'));
    upsertIssue({ repo, title: 'Upstream sync: main cannot be fast-forwarded', existing, dry,
      body: `${marker('mirror', 'main')}\nUpstream \`main\` is not a fast-forward of this fork's \`main\` (upstream rewrote history, or \`main\` was committed to). Inspect and reset \`main\` to upstream manually.` });
    process.exitCode = 1;
  }

  // 3. One PR or one issue per upstream version.
  const branchUrl = `https://github.com/${repo}/tree/${encodeURIComponent(r.branch)}`;
  if (r.status === 'merged') {
    if (!dry) {
      git('fetch', '--quiet', path.join(dir, 'merged.bundle'), `+refs/heads/${r.branch}:refs/heads/${r.branch}`);
      // integrate/* branches belong to the bot; a re-run replaces the previous attempt.
      git('push', '--force', 'origin', `refs/heads/${r.branch}:refs/heads/${r.branch}`);
    }
    if (validation.ok) {
      const title = `chore(upstream): integrate ${r.version}`;
      if (r.existing.pr) {
        if (!dry) gh('pr', 'edit', String(r.existing.pr.number), '--repo', repo, '--body', prBody(r, validation));
        console.log(`${dry ? '[dry-run] ' : ''}updated PR ${r.existing.pr.url}`);
      } else if (dry) {
        console.log(`[dry-run] create PR "${title}" ${r.branch} -> ${r.base}\n----\n${prBody(r, validation)}\n----`);
      } else {
        gh('pr', 'create', '--repo', repo, '--base', r.base, '--head', r.branch, '--title', title, '--label', LABEL, '--body', prBody(r, validation));
      }
      if (r.existing.issue && !dry) gh('issue', 'close', String(r.existing.issue.number), '--repo', repo, '--comment', `Superseded: ${r.version} now integrates cleanly and passes validation.`);
    } else {
      upsertIssue({ repo, title: `Upstream ${r.version}: validation failed`, body: validationFailedBody(r, validation, branchUrl), existing: r.existing.issue, dry });
    }
  } else if (r.status === 'workflows-changed') {
    upsertIssue({ repo, title: `Upstream ${r.version}: workflow files changed (manual integration)`, body: workflowsChangedBody(r), existing: r.existing.issue, dry });
  } else if (r.status === 'conflict') {
    upsertIssue({ repo, title: `Upstream ${r.version}: merge conflicts`, body: conflictBody(r), existing: r.existing.issue, dry });
  } else {
    console.log(`upstream ${r.version} already integrated into ${r.base}`);
  }

  // 4. Rolling issue for unreleased upstream commits.
  const rolling = ghJson('issue', 'list', '--repo', repo, '--state', 'open', '--label', LABEL, '--json', 'number,body').find((i) => hasMarker(i.body, 'unreleased'));
  if (r.unreleased.length) upsertIssue({ repo, title: ROLLING_TITLE, body: rollingBody(r), existing: rolling, dry });
  else if (rolling && !dry) gh('issue', 'close', String(rolling.number), '--repo', repo, '--comment', `Covered by upstream ${r.version}.`);

  // 5. Heartbeat for the watchdog workflow.
  if (!dry && !process.exitCode) tryRun('gh', ['variable', 'set', 'UPSTREAM_SYNC_LAST_OK', '--repo', repo, '--body', new Date().toISOString()]);
}

// ---------------------------------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const fns = { prepare, publish };
  if (!fns[cmd]) { console.error('usage: upstream-sync.mjs prepare|publish [--out dir | --in dir] [--version vX.Y.Z] [--dry-run]'); process.exit(2); }
  try { fns[cmd](); } catch (e) { console.error(e.stderr?.toString() || e.message); process.exit(1); }
}

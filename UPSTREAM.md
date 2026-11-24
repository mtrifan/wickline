# Upstream maintenance

This repository is an unofficial, self-hosted edition of [keptaduona/wickline](https://github.com/keptaduona/wickline) (MIT). It is a personal project and is not affiliated with the upstream author.

Upstream compatibility is a primary requirement. The rule that makes it cheap: **upstream files are never modified.** All self-hosting code lives in `selfhost/`, in workflows named `selfhost-*`, and in the five root documents (`UPSTREAM.md`, `SELFHOSTED.md`, `ARCHITECTURE.md`, `CHANGELOG-SELFHOSTED.md` and `UPGRADE.md`). CI enforces this rule with `selfhost/ci/check-upstream-untouched.mjs`. The one escape hatch is `selfhost/UPSTREAM_PATCHES.json`, where each entry needs a reason and ideally an upstream PR.

## Branches

| Branch | Purpose | Rules |
|---|---|---|
| `main` | Exact mirror of `upstream/main` | Fast-forward only, updated by the sync bot. Branch only: **upstream tags are never pushed to this fork**, so upstream's `release.yml` (`v*` tags) cannot fire. Never deployed. |
| `selfhosted` | Default branch; production line | Protected. Changes arrive by PR with CI green. **Merge commits only**: squash and rebase merging are disabled, because release detection (`git merge-base --is-ancestor`) needs real merge commits. |
| `integrate/upstream-vX.Y.Z` | Temporary: one upstream release merged into `selfhosted` | Created by the sync bot. Merged by a human through a PR. |
| `hotfix/upstream-<sha>` | Temporary: one upstream commit cherry-picked ahead of a release | Manual (see below). |
| `feat/*`, `fix/*` | Self-hosting work | PR into `selfhosted`, conventional commits. |

## Versions and tags

- Self-hosted releases are tagged `sh-v<upstream version>-<revision>`, for example `sh-v0.1.9-1`. The prefix deliberately avoids upstream's `v*` trigger.
- `selfhost/VERSION` holds the revision. The upstream version comes from `package.json`.
- Docker images: `ghcr.io/mtrifan/wickline:<upstream>-sh.<rev>` (immutable), `:<upstream>`, `:stable` / `:latest` (validated and approved), `:edge` (every push to `selfhosted`). See [UPGRADE.md](UPGRADE.md).

## Automated synchronisation (`selfhost-upstream-sync`, daily 05:17 UTC)

The workflow has three jobs, so new upstream code never runs where a write token exists.

1. **prepare** (read-only token)
   - Finds the newest *published* upstream release. Drafts and pre-releases are ignored.
   - Checks whether that release is already merged into `selfhosted`.
   - Looks for an existing PR or issue for that release, using hidden markers `<!-- upstream-sync:<kind>:<version> -->`.
   - Merges the release into `integrate/upstream-<version>`.
   - Computes the touched integration points (`selfhost/INTEGRATION_POINTS.json`), any new upstream workflow files, the release notes, and the commits on upstream `main` that are not yet released.
2. **validate** (no secrets) runs on the merged tree. The pass/fail verdict comes from the runner's step outcomes, not from files that upstream code could rewrite:
   - upstream `npm test`;
   - selfhost unit and contract tests;
   - the upstream-untouched check.
3. **publish** (`SYNC_TOKEN`) runs only trusted code from `selfhosted`:
   - Asserts the repository settings: merge commits only, and no active upstream workflow.
   - Fast-forwards `main`.
   - Opens or updates exactly one of:
     - a **PR** (clean merge, validation green);
     - an **issue** "workflow files changed", when the release modifies upstream `.github/workflows`. The bot never pushes upstream workflow changes, because that would run new upstream workflow code here. You integrate that release by hand;
     - an **issue** "merge conflicts", with the files, the affected integration points and the resolution commands;
     - an **issue** "validation failed", with log excerpts. The branch is pushed for debugging.
   - Keeps one rolling issue, *Upstream: unreleased changes*, up to date.
   - Records a heartbeat in the repository variable `UPSTREAM_SYNC_LAST_OK`.

Additional safeguards:
- Nothing is merged or deployed automatically.
- Intermediate releases are skipped and listed in the PR, because the newest release contains the older ones.
- `selfhost-sync-watchdog` (weekly) opens an issue if no sync has succeeded for 3 days. Causes: GitHub disables schedules after 60 days of inactivity, or the token expired.
- Manual run: **Actions → selfhost-upstream-sync → Run workflow**, with `dry_run` to preview or `version` to pin a tag.

## Reviewing an integration PR

1. Read the release notes and the **integration points touched** section. Each entry names the contract test that proves the behaviour still holds.
2. If the contract tests fail, adapt `selfhost/`. Never edit the upstream file. Push the fix to the integration branch.
3. **New upstream workflows** are active by default in a fork. Disable them under **Actions** unless you deliberately want them. The next sync run fails its settings check until you decide.
4. Update `CHANGELOG-SELFHOSTED.md` if anything changes for users.
5. Merge with **Create a merge commit**, then tag a self-hosted release if it should ship (see UPGRADE.md).

## Resolving conflicts manually

Conflicts should be rare, because upstream files are untouched. The issue the bot opens lists exact commands. In short:

```sh
git fetch --no-tags https://github.com/keptaduona/wickline.git 'refs/tags/vX.Y.Z:refs/tags/vX.Y.Z'
git switch -c integrate/upstream-vX.Y.Z origin/selfhosted
git merge --no-ff vX.Y.Z
# resolve: upstream files take upstream's version; self-hosting changes move into selfhost/
npm ci --ignore-scripts && npm test && (cd selfhost && npm test) && node selfhost/ci/check-upstream-untouched.mjs
git push -u origin integrate/upstream-vX.Y.Z    # open a PR into selfhosted
```

## Cherry-picking a critical upstream fix before a release

```sh
git fetch --no-tags https://github.com/keptaduona/wickline.git '+refs/heads/main:refs/remotes/upstream/main'
git switch -c hotfix/upstream-<sha> origin/selfhosted
git cherry-pick -x <sha>
git push -u origin hotfix/upstream-<sha>        # PR into selfhosted, label: upstream-cherry-pick
```

The untouched check accepts a file that is identical to upstream `main`. When the release that contains the fix is merged later, git resolves the duplicate change cleanly.

## Repository settings this strategy relies on

These live outside git, and the sync job verifies them on every run:
- **Default branch:** `selfhosted`. Merge commits on; squash and rebase off; head branches deleted automatically on merge.
- **Actions:** `release.yml`, `pages.yml` and `community.yml` disabled. All `selfhost-*` workflows enabled.
- **Default workflow permissions:** read-only (Settings → Actions → General). Workflows request write scopes explicitly.
- **Environment `upstream-sync`:** deployment branches limited to `selfhosted`. It holds the `SYNC_TOKEN` secret, so workflows running on `integrate/*` or PR branches can never read it.
- **Secret `SYNC_TOKEN`** (in the `upstream-sync` environment, not a repository secret): a fine-grained personal access token on the owner's account.
  - **Repository access:** only this repository.
  - **Permissions:**
    - Contents: read/write
    - Pull requests: read/write
    - Issues: read/write
    - Workflows: read/write (upstream merges can change workflow files)
    - Variables: read/write
    - Administration: read
  - **Expiry:** 90 days. Renew it before it expires; the watchdog catches a missed renewal.
  - **Why the default `GITHUB_TOKEN` is not enough:** PRs it creates do not trigger CI, and it cannot push changes to `.github/workflows`.

## Maintenance responsibilities

- Review integration PRs promptly. Upstream releases often.
- Keep `selfhost/INTEGRATION_POINTS.json` and `selfhost/sync/key-classes.json` current. A new upstream storage key fails CI until it is classified.
- Renew `SYNC_TOKEN`.
- Prefer fixes that could be contributed upstream. Keep `UPSTREAM_PATCHES.json` empty.

# Changelog: Wickline Self-Hosted

Changes specific to the self-hosted edition. For the app itself, see the upstream [releases](https://github.com/keptaduona/wickline/releases).

Release tags: `sh-v<upstream version>-<revision>`. Image tags: `<upstream version>-sh.<revision>`.

## Unreleased

### Added
- Repository foundation (Phase 0):
  - `selfhost/` workspace;
  - upstream contract tests;
  - CI check that no upstream file is modified;
  - daily upstream synchronisation workflow with a watchdog;
  - maintenance documentation.

Based on upstream **v0.1.9**.

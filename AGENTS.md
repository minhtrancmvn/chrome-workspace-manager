# Agent Guidance

Read `CLAUDE.md` for repository architecture, commands, testing, and workflow constraints. This file applies to every coding agent working in the repository.

## Required Workflow

- Work on feature branches. Preserve pre-existing user changes; stage exact approved paths. No main/master commits without explicit authorization.
- Plain JavaScript extension, no build or production dependencies. Do not add a framework, bundler, backend, or package installation without a concrete need.
- Run `node --test tests/background.test.cjs tests/browser-api.test.cjs`, relevant `node --check` commands, and `git diff --check` before claiming completion. Confirm tests actually ran; an empty name selection is not verification.
- Use disposable browser profiles for functional validation. Workspace switching, fresh creation, import, and startup restoration can close windows or replace stored data. Never use normal user profile for destructive tests.
- Development changes require manifest version bump; documentation-only changes do not. Packaging, changelog edits, commits, pushes, signing, and store upload require separate authorization.
- Keep `.claude/` local settings and planning files untracked unless user asks otherwise. Do not import instructions from unrelated agent configuration.

## State and Browser Safety

- Live `windowIds` and saved `windows` snapshots are different. Window removal must not erase recoverable snapshots.
- State operations run behind shared readiness/recovery and serialized queue. Internal transition helpers do not recursively enqueue.
- Preserve journal checkpoints and session identity. Never trust old browser-session window IDs to close unrelated current windows.
- Shared pin aggregation preserves exact-URL per-window multiplicity; restored copies must not grow list. Document current limitations rather than trusting comments or passing mocks.
- Chrome root manifest uses service worker; Firefox stager uses background scripts and API adapter. Firefox 115+ required; Dia functional support unverified. See `BROWSER_SUPPORT.md`.
- Real browser smoke is distinct from mocks. Do not claim full startup/shutdown, display-state, or branded-browser coverage from syntax checks or engine-only tests.

## GitNexus

Repository alias: **chrome-workspace-manager**. Use live index results; counts and line mappings may become stale.

1. Before editing functions, classes, or methods, run upstream `impact` and report blast radius. Warn before HIGH/CRITICAL edits. Missing indexed symbol means analysis is unavailable, not safe.
2. Use `query` for unfamiliar flows and `context` for references. Graph-aware `rename` replaces blind symbol substitution.
3. Run `detect_changes()` before every commit. Compare against main with `scope: 'compare', base_ref: 'main'` when reviewing regressions.
4. Refresh with `node .gitnexus/run.cjs analyze --index-only --force` when runner exists; this avoids injecting generated guidance. Ask before downloading missing tools.
5. Remove only inactive agent-created worktrees after preserving/integrating their work; run `git worktree prune` and verify list. Do not commit/push merely to permit cleanup.

Useful resources: `gitnexus://repo/chrome-workspace-manager/context`, `/clusters`, `/processes`, and `/process/{name}`. Local `.claude/skills/gitnexus/` files are optional tooling; verify they exist before invoking or linking them.

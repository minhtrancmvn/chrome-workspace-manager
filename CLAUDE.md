# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

Workspace Manager saves groups of browser windows and tabs, closes inactive workspaces, and restores them on demand. Plain JavaScript, HTML, and CSS; no production dependencies, bundler, backend, or compilation. Workspace data stays in the browser's extension storage.

Chrome uses the root Manifest V3 service worker and requires Chrome 102+. Firefox uses a staged Manifest V3 background-script build and requires Firefox 115+. Firefox 156 smoke tests covered creation, tab persistence, fresh-workspace preservation, and switching. Dia uses the Chromium-compatible build but functional behavior remains unverified. See `BROWSER_SUPPORT.md` for installation and limitations.

## Model Routing

Use Opus for planning and synthesis. Delegate independent bounded work to Sonnet and mechanical research to Haiku; use Fable only when architectural ambiguity justifies it. Verify outputs against actual working-tree files, not stale isolated worktrees.

## Build and Testing Commands

Run from repository root:

| Command | Purpose |
|---------|---------|
| `node --test tests/background.test.cjs tests/browser-api.test.cjs` | Full dependency-free regression suite using Node's built-in test runner. |
| `node --test --test-name-pattern='shared pins' tests/background.test.cjs` | Focused tests; confirm matching test names ran, not an empty selection. |
| `node --check background.js` | Background syntax check; does not verify browser behavior. |
| `node --check popup.js` | Popup syntax check. |
| `git diff --check` | Changed-line whitespace check. |
| `node scripts/prepare-browser.cjs firefox /tmp/workspace-manager-firefox` | Stage Firefox runtime files with alternate manifest; destination must be outside repository and absent or empty. No ZIP, signing, or upload. |
| `./package-extension.sh` | Release-only ZIP creation under `releases/`; optionally prompts for changelog input and replaces existing same-version ZIP. |
| `./convert-icons.sh` | Regenerate PNG icons with ImageMagick; may attempt Homebrew installation if missing. |

No npm installation, build target, configured formatter/linter, or CI workflow is required to run the existing tests. Tests use isolated Chrome API mocks; they do not access browser profiles. See `tests/README.md`.

For Chrome development, open `chrome://extensions/`, enable Developer mode, load repository root unpacked, then reload extension after edits and reopen popup. Inspect service worker and popup separately. For Firefox, load staged manifest through `about:debugging#/runtime/this-firefox`; temporary add-ons disappear when Firefox closes.

Manifest shortcut: `Ctrl+Shift+S`, or `Command+Shift+S` on macOS. Browser-level user overrides can differ.

## Architecture

### Runtime and messaging

- `manifest.json` grants `tabs`, `windows`, and `storage`; no content scripts or host permissions.
- `background.js` owns workspace state, persistence, window/tab operations, recovery, settings, and badge updates. Chrome loads `browser-api.js` through `importScripts`; Firefox staging loads adapter before background as scripts.
- `browser-api.js` adapts Firefox's Promise APIs to existing `chrome.*` Promise/callback usage and preserves native Chrome API objects.
- `popup.html` loads adapter and `popup.js`; `popup.css` styles UI. Popup caches background data, sorts cards by `lastAccessed`, and handles settings and backup files.
- Named message actions dispatch through `chrome.runtime.onMessage`, reply with `sendResponse`, and return `true` for asynchronous work. Failures return an `error` field. Payload changes require matching background and popup edits.
- `runStateOperation()` serializes state operations behind initialization and recovery. Internal transition helpers do not enqueue again; delete/import can call switching helpers without deadlocking.

### Persistence and recovery

Four primary local keys: `workspaces`, `activeWorkspaceId`, `sharedPinnedTabs`, and `settings`. Local `workspaceRecovery` journals transitions; local `workspaceStartup` protects startup state or records a session-tagged supersession. Session `workspaceSessionId` distinguishes worker wake from a new browser/extension session.

- Workspace records contain `id`, `name`, `color`, `createdAt`, `lastAccessed`, `windowIds`, `windows`, and `tabs`.
- `windowIds` tracks live ownership. Saved `windows[].tabs` and `windowState` hold restorable data. Normal bounds include `left`, `top`, `width`, and `height`; other window states generally store only state name.
- Tab records contain `url`, `title`, and `pinned`. Workspace-level `tabs` is usually a count, but validated arrays remain supported; restorable data belongs in `windows[].tabs`.
- Initialization shares one readiness promise and migrates legacy `windowId` to `windowIds` where needed. Window removal drops live IDs but retains saved snapshots.
- Transition intent is persisted before preparing replacement windows. Initial `recovery.html` marker URLs identify operation and window slot through the creation/ID-checkpoint gap. Target ownership and committed journal phase persist together before source cleanup.
- Recovery rolls back preparation or finishes committed cleanup. Cross-session recovery must not use old numeric IDs to close current windows. Browser API side effects and storage writes are not one atomic transaction; do not claim universal crash safety.

### Snapshots and restoration

- `saveAllWorkspaceWindows()` captures eligible open windows, excluding transition-excluded windows and windows owned only by inactive workspaces. Active ownership wins over overlapping legacy IDs. Zero eligible windows clears live IDs while preserving recoverable snapshots and pins.
- Tab create/update/remove/move/attach/detach and bounds events coalesce saves over 500 ms. Window-closing tab events preserve recovery data. No asynchronous final-save `onSuspend` handler is registered.
- `createWorkspace()` snapshots outgoing state first. Including current tabs adopts multiple live windows; fresh creation prepares replacement before closing source windows.
- Switching snapshots outgoing workspace, journals preparation, restores pinned tabs before unpinned tabs, commits target, and closes sources. Normal bounds apply at creation; non-normal state applies afterward. Guard ownership releases in `finally`, not after a fixed settling delay.
- Startup restores a valid protected target without overwriting it with early browser-session events. No valid target leaves browser session intact.
- Periodic cleanup runs every 30 seconds while background is alive, inside state queue. It closes inactive-owned windows, keeps active/untracked windows, and does not cancel pending snapshots. Timer is not durable scheduling across worker termination.

### Shared pins and backup

`settings.sharePinnedTabs` defaults false. Shared restore prepends global pins to each restored window. Collection uses exact URL and maximum per-window occurrence count, preserving intentional duplicates within a window without multiplying restored replicas. An empty live pin set clears shared pins; no live windows preserves recovery data.

Disabling sharing materializes pins into saved workspace windows, including inactive and empty-window snapshots. Enabling collects eligible live pins, then strips saved workspace pins. Known limitation: enabling with no eligible live windows currently does not extract saved pins before stripping them; add regression and fix before claiming that path is safe. Shared mode does not immediately synchronize live pin edits between windows.

Export snapshots active state and returns a `1.0.1` envelope containing workspace state, settings, and pins, not internal recovery/session metadata. It currently calls two full-snapshot wrappers. Import validates and normalizes before snapshot/storage/window effects, supports versionless or `1.0.1` data, resets imported live IDs, and restores backed-up active or most recently accessed workspace. Valid empty backups remain supported. Popup uses `Blob` download and `FileReader` upload.

## Code Style

Two-space indentation, semicolons, single-quoted strings, camelCase, and top-level function declarations. Use plain JavaScript, matching surrounding code. Background uses async/await; popup uses callback messaging. Node test/staging scripts use built-in modules; do not introduce dependencies or a build system without need.

## Validation and Pitfalls

Run full regression suite and syntax checks after edits. Use disposable browser profiles for functional checks: switching, import, fresh creation, and startup can close profile windows; import replaces workspace data. Never test destructive flows on normal user profile.

Exercise distinct multi-window URLs, pins, blank tabs, normal/maximized/fullscreen state, bounds, manual closure, worker stop/wake, full restart, storage/API rejection, rename/color/badge, settings toggles, and backup round trips. Inspect popup and background errors. Mocks cannot prove termination timing, physical display behavior, or Dia support.

- Abrupt termination inside 500 ms debounce can lose latest unsaved edit. Inactive-workspace deletion is not fully journaled.
- Firefox lacks `windows.onBoundsChanged`; optional registration keeps tabs working, but resize-only persistence is not immediate. `restorableUrl()` maps blank URLs to legal `about:blank` on Firefox.
- `isBlankTab()` filters browser blank-page prefixes; blank-only windows use fallback, blank tabs alongside real tabs are generally filtered.
- `README.md`, `SETUP.md`, and older Git/release instructions can be stale. Current source and development/publish separation take precedence.
- Packaging uses recursive exclusions, not runtime allowlist; tests, guidance, planning files, or local agent files can enter ZIP. Inspect archive before distribution. Firefox stager uses runtime allowlist and refuses nonempty destinations.

## Development Workflow

Create feature branches before modifications; never commit directly to main/master without explicit authorization. During feature/fix work, bump `manifest.json`, test, and iterate. Documentation-only changes need no version bump. Package, changelog, commit, push, and signing/store upload are separate actions requiring authorization; do not infer them from ordinary development requests.

Keep local agent configuration and planning files out of commits unless explicitly requested. Inspect status and stage exact paths, preserving user-owned changes. Archive deletion does not remove historical Git objects; old packages remain recoverable from history.

## GitNexus

Repository alias: **chrome-workspace-manager**. Index counts are volatile; use live tools rather than hardcoded statistics. Refresh with `node .gitnexus/run.cjs analyze --index-only --force` to avoid rewriting guidance; if runner absent, use available installed GitNexus CLI or ask before downloading tools.

- Before editing any function/class/method, run upstream `impact` and report callers, affected flows, and risk. Warn on HIGH/CRITICAL. A stale/missing symbol is not evidence of zero impact.
- Run `detect_changes()` before committing and inspect affected scope. Regression comparison uses `scope: 'compare', base_ref: 'main'`.
- Use `query` for unfamiliar execution flows and `context` for callers/callees. Rename with graph-aware `rename`, not blind replacement.
- PDG/security tooling requires corresponding index support; do not claim findings from unavailable analysis.
- Clean up inactive agent-created worktrees after their changes have been preserved/integrated and task ends; prune and verify list. Never remove active or user-created worktrees. Do not commit or push solely to permit cleanup.

Resources: `gitnexus://repo/chrome-workspace-manager/context`, `/clusters`, `/processes`, and `/process/{name}`. Local GitNexus skill files under `.claude/skills/gitnexus/` are optional local tooling, not runtime dependencies; verify presence before referencing them.

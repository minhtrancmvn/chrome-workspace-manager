# Background regression tests

Run from repository root:

```sh
node --test tests/background.test.cjs tests/browser-api.test.cjs tests/popup.test.cjs
```

Requires Node.js with built-in `node:test`. No package installation, bundler or production dependency.

Background tests execute actual background.js in isolated VM with mocked Chrome APIs. Fixtures control storage initialization, timers, delayed browser events, concurrent requests and rejected API/storage calls. Popup tests execute actual popup.js with minimal DOM and messaging mocks, covering dynamic values kept out of HTML markup, native switch button wiring, transport/background errors, and checkbox rollback. These mocks do not parse HTML or simulate native keyboard behavior; use a disposable browser to verify rendered DOM, focus, and Enter/Space activation. No real browser windows or user data touched by the unit suite.

Covered: readiness, tab persistence, multi-window debounce, source snapshots, replacement-first transitions, durable transition journaling and worker-restart rollback/finish, startup target checkpoints, legacy window ownership and import/export/delete compatibility. Export tests assert one full window scan and state write while preserving multi-window geometry, pins, inactive records, no-live recovery data, error handling, and the backup envelope.

Mocks do not prove Chrome MV3 termination timing, full browser restart, physical display placement or fullscreen behavior. Validate those in disposable Chrome profile before release. Switching/import/startup can close every window in that profile.

Tab persistence remains debounced by 500 ms; abrupt termination before that save can lose latest edit. Recovery stores transition intent and session identity before preparing windows, then records committed ownership before source cleanup. Marked replacement tabs allow recovery to identify creation that completed before its ID was persisted. Old-session numeric IDs are not used for recovery cleanup. Chrome for Testing 148 disposable-profile smoke verified worker death during preparation and full browser restart; these checks do not prove every termination timing or display configuration. Firefox 156 smoke verified creation, tab persistence, fresh-workspace preservation and switching. Dia functional behavior remains unverified; see BROWSER_SUPPORT.md.

Shared-pin aggregation across windows, duplicate URL multiplicity, empty-list clearing, and disabling-mode preservation (including inactive workspace snapshots) are covered by regression tests. Inactive-workspace deletion tests cover journaled commit-before-close, worker death before/after window removal and storage response, API/storage rejection, replayable journal clearing, overlapping ownership, delayed closing events, and cross-session ID reuse. Chrome for Testing 148 disposable smoke also verified stopping the worker after partial deletion cleanup and waking it to finish without closing other windows. Cleanup can remain pending after errors until the next recovery/state operation. Backup imports are structurally validated and normalized before API or storage side effects; schema policy supports versionless and 1.0.1 exports only. Browser API side effects and storage writes are not one atomic transaction; recovery guarantees are limited to the journaled paths and tested checkpoints.

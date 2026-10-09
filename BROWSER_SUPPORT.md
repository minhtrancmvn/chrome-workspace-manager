# Browser support

Workspace Manager keeps the repository-root `manifest.json` for Chrome and Chromium-based browsers, including Dia. Firefox uses a generated staging directory because Firefox Manifest V3 requires `background.scripts`, while Chrome requires `background.service_worker`.

## Firefox

Requires Firefox 115 or newer. Build an unpacked runtime directory outside this repository:

```sh
node scripts/prepare-browser.cjs firefox /tmp/workspace-manager-firefox
```

In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `manifest.json` inside the staging directory. The script copies only extension runtime files and icons; it does not create an archive, modify the root manifest, sign, or upload an add-on. Temporary add-ons are removed when Firefox closes.

`browser-api.js` adapts Firefox's Promise-based `browser.*` APIs to the existing runtime's `chrome.*` Promise and callback patterns. It loads before the background and popup scripts in the staged build. Chrome loads the same shim before background and popup logic; it leaves Chrome's native API objects unchanged. The staging manifest removes Chrome's `minimum_chrome_version` floor and sets Gecko's minimum to 115.0.

The ID `workspace-manager@local` is for local temporary testing only. Choose and retain an appropriate stable Gecko add-on ID before distribution.

## Dia

Dia uses the repository-root manifest and its Chromium-compatible unpacked-extension flow. To try it, open Dia's extension management page, enable developer mode if available, choose **Load unpacked**, and select this repository.

A disposable-profile check of Dia 1.51.1 (build 88214, Chromium 154.0.8037.98) loaded extension 2.3.17 and rendered its popup. Direct background-function checks exercised workspace creation/adoption, explicit snapshots, switching, metadata updates, shared-pin duplicate collection, and pin materialization when disabling sharing. These calls bypassed production message dispatch; they do not establish popup-control or debounce-only persistence coverage. A separate follow-up sent `createWorkspace` with `includeCurrentTabs: true` through `chrome.runtime.sendMessage` from the rendered popup and received `success: true` plus a workspace ID without `lastError`. It did not assert adoption of existing windows/tabs or test popup button interaction. The earlier `ERR_FILE_NOT_FOUND` launch is no longer the only available evidence.

In extension 2.3.17, backup compatibility failed: exported data did not pass `normalizeBackupData`, and a diagnostic import with start-page URLs replaced still returned `Invalid backup data`. Observed snapshots contained `chrome://start-page/<uuid>` URLs and normal-window geometry with zero width/height. Both independently fail current validation; normalizing both in a saved diagnostic fixture passed validation, not a browser round trip. Production messaging beyond that creation probe, live-tab restoration assertions, two-window backup round trips, worker recovery, restart restoration, and physical window behavior remain unverified. Do not treat this partial check as complete Dia support.

Extension 2.3.18 treats `chrome://start-page/` tabs as blanks and saves normal-window geometry only when all bounds are finite and dimensions are positive. Invalid geometry is omitted, retaining `{ state: 'normal' }` so restoration uses browser defaults. Valid bounds, including negative screen positions, remain unchanged. This fixes new snapshot generation without weakening import validation or migrating old inactive snapshots; backups containing old start-page URLs or zero dimensions still reject. Version 2.3.18 loaded successfully in two new disposable Dia launches, but both attempts blocked during fixture setup: newly created HTTP/data tabs reported empty URL strings, with URL-readiness polling timing out in the second attempt. No production workspace messages ran, so a real backup round trip remains unverified; this fixture blocker is not evidence of an application regression. A separate CDP UI-driven follow-up observed two distinct native window IDs but selected an unrelated extension worker before popup setup; that harness error prevented any Workspace Manager export/import checks. Neither attempt establishes complete Dia compatibility.

## Known compatibility limits

- Saved blank-tab records remain compatible with existing Chrome backups. Firefox restoration converts blank URLs to `about:blank`; Firefox 156.0.1 previously rejected `tabs.create({url: 'about:newtab'})` with `Illegal URL`, so that internal URL is not used for API-created tabs.
- Firefox does not support `windows.onBoundsChanged` (MDN Browser Compat Data lists `version_added: false`, bug 1762975). Registration is optional, so tab persistence still works. Geometry is captured on explicit snapshot/switch/export or tab events; resize-only persistence is not immediate in Firefox. Physical display placement and maximized/fullscreen behavior still need target-version validation.
- Source: [MDN Browser Compat Data for `windows`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/windows.json).
- Extension 2.3.17 was tested on Firefox 157.0 in fresh temporary profiles: add-on loading, popup creation, tab-only persistence, fresh-workspace outgoing preservation, switching, two-window export/import, deliberate duplicate shared pins, repeated enable without duplicate growth, and clearing all live shared pins passed. The staged build contains the same ten runtime paths as Chromium packaging; nine files are byte-identical, with Firefox-specific manifest adaptations.
- Firefox 157.0.1 headless follow-up verified idle event-page stop/wake through Firefox's internal lifecycle hook and a `getWorkspaces` message. A full shutdown/relaunch of the same disposable profile retained the active workspace ID and name after explicitly reloading the temporary add-on, without recreating workspace state. These checks do not prove interrupted-transition journal recovery, automatic `runtime.onStartup` window restoration, or persistent installed-add-on startup. A separate interrupted-transition attempt timed out before recovery assertions, so it supplies no pass evidence. Temporary add-ons disappear when Firefox closes. Physical display placement and maximized/fullscreen behavior remain release checks.
- No Firefox signing, AMO submission, browser store publication, or release archive operation is performed by this workflow.

## Validation

Run adapter and staging tests:

```sh
node --test tests/browser-api.test.cjs
```

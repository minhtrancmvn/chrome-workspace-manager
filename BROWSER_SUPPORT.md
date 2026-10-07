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

Dia is Chromium-based and is expected to use the repository-root manifest and its Chromium-compatible unpacked-extension flow. To try it, open Dia's extension management page, enable developer mode if available, choose **Load unpacked**, and select this repository. Functional compatibility is unverified: a fresh-profile headless startup did not expose `DevToolsActivePort`, so no extension smoke test completed. Do not describe Dia support as tested until a manual check succeeds in the target Dia version.

## Known compatibility limits

- Saved blank-tab records remain compatible with existing Chrome backups. Firefox restoration converts blank URLs to `about:blank`; Firefox 156.0.1 previously rejected `tabs.create({url: 'about:newtab'})` with `Illegal URL`, so that internal URL is not used for API-created tabs.
- Firefox does not support `windows.onBoundsChanged` (MDN Browser Compat Data lists `version_added: false`, bug 1762975). Registration is optional, so tab persistence still works. Geometry is captured on explicit snapshot/switch/export or tab events; resize-only persistence is not immediate in Firefox. Physical display placement and maximized/fullscreen behavior still need target-version validation.
- Source: [MDN Browser Compat Data for `windows`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/windows.json).
- Extension 2.3.17 was tested on Firefox 157.0 in fresh temporary profiles: add-on loading, popup creation, tab-only persistence, fresh-workspace outgoing preservation, switching, two-window export/import, deliberate duplicate shared pins, repeated enable without duplicate growth, and clearing all live shared pins passed. The staged build contains the same ten runtime paths as Chromium packaging; nine files are byte-identical, with Firefox-specific manifest adaptations. Physical display placement, maximized/fullscreen behavior, full browser restart, and event-page termination recovery remain release checks; do not infer them from this smoke test.
- No Firefox signing, AMO submission, browser store publication, or release archive operation is performed by this workflow.

## Validation

Run adapter and staging tests:

```sh
node --test tests/browser-api.test.cjs
```

# Distribution Guide

Use versioned, validated runtime assets from [GitHub Releases](https://github.com/minhtrancmvn/chrome-workspace-manager/releases). Do not recursively ZIP the repository: it contains tests, local guidance, development files, and historical content that do not belong in an extension package.

## GitHub release assets

Each reviewed release contains:

- `workspace-manager-vMAJOR.MINOR.PATCH-chromium.zip`
- `workspace-manager-vMAJOR.MINOR.PATCH-firefox-unsigned.zip`
- `SHA256SUMS`

These are install/test packages; GitHub's automatic source archives are not equivalent. [RELEASE_WORKFLOW.md](RELEASE_WORKFLOW.md) defines build validation, tag/manifest matching, checksums, draft review, and explicit publication. Current browser validation limits are in [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md).

## Chromium unpacked installation

1. Download the Chromium ZIP and checksum file from the same published release. Verify the archive's SHA-256 against its entry before extraction.
2. Extract into a new directory you intend to keep; Chrome needs that directory while the extension is loaded.
3. Open `chrome://extensions/`, enable Developer mode, choose **Load unpacked**, and select the directory containing `manifest.json`.
4. Pin the extension if desired and test using a disposable browser profile before trusting important workspaces.

Unpacked installs do not automatically update. Back up workspace data before an update, retain the old installation files, inspect and verify the new package, then reload the extension through the browser's management page. Workspace import can replace stored data and close windows; do not use a normal profile for destructive testing.

Dia uses Chromium-compatible packaging but complete Dia support remains unverified. A successfully generated ZIP is not a compatibility guarantee.

## Firefox temporary testing

The unsigned Firefox ZIP contains the adapted manifest, not an AMO-signed XPI. Extract into a fresh directory and load `manifest.json` through `about:debugging#/runtime/this-firefox`. Temporary add-ons disappear when Firefox closes. Permanent installation and public Firefox distribution require a separate signing/AMO process.

## Browser stores and enterprise deployment

- **Chrome Web Store:** use the validated Chromium asset as the packaging starting point, then follow current developer-dashboard policies and submission requirements. Account enrollment, listing preparation, review, and upload are separate actions.
- **Firefox AMO:** follow signing and listing requirements; do not advertise the unsigned testing ZIP as permanently installable.
- **Managed deployment:** coordinate with the organization's browser administrator and approved enterprise policies. A GitHub Release alone does not configure enterprise installation.

No workflow in this repository uploads to a browser store, signs an add-on, or configures enterprise policy.

## Local packaging

For explicitly requested local asset preparation:

```bash
node scripts/build-release.cjs --tag "v$(node -p "require('./manifest.json').version")"
(cd dist && shasum -a 256 -c SHA256SUMS)
```

Use an absent or empty `dist/` directory. This creates local assets only; it does not publish a GitHub Release or prove browser behavior. `./package-extension.sh` remains a legacy Chromium-only local tool; prefer the canonical builder and [release workflow](RELEASE_WORKFLOW.md).

# Workspace Manager Releases

Download published extension assets from [GitHub Releases](https://github.com/minhtrancmvn/chrome-workspace-manager/releases). This folder retains historical notes and installation media, not tracked build archives. Source version is not a claim that a corresponding GitHub release has been published.

## Retained files

- [CHANGELOG.md](CHANGELOG.md): historical development/release notes.
- `install-guide.gif`: Chromium unpacked-installation guide.
- This README: release-folder policy.

Historical ZIPs for versions 2.3.0–2.3.7 were removed from the current tree; they remain recoverable from Git history. No history rewriting or automatic GitHub migration was performed. Future packages are generated into ignored `dist/` and attached to reviewed GitHub Releases.

## Installing a published asset

![Installation Guide](install-guide.gif)

1. Download the versioned Chromium ZIP and `SHA256SUMS` from the same GitHub release. Verify the downloaded archive's SHA-256 against its entry; verify the full checksum file when both assets are downloaded.
2. Extract into a fresh directory.
3. Open Chrome's extension management page, enable Developer mode, choose **Load unpacked**, and select that directory.

Firefox uses the separate `firefox-unsigned.zip` asset for temporary testing. It is not signed for permanent installation; see [browser support](../BROWSER_SUPPORT.md). Chromium-compatible packaging does not establish complete Dia support.

## Creating a release

Follow [RELEASE_WORKFLOW.md](../RELEASE_WORKFLOW.md): validate source, build version-matched assets, tag the reviewed commit, retrieve the successful GitHub Actions artifacts, and explicitly create a draft release. Publication and browser-store uploads remain separate actions. Never commit generated ZIPs.

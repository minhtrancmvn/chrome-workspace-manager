# Release Workflow

GitHub Releases is the distribution channel for versioned binaries. Git tracks source, this guide, and historical release notes; generated ZIPs belong in ignored `dist/`, not commits. A GitHub Actions artifact is a temporary build result, not a published release.

## Release contract

- `manifest.json` uses `MAJOR.MINOR.PATCH`; the release tag is exactly `vMAJOR.MINOR.PATCH`, without leading zeros or prerelease suffixes.
- Major versions cover breaking changes, minor versions add compatible features, patch versions fix bugs.
- Tags point to reviewed, committed source. Never move or reuse a published release tag.
- Tag builds run syntax checks and all `tests/*.test.cjs`, build Chromium and unsigned Firefox assets, verify ZIP contents, and produce SHA-256 checksums.
- Workflows have `contents: read`, immutable action SHA pins, job timeouts, and no publication token. Creating a tag builds assets; it does not create or publish a GitHub Release.
- Creation of a draft release, publication, Firefox signing, and browser-store submission are separate approvals/actions.

## 1. Prepare and validate source

Work on a feature branch. Update `manifest.json` and document user-facing changes and known limits. Preserve unrelated local changes; stage only intended paths when a commit is authorized.

```bash
node --test tests/*.test.cjs
node --check background.js
node --check popup.js
node --check browser-api.js
node --check scripts/build-release.cjs
bash -n package-extension.sh
git diff --check
```

Run disposable-profile browser smoke checks for the browser support you intend to claim: distinct multi-window URLs, pins, switching, settings, and unmodified backup export/import. Import and switching can replace data and close windows; never use a normal browser profile. Mock tests and successful packaging do not prove browser compatibility. Review [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md); Dia backup round trips remain unverified in current validation evidence.

## 2. Build locally without publishing

Requires Node.js 24, Bash, `zip`, and `unzip`. No npm installation or compilation is required.

```bash
VERSION=$(node -p "require('./manifest.json').version")
TAG="v$VERSION"
node scripts/build-release.cjs --tag "$TAG"
```

Default output is `dist/`. An explicit destination must be an absolute path to an absent or empty real directory outside the source tree (or the exact default `dist/`). Symlinked paths and nonempty destinations are rejected; choose a fresh physical path when rebuilding. The builder stages outside the repository, reuses the Chromium packager and Firefox manifest adapter, validates exact runtime contents and bytes, and writes final assets only after validation.

```text
dist/
├── workspace-manager-vMAJOR.MINOR.PATCH-chromium.zip
├── workspace-manager-vMAJOR.MINOR.PATCH-firefox-unsigned.zip
└── SHA256SUMS
```

Verify checksums and archive entries before testing or sharing:

```bash
(cd dist && shasum -a 256 -c SHA256SUMS)
unzip -Z1 "dist/workspace-manager-$TAG-chromium.zip"
unzip -Z1 "dist/workspace-manager-$TAG-firefox-unsigned.zip"
```

On Linux, `sha256sum --check SHA256SUMS` is equivalent. Checksums detect changed bytes, not signer identity or browser-store approval. Extract each untrusted download into its own fresh directory; do not execute scripts from an archive.

## 3. Commit, merge, and tag only after approval

The `CI` workflow runs on branch pushes and pull requests. Configure the `Tests` job as a required branch-protection check on `main` if desired; repository settings are not changed by these files. Merge reviewed source before creating its release tag. Commit and push are explicit actions, not side effects of packaging.

Once the intended commit is on `main`, work from a clean checkout:

```bash
git switch main
git pull --ff-only
test -z "$(git status --porcelain)" || { printf 'Release checkout must be clean\n' >&2; exit 1; }
VERSION=$(node -p "require('./manifest.json').version")
TAG="v$VERSION"
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"
```

The commands above create and push a release tag; run them only when authorized. Existing tags cause tagging to fail rather than silently moving history. The `Release assets` workflow checks that tag against the manifest on that exact commit and packages it. A malformed or mismatched tag fails before release assets are built.

## 4. Retrieve the successful tag build

Use GitHub CLI from this repository. Select the successful run for the exact tag and verify its commit before downloading. Do not attach a fresh build from an unrelated dirty checkout.

```bash
gh run list --workflow release.yml --branch "$TAG" --limit 5
RUN_ID=123456789 # Replace with the successful run ID; never copy this placeholder unchanged.
gh run view "$RUN_ID" --json conclusion,event,headBranch,headSha
```

Require `conclusion: success`, `event: push`, `headBranch` equal to `$TAG`, and `headSha` equal to `git rev-parse "$TAG^{commit}"`. Download into a new empty directory:

```bash
DOWNLOAD_DIR=$(mktemp -d)
gh run download "$RUN_ID" --name "workspace-manager-$TAG" --dir "$DOWNLOAD_DIR"
(cd "$DOWNLOAD_DIR" && shasum -a 256 -c SHA256SUMS)
```

Build assets are retained for 30 days; test reports for 14 days. Create the reviewed release before assets expire or rerun the same immutable tag build. Retain evidence of which run/commit supplied the assets. GitHub's automatic source-code archives are source snapshots, not installable extension packages.

## 5. Create an unpublished GitHub draft

After checksums, runtime contents, browser smoke results, and source commit are reviewed, explicitly create the draft:

```bash
gh release create "$TAG" \
  "$DOWNLOAD_DIR/workspace-manager-$TAG-chromium.zip" \
  "$DOWNLOAD_DIR/workspace-manager-$TAG-firefox-unsigned.zip" \
  "$DOWNLOAD_DIR/SHA256SUMS" \
  --verify-tag --draft --generate-notes --title "Workspace Manager $TAG"
```

`--verify-tag` requires the tag to exist remotely; it prevents the CLI from inventing a tag from the default branch. `--draft` keeps the release unpublished. `.github/release.yml` groups generated notes by pull-request labels (features, fixes, documentation, maintenance, and a catch-all). Generated notes are a starting point: add user-visible changes, installation instructions, support limits, and any migration warnings before publication.

Inspect the draft and its three assets:

```bash
gh release view "$TAG" --json tagName,isDraft,body,assets
```

If a release already exists, stop and inspect it. Do not overwrite published assets or delete releases/tags to bypass errors. Publishing the reviewed draft requires separate authorization:

```bash
gh release edit "$TAG" --draft=false
```

## Runtime assets and installation

Both ZIPs contain exactly these runtime paths; Firefox's manifest differs:

```text
manifest.json
background.js
browser-api.js
popup.html
popup.js
popup.css
recovery.html
icons/icon16.png
icons/icon48.png
icons/icon128.png
```

Tests, scripts, local settings, plans, documentation, extra icons, and old packages stay out. Update allowlists and regression tests together if runtime references change.

- **Chromium ZIP:** extract into a new directory, enable developer mode in the extension management page, and load unpacked. Chrome requires version 102+. Chromium-compatible packaging does not establish full Dia support.
- **Firefox unsigned ZIP:** contains the adapted background-script manifest and Firefox 115+ minimum. It is not an AMO-signed XPI and does not imply normal permanent installation. For temporary testing, extract it and load its manifest through `about:debugging#/runtime/this-firefox`; it disappears when Firefox closes. Signing/AMO submission is separate.
- **Browser stores:** do not automatically upload these assets. Follow the target store's requirements and approval process.

## Repository release folder

```text
releases/
├── README.md
├── CHANGELOG.md      # Historical notes; not proof a GitHub release was published
└── install-guide.gif
```

Historical `2.3.0`–`2.3.7` ZIPs were removed from the current tree, not erased from history or migrated into GitHub Releases. Restore an individual archive into a separate directory when needed, for example:

```bash
git show '41cd693:releases/workspace-manager-v2.3.7.zip' > /absolute/fresh-directory/workspace-manager-v2.3.7.zip
```

Old packages contain obsolete runtime and development files; they are not current release candidates. The unchanged `./package-extension.sh` remains a legacy Chromium-only local packaging tool with an optional changelog prompt. It writes ignored ZIPs under `releases/`; use `scripts/build-release.cjs` for the canonical GitHub release assets.

## Troubleshooting

- **Tag/version mismatch:** correct the source version before committing/tagging; do not bypass validation or move a published tag.
- **Nonempty output or symlink path:** use a new physical output directory. Preserve old artifacts rather than overwriting them.
- **ZIP/content validation failure:** fix missing runtime files or allowlists and rerun tests before packaging again.
- **Missing Actions artifact:** check the exact tag run and retention period. Workflow files must be pushed before GitHub can run them; local tests do not prove remote execution.
- **Missing generated notes:** merged pull requests supply useful note entries; edit the draft when changes lack PR metadata.

## References

- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Automatically generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
- [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create)

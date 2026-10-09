# Git Workflow

Repository: [minhtrancmvn/chrome-workspace-manager](https://github.com/minhtrancmvn/chrome-workspace-manager). `main` is the integration branch; development belongs on feature branches.

## Development

Inspect local changes before switching or updating branches. Do not overwrite unrelated work.

```bash
git status --short --branch
git switch -c fix/short-description
# Edit source and bump manifest.json when runtime changes.
node --test tests/*.test.cjs
git diff --check
```

When committing is authorized, stage exact intended paths and inspect them:

```bash
git add background.js manifest.json tests/background.test.cjs
git diff --cached
git commit -m "fix: describe behavior and reason"
```

Use conventional prefixes such as `fix:`, `feat:`, `docs:`, `refactor:`, `test:`, and `chore:`. Keep local plans, settings, test profiles and generated artifacts out of commits. Push a feature branch and open a pull request when authorized; do not commit directly to or force-push `main`.

```bash
git push -u origin fix/short-description
```

CI runs syntax checks and the dependency-free test suite. Configure the `Tests` job as a required check through repository settings if desired. Review and merge the pull request before preparing its release tag.

## Releases

Follow [RELEASE_WORKFLOW.md](RELEASE_WORKFLOW.md) for the canonical sequence: validate source, build local assets if needed, merge reviewed source, create an immutable annotated tag matching the manifest, download the successful tag build, verify assets, and explicitly create a draft GitHub Release. Publication is separate.

Do not commit ZIPs. `.gitignore` excludes `*.zip` and `dist/`. Historical ZIPs removed from the current `releases/` tree remain available in Git history. That folder retains notes and installation media only.

Packaging, committing, pushing a tag, creating a draft, publishing, and browser-store submission are distinct actions requiring authorization. A normal development commit does not imply any of them.

## Useful read-only checks

```bash
git status --short --branch
git diff
git diff --cached
git log --oneline --graph --all
git remote -v
git tag --list
gh release list
```

For a rejected push, inspect remote history before choosing merge or rebase. Do not use force-pushes or reset/discard commands as generic fixes. Preserve user-owned work and ask before rewriting shared history.

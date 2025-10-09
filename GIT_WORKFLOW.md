# Git Workflow Guide

This document explains how to use Git for the Chrome Workspace Manager project.

## Repository Setup

✅ **Repository**: `git@github.com:minhtrancmvn/chrome-workspace-manager.git`
✅ **Branch**: `main`
✅ **Remote**: `origin`

## Daily Workflow

### 1. Check Status

Before starting work:
```bash
git status
```

### 2. Pull Latest Changes

Always pull before making changes:
```bash
git pull origin main
```

### 3. Make Changes

Edit files, test your changes, package new version:
```bash
# Make your edits...
./package-extension.sh
```

### 4. Stage Changes

Add specific files:
```bash
git add background.js popup.js manifest.json
```

Or add everything:
```bash
git add .
```

### 5. Commit Changes

Write clear commit messages:
```bash
git commit -m "Fix: Description of what you fixed"
# or
git commit -m "Feature: Description of new feature"
# or
git commit -m "Release: v2.3.1 - Brief summary"
```

### 6. Push to GitHub

```bash
git push origin main
```

## Release Workflow

When releasing a new version:

1. **Update version** in `manifest.json`
2. **Package extension**: `./package-extension.sh`
3. **Update CHANGELOG**: Add entry to `releases/CHANGELOG.md`
4. **Commit all changes**:
   ```bash
   git add .
   git commit -m "Release: v2.4.0 - Feature summary"
   ```
5. **Tag the release**:
   ```bash
   git tag -a v2.4.0 -m "Version 2.4.0"
   ```
6. **Push with tags**:
   ```bash
   git push origin main --tags
   ```

## Commit Message Guidelines

Use prefixes for clarity:

- `Fix:` - Bug fixes
- `Feature:` - New features
- `Improve:` - Improvements to existing features
- `Docs:` - Documentation updates
- `Style:` - CSS/UI changes
- `Refactor:` - Code refactoring
- `Release:` - Version releases

### Examples

```bash
git commit -m "Fix: Workspace data corruption during switching"
git commit -m "Feature: Add workspace rename capability"
git commit -m "Improve: Better error handling for rename operations"
git commit -m "Docs: Update README with installation steps"
git commit -m "Release: v2.3.0 - Blank tab filtering"
```

## Useful Commands

### View Commit History

```bash
git log --oneline --graph --all
```

### View Changes

```bash
# Unstaged changes
git diff

# Staged changes
git diff --cached

# Changes in specific file
git diff background.js
```

### Undo Changes

```bash
# Discard unstaged changes in file
git checkout -- background.js

# Unstage file (keep changes)
git reset HEAD background.js

# Undo last commit (keep changes)
git reset --soft HEAD~1
```

### Check Remote

```bash
git remote -v
```

### Branch Management

```bash
# List branches
git branch

# Create new branch
git checkout -b feature/new-feature

# Switch branches
git checkout main

# Delete branch
git branch -d feature/old-feature
```

## .gitignore

The following files/folders are ignored:

- `.DS_Store` - macOS system files
- `.vscode/` - VS Code settings
- `*.backup` - Backup files
- `*.log` - Log files
- `node_modules/` - Dependencies (if any)

Note: Release zips in `releases/` folder are **included** in version control.

## Tips

1. **Commit often**: Small, focused commits are easier to review
2. **Pull before push**: Always pull latest changes before pushing
3. **Test before commit**: Make sure extension works before committing
4. **Write clear messages**: Future you will thank present you
5. **Tag releases**: Makes it easy to checkout specific versions

## Troubleshooting

### Push Rejected

```bash
git pull origin main --rebase
git push origin main
```

### Wrong Commit Message

```bash
git commit --amend -m "New message"
git push --force origin main  # Use with caution!
```

### Merge Conflicts

```bash
git pull origin main
# Fix conflicts in files
git add .
git commit -m "Merge: Resolved conflicts"
git push origin main
```

## GitHub Integration

Your repository is now available at:
**https://github.com/minhtrancmvn/chrome-workspace-manager**

### Creating a Release on GitHub

1. Go to repository on GitHub
2. Click "Releases" → "Create a new release"
3. Choose tag (e.g., `v2.3.0`)
4. Set title (e.g., "Version 2.3.0 - Blank Tab Filtering")
5. Add description from `releases/CHANGELOG.md`
6. Attach `releases/workspace-manager-v2.3.0.zip`
7. Publish release

## Quick Reference

```bash
# Daily workflow
git pull origin main
# ... make changes ...
git add .
git commit -m "Fix: Description"
git push origin main

# Release workflow
# ... update version ...
./package-extension.sh
git add .
git commit -m "Release: vX.Y.Z - Summary"
git tag -a vX.Y.Z -m "Version X.Y.Z"
git push origin main --tags
```

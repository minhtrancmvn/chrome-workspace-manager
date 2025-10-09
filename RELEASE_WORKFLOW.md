# Release Workflow Guide

This guide explains how to create and manage releases for the Workspace Manager extension.

## Quick Start

To create a new release:

```bash
./package-extension.sh
```

## Release Process

### 1. Update Version Number

Edit `manifest.json` and bump the version:

```json
{
  "version": "X.Y.Z"
}
```

**Version Guidelines:**
- **Major (X.0.0)**: Breaking changes or major architectural changes
- **Minor (X.Y.0)**: New features, non-breaking changes
- **Patch (X.Y.Z)**: Bug fixes and minor improvements

### 2. Run Packaging Script

```bash
./package-extension.sh
```

The script will:
1. Create `releases/` folder if it doesn't exist
2. Read version from `manifest.json`
3. Create `releases/workspace-manager-vX.Y.Z.zip`
4. Prompt for changelog entry (optional)

### 3. Add Changelog Entry

When prompted, enter your changelog in this format:

```
### New Features
- Feature description

### Bug Fixes
- Bug fix description

### Improvements
- Improvement description
```

Press `Ctrl+D` when done.

The script will automatically:
- Add version number and date
- Prepend entry to `releases/CHANGELOG.md`
- Format with proper markdown

### 4. Verify Release

Check that the files were created:

```bash
ls -lh releases/
```

You should see:
- `workspace-manager-vX.Y.Z.zip` (new release)
- `CHANGELOG.md` (updated if you added an entry)

## File Structure

```
releases/
├── CHANGELOG.md                    # Complete version history
├── README.md                       # Release folder documentation
├── workspace-manager-v1.1.1.zip   # Previous releases
├── workspace-manager-v2.0.2.zip
├── workspace-manager-v2.0.3.zip
└── workspace-manager-v2.1.0.zip   # Latest release
```

## Distribution

### Share with Colleagues

1. Share the `.zip` file from `releases/` folder
2. Recipients follow instructions in `INSTALL.md`

### Chrome Web Store

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
2. Upload the `.zip` file
3. Fill in store listing details
4. Submit for review

See `DISTRIBUTION.md` for detailed instructions.

## Manual Changelog Update

If you skipped the changelog prompt, you can manually edit `releases/CHANGELOG.md`:

```markdown
## Version X.Y.Z - YYYY-MM-DD

### New Features
- Feature description

### Bug Fixes
- Bug fix description

---
```

Add your entry after the file header and before previous versions.

## Excluded Files

The packaging script automatically excludes:
- `.git/` and `.github/` folders
- `.DS_Store` files
- Development scripts (`*.sh`)
- Documentation files (`DISTRIBUTION.md`, `SETUP.md`)
- Previous releases (`releases/` folder)

## Tips

1. **Always update manifest.json first** before running the script
2. **Use semantic versioning** (MAJOR.MINOR.PATCH)
3. **Write clear changelog entries** that explain user-facing changes
4. **Test the extension** before creating a release
5. **Keep old releases** for rollback capability

## Troubleshooting

### Script won't run
```bash
chmod +x package-extension.sh
```

### Wrong version in zip filename
- Make sure you updated `manifest.json` first
- The script reads version from there

### Changelog formatting issues
- Use markdown formatting (##, ###, -, *)
- Keep entries concise and user-focused
- Separate sections with blank lines

## Example Workflow

```bash
# 1. Edit code and test changes
# 2. Update version
vim manifest.json  # Change to 2.2.0

# 3. Create release
./package-extension.sh

# 4. When prompted, enter:
### New Features
- Added dark mode support
- Added keyboard navigation

### Bug Fixes
- Fixed memory leak in background script

# Press Ctrl+D

# 5. Verify
ls -l releases/workspace-manager-v2.2.0.zip
cat releases/CHANGELOG.md

# 6. Test installation
# Load the new zip in Chrome extensions

# 7. Distribute
# Share or upload to Chrome Web Store
```

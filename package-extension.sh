#!/bin/bash

# Package Workspace Manager Extension
# Include only runtime files; preserve previous package if validation or ZIP fails.
set -euo pipefail

cd "$(dirname "$0")"

RUNTIME_FILES=(
  manifest.json background.js browser-api.js popup.html popup.js popup.css
  recovery.html icons/icon16.png icons/icon48.png icons/icon128.png
)

echo "📦 Packaging Workspace Manager Extension..."
echo ""

for FILE in "${RUNTIME_FILES[@]}"; do
  if [ ! -f "$FILE" ] || [ -L "$FILE" ]; then
    printf 'Required runtime file missing or symlinked: %s\n' "$FILE" >&2
    exit 1
  fi
done
if [ -L icons ] || [ -L releases ]; then
  printf 'Runtime/output directories must not be symlinks.\n' >&2
  exit 1
fi

VERSION=$(node -e '
  const fs = require("node:fs");
  const version = JSON.parse(fs.readFileSync("manifest.json", "utf8")).version;
  if (typeof version !== "string" || !/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error("Invalid manifest version");
  }
  process.stdout.write(version);
')

mkdir -p releases
OUTPUT="releases/workspace-manager-v${VERSION}.zip"
if [ -L "$OUTPUT" ] || { [ -e "$OUTPUT" ] && [ ! -f "$OUTPUT" ]; }; then
  printf 'Release output must be a regular file: %s\n' "$OUTPUT" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d releases/.package-XXXXXXXX)
trap 'rm -rf "$TEMP_DIR"' EXIT
zip -q "$TEMP_DIR/package.zip" "${RUNTIME_FILES[@]}"
mv -f "$TEMP_DIR/package.zip" "$OUTPUT"

echo ""
echo "✅ Extension packaged successfully!"
echo "📦 File: $OUTPUT"
echo "📊 Version: $VERSION"
echo ""

# Prompt for changelog entry
echo "📝 Would you like to add a changelog entry for this release? (y/n)"
ADD_CHANGELOG='n'
read -r ADD_CHANGELOG || ADD_CHANGELOG='n'

if [ "$ADD_CHANGELOG" = "y" ] || [ "$ADD_CHANGELOG" = "Y" ]; then
  echo ""
  echo "Enter changelog description (press Ctrl+D when done):"
  echo "Format: Brief description of changes"
  echo ""
  
  # Read multiline input
  CHANGELOG_ENTRY=$(cat)
  
  # Add entry to CHANGELOG.md
  CHANGELOG_FILE="releases/CHANGELOG.md"
  
  # Create header if file doesn't exist
  if [ ! -f "$CHANGELOG_FILE" ]; then
    echo "# Workspace Manager - Release Changelog" > "$CHANGELOG_FILE"
    echo "" >> "$CHANGELOG_FILE"
  fi
  
  # Get current date
  CURRENT_DATE=$(date +"%Y-%m-%d")
  
  # Prepend new entry (insert after header)
  {
    echo ""
    echo "## Version $VERSION - $CURRENT_DATE"
    echo ""
    echo "$CHANGELOG_ENTRY"
    echo ""
    echo "---"
  } | cat - "$CHANGELOG_FILE" | tail -n +2 > "$CHANGELOG_FILE.tmp"
  
  # Add header back
  echo "# Workspace Manager - Release Changelog" > "$CHANGELOG_FILE"
  echo "" >> "$CHANGELOG_FILE"
  cat "$CHANGELOG_FILE.tmp" >> "$CHANGELOG_FILE"
  rm "$CHANGELOG_FILE.tmp"
  
  echo ""
  echo "✅ Changelog updated!"
  echo "📄 File: $CHANGELOG_FILE"
fi

echo ""
echo "🚀 Next steps:"
echo "1. Share $OUTPUT with your colleagues"
echo "2. Or upload to Chrome Web Store"
echo "3. See DISTRIBUTION.md for detailed instructions"
echo ""

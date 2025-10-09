#!/bin/bash

# Package Workspace Manager Extension
# This creates a clean ZIP file ready for distribution

echo "📦 Packaging Workspace Manager Extension..."
echo ""

# Get version from manifest
VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": "\(.*\)".*/\1/')

# Create releases directory if it doesn't exist
if [ ! -d "releases" ]; then
  mkdir releases
  echo "📁 Created releases directory"
fi

OUTPUT="releases/workspace-manager-v${VERSION}.zip"

# Remove old package if exists
if [ -f "$OUTPUT" ]; then
  rm "$OUTPUT"
  echo "🗑️  Removed old package"
fi

# Create zip excluding development files and releases folder
zip -r "$OUTPUT" . \
  -x "*.git*" \
  -x "*.DS_Store" \
  -x "*package-extension.sh" \
  -x "*DISTRIBUTION.md" \
  -x "*SETUP.md" \
  -x "*.md.backup*" \
  -x "*convert-icons.sh" \
  -x "*releases/*" \
  -x "*.github/*"

echo ""
echo "✅ Extension packaged successfully!"
echo "📦 File: $OUTPUT"
echo "📊 Version: $VERSION"
echo ""

# Prompt for changelog entry
echo "📝 Would you like to add a changelog entry for this release? (y/n)"
read -r ADD_CHANGELOG

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

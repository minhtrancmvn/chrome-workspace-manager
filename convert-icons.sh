#!/bin/bash

# Icon Converter Script
# This script converts SVG icons to PNG format

echo "Converting SVG icons to PNG..."

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo "❌ ImageMagick not found. Installing via Homebrew..."
    if command -v brew &> /dev/null; then
        brew install imagemagick
    else
        echo "❌ Please install ImageMagick manually:"
        echo "   brew install imagemagick"
        echo "   or visit: https://imagemagick.org/script/download.php"
        exit 1
    fi
fi

# Convert icons
convert icons/icon16.svg icons/icon16.png
convert icons/icon48.svg icons/icon48.png
convert icons/icon128.svg icons/icon128.png

echo "✅ Icons converted successfully!"
echo ""
echo "Next steps:"
echo "1. Load the extension in Chrome:"
echo "   - Open chrome://extensions/"
echo "   - Enable 'Developer mode'"
echo "   - Click 'Load unpacked'"
echo "   - Select this directory"
echo ""

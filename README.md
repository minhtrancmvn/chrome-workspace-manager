# Workspace Manager

A Chrome extension that helps you manage different workspaces using separate browser windows. Switch between workspaces easily while automatically closing inactive ones to minimize memory usage.

## Features

- **🪟 Workspace Windows**: Create separate browser windows for different workspaces
- **🔄 Easy Switching**: Quickly switch between workspaces with a single click
- **💾 Memory Optimization**: Automatically closes inactive workspaces to save memory
- **📑 Tab Persistence**: Saves your tabs when switching workspaces
- **🏷️ Visual Badge**: Extension icon shows the current workspace label (first 3 characters)
- **⌨️ Keyboard Shortcut**: Quick access with `Ctrl+Shift+W` (or `Cmd+Shift+W` on Mac)

## Installation

### From Source

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top-right corner
4. Click "Load unpacked"
5. Select the extension directory

## Usage

### Creating a Workspace

1. Click the extension icon or press `Ctrl+Shift+W` (or `Cmd+Shift+W` on Mac)
2. Enter a name for your new workspace
3. Optionally check "Include current tabs" to add all tabs from your current window
4. Click "Create Workspace"

### Switching Workspaces

1. Open the extension popup
2. Click on a workspace or click the "Switch" button
3. The extension will:
   - Save your current workspace's tabs
   - Close all other windows
   - Open the selected workspace in a new window with all its tabs

### Deleting a Workspace

1. Open the extension popup
2. Click the "Delete" button next to the workspace you want to remove
3. Confirm the deletion

## How It Works

- Each workspace is associated with a Chrome window
- When you switch workspaces, all other windows are automatically closed
- Tab URLs and titles are saved to Chrome's local storage
- The extension restores tabs when you switch back to a workspace
- Active workspace is highlighted with a badge

## Technical Details

- **Manifest Version**: 3
- **Permissions**:
  - `tabs`: To manage tabs within workspaces
  - `windows`: To create, close, and switch between windows
  - `storage`: To persist workspace data
- **Service Worker**: Background script for workspace management

## Project Structure

```
Workspace Manager/
├── manifest.json       # Extension configuration
├── background.js       # Service worker for workspace logic
├── popup.html         # Extension popup interface
├── popup.js           # Popup interaction logic
├── popup.css          # Popup styling
├── icons/             # Extension icons (add your own)
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md          # This file
```

## Icon Placeholders

⚠️ **Note**: This extension includes placeholder icon references. You need to add your own icon images:

- `icons/icon16.png` (16x16 pixels)
- `icons/icon48.png` (48x48 pixels)
- `icons/icon128.png` (128x128 pixels)

You can create simple icons using any image editor or online icon generators.

## Releases

All packaged releases are available in the `releases/` folder:

- **releases/CHANGELOG.md** - Detailed changelog of all versions
- **releases/workspace-manager-vX.X.X.zip** - Packaged extension files

To create a new release, run:

```bash
./package-extension.sh
```

See [releases/README.md](releases/README.md) for more details.

## Development

To modify the extension:

1. Make your changes to the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Test your changes

## Privacy

All workspace data is stored locally using Chrome's storage API. No data is sent to external servers.

## License

This project is open source and available under the MIT License.

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests.

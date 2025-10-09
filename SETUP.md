# Workspace Manager - Setup Guide

## 🎉 Your Chrome Extension is Ready!

The Workspace Manager Chrome extension has been successfully created. Follow the steps below to load and test it in Chrome.

## 📁 Project Structure

```
Workspace Manager/
├── manifest.json          # Extension configuration
├── background.js          # Service worker (workspace logic)
├── popup.html            # Extension popup UI
├── popup.js              # Popup interaction logic
├── popup.css             # Popup styling
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md             # Full documentation
├── convert-icons.sh      # Icon conversion script
└── .github/
    └── copilot-instructions.md

```

## 🚀 Loading the Extension in Chrome

### Step 1: Open Chrome Extensions Page
1. Open Google Chrome
2. Navigate to `chrome://extensions/`
3. Or click the three-dot menu → Extensions → Manage Extensions

### Step 2: Enable Developer Mode
1. Toggle "Developer mode" switch in the top-right corner

### Step 3: Load the Extension
1. Click "Load unpacked" button
2. Navigate to and select this directory:
   ```
   /Users/coffeemug/Library/Mobile Documents/com~apple~CloudDocs/Programming/Workspace Manager
   ```
3. Click "Select"

### Step 4: Pin the Extension (Optional)
1. Click the puzzle piece icon in Chrome toolbar
2. Find "Workspace Manager"
3. Click the pin icon to keep it visible

## 🎯 How to Use

### Creating Your First Workspace
1. Click the extension icon (or press `Cmd+Shift+W`)
2. Enter a workspace name (e.g., "Work", "Personal", "Shopping")
3. Check "Include current tabs" if you want to save your current tabs
4. Click "Create Workspace"

### Switching Between Workspaces
1. Open the extension popup
2. Click on a workspace name or the "Switch" button
3. All other windows will close, and your selected workspace will open

### Managing Workspaces
- **Active workspace**: Shows a blue "ACTIVE" badge
- **Delete**: Click the red "Delete" button to remove a workspace
- **Last accessed**: See when you last used each workspace

## ⌨️ Keyboard Shortcut

- **Mac**: `Cmd+Shift+W`
- **Windows/Linux**: `Ctrl+Shift+W`

## 🔧 Features

✅ Create multiple workspaces with custom names  
✅ Save and restore tabs for each workspace  
✅ Automatic closure of inactive workspaces (saves memory!)  
✅ Quick switching between workspaces  
✅ Badge on extension icon shows current workspace (first 3 letters)  
✅ Shows tab count and last accessed time  
✅ Clean, modern UI with gradient theme  

## 🐛 Troubleshooting

### Extension won't load
- Make sure you selected the correct folder
- Check that all files are present
- Look for errors in the Chrome Extensions page

### Icons not showing
- Icons are generated as PNG files
- If missing, run `./convert-icons.sh` again

### Tabs not saving
- Check Chrome's storage permissions
- The extension needs the "storage" permission (already configured)

## 📝 Next Steps

1. **Test the extension**: Create a few workspaces and switch between them
2. **Customize**: Modify the colors in `popup.css` to match your preferences
3. **Add features**: Extend functionality in `background.js` and `popup.js`

## 🎨 Customization Ideas

- Change the gradient colors in `popup.css`
- Add workspace icons/emojis
- Implement workspace export/import
- Add tab grouping within workspaces
- Create keyboard shortcuts for specific workspaces

## 📚 Learn More

- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Chrome APIs](https://developer.chrome.com/docs/extensions/reference/)

## 🎊 Enjoy Your New Workspace Manager!

You're all set! Start organizing your browsing sessions into manageable workspaces.

---

**Need help?** Check the README.md for more detailed information about the extension's features and architecture.

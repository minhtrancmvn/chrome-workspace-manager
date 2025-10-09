# Workspace Manager - Release Changelog

## Version 2.3.7 - 2025-10-09

### Bug Fixes
- **Fixed startup window cleanup:** Now properly uses `windowIds` array instead of singular `windowId`
- **Improved multi-window handling:** Startup cleanup now iterates through all workspace windows to find valid ones
- **Better window restoration:** `restoreActiveWindowState` now correctly manages the `windowIds` array
- **Data structure consistency:** All functions now use the modern multi-window data format

### Technical Details
- Updated `cleanupMultipleWindows` to iterate through `workspace.windowIds` array
- Updated `restoreActiveWindowState` to properly set and check `windowIds` as an array
- Ensures compatibility with multi-window workspace support introduced in v2.3.3

---

## Version 2.3.5 - 2025-10-09

### Changes
- **Keyboard shortcut changed:** Extension now uses `Cmd+Shift+S` (Mac) / `Ctrl+Shift+S` (Windows/Linux)
  - Previous shortcut (`Cmd+Shift+W`) conflicted with Chrome/Dia's "Restore closed tab/window" feature
  - New shortcut doesn't conflict with any browser defaults

### Note
- Version 2.4.0 was released but immediately reverted due to issues with window restoration detection
- This version only includes the keyboard shortcut change without the experimental Cmd+Shift+T prevention feature

---

## Version 2.3.4 - 2025-10-09

### Bug Fixes
- **Fixed duplicate pinned tabs on backup import:** When importing a backup with `sharePinnedTabs` enabled, pinned tabs were being duplicated
- **Improved backup restoration:** Now filters out pinned tabs from workspace windows during import when shared pinned tabs mode is active
- **Cleaner import process:** Pinned tabs are now properly loaded only from the `sharedPinnedTabs` array, not from workspace windows

### Technical Details
- Added filter during `importBackup` to remove pinned tabs from workspace windows when `settings.sharePinnedTabs` is true
- Prevents duplicate pinned tabs by ensuring they're only loaded from one source (sharedPinnedTabs array)
- Maintains data integrity between shared and separate pinned tab modes

---

## Version 2.3.3 - 2025-10-09

### Bug Fixes
- **Fixed aggressive window cleanup:** Periodic cleanup no longer closes manually created windows
- **Auto-track new windows:** New windows created manually are automatically added to the active workspace
- **Improved window management:** Only closes windows from OTHER workspaces, not untracked windows
- **Better workspace isolation:** User-created windows are now preserved and tracked automatically

### New Features
- **Automatic window detection:** When you create a new window while in a workspace, it's automatically saved to that workspace
- **Seamless window restoration:** New windows are restored when switching back to the workspace

### Documentation
- **Added installation GIF:** Visual guide now displayed in releases/README.md for easier installation

### Technical Details
- Added `chrome.windows.onCreated` listener to track new windows
- Modified periodic cleanup to only close windows belonging to inactive workspaces
- Untracked windows (user-created) are now preserved until workspace switch
- New windows automatically inherit workspace association with proper tab tracking

---

## Version 2.3.2 - 2025-10-09

### UI Improvements
- **Two-line workspace card info display:** Better readability and visual hierarchy
- Window and tab counts now on first line
- Last accessed timestamp on second line
- Improved spacing with gap between lines

### Layout Changes
```
Before:
1 window(s) • 2 tab(s) • Last accessed: Just now

After:
1 window(s) • 2 tab(s)
Last accessed: Just now
```

---

## Version 2.3.1 - 2025-10-09

### UI Improvements
- **Redesigned workspace creation layout:** More compact and cleaner design
- Name input and color picker now on same row for better space usage
- Checkbox moved above the Create button for better visual flow
- Improved spacing and alignment throughout the form

### Layout Changes
```
Before:                          After:
[Name input...............]      [Name input........] [Color]
Color: [picker]                  [ ] Include current tabs
[Create Workspace]               [Create Workspace]
[ ] Include current tabs
```

---

## Version 2.3.0 - 2025-10-09

### New Features
- **Blank tabs are now automatically excluded:** New Tab pages (chrome://newtab, about:blank, etc.) are automatically filtered out when:
  - Creating a workspace with "Include current tabs" enabled
  - Saving workspace state during switches
  - Storing workspace data
- Cleaner workspace storage without unnecessary blank tabs
- If all tabs are blank, at least one new tab is preserved to avoid empty windows

### Technical Changes
- Added `isBlankTab()` helper function to detect various new tab URL patterns:
  - chrome://newtab, chrome://new-tab-page
  - edge://newtab
  - about:newtab, about:blank
  - dia://new-tab-page, dia://new-tab-page-third-party
- Applied filtering across all tab capture functions
- Safety check to ensure at least one tab per window

---

## Version 2.2.2 - 2025-10-09

### Bug Fixes
- **Fixed shared pinned tabs not appearing in new workspaces:** When creating a new workspace without including current tabs, shared pinned tabs (if enabled) are now immediately added to the new window
- Previously, shared pinned tabs only appeared after switching workspaces
- New workspaces now properly respect the "Share pinned tabs across all workspaces" setting from the start

### Technical Changes
- Added logic to populate shared pinned tabs when creating fresh workspace windows
- Removes default new tab only if shared pinned tabs are present
- Better console logging for shared pinned tabs during creation

---

## Version 2.2.1 - 2025-10-09

### Critical Bug Fix
- **Fixed workspace creation still capturing current tabs:** When "Include current tabs" was unchecked, the extension was still keeping the current window and its tabs
- Now properly closes current windows and creates a fresh window with empty tab when checkbox is unchecked
- The workspace is now truly empty when created without including tabs

### Technical Changes
- When `includeCurrentTabs: false`, extension now closes all current windows and creates new ones
- Added proper window recreation logic with correct state preservation
- Uses `isSwitchingWorkspace` flag during window recreation to prevent interference

---

## Version 2.2.0 - 2025-10-09

### Major Bug Fix
- **Fixed "Include current tabs" checkbox not working:** Creating a new workspace was ALWAYS capturing current tabs regardless of checkbox state
- New workspaces now properly respect the "Include current tabs" setting
- When unchecked, new workspace creates with a single empty tab instead of duplicating current tabs

### Improvements
- Updated edit icon to match the design system (edit-icon.svg)
- Workspace color is now set during creation (no separate update call)
- Better logging for workspace creation process
- Cleaner creation flow with fewer API calls

### Technical Changes
- `createWorkspace()` now accepts `includeCurrentTabs` and `color` parameters
- Removed redundant `updateWorkspaceColor` call after creation
- Fixed parameter passing from popup to background script

---

## Version 2.1.3 - 2025-10-09

### Critical Bug Fixes
- **Fixed workspace data corruption during switching:** Tabs and window positions were getting mixed up when switching between workspaces
- Set `isSwitchingWorkspace` flag BEFORE saving current workspace state
- Added protection to `onBoundsChanged` listener to prevent saving during switch
- Added 500ms settling delay before clearing switch flag
- Added comprehensive logging throughout the switch process

### Improvements
- Enhanced switch process with detailed console logging
- Better async operation sequencing during workspace switches
- More defensive checks in save functions

---

## Version 2.1.2 - 2025-10-09

### Improvements
- Added comprehensive logging for workspace creation process
- Enhanced console output to track active workspace changes
- Better debugging information for workspace activation
- Improved async handling when updating workspace colors after creation

### Bug Fixes
- Fixed timing issue with color updates during workspace creation
- Ensured proper callback chain when creating and configuring new workspaces

---

## Version 2.1.1 - 2025-10-09

### Bug Fixes
- Fixed "Unknown error" when renaming workspaces
- Added better error handling for Chrome runtime errors
- Added detailed logging for rename operations to help debugging

### Improvements
- Better error messages when rename operations fail
- Enhanced error detection with chrome.runtime.lastError checking

---

## Version 2.1.0 - 2025-10-09

### New Features
- Added ability to rename workspaces with inline editing
- Click the pencil/edit icon to rename any workspace
- Press Enter to save, Escape to cancel

### UI Improvements
- Added edit button with blue theme next to each workspace
- Inline input field with focus styling and validation

---

## Version 2.0.3 - 2025-10-09

### Bug Fixes
- **Critical:** Fixed data loss bug during workspace switching
- Added `isSwitchingWorkspace` flag to prevent window removal listener from corrupting workspace data
- Protected workspace data during switch, delete, and periodic cleanup operations

---

## Version 2.0.2 - 2025-10-09

### Bug Fixes
- Fixed window size not restoring correctly
- Create windows in normal state first, then update to maximized/fullscreen state
- Improved window state restoration reliability

---

## Version 2.0.0 - 2025-10-09

### Major Features
- **Multi-window workspace support:** Each workspace can now contain multiple windows
- All windows in a workspace are saved and restored together
- Changed data structure from single `windowId` to `windowIds` array
- Added `windows` array with per-window state and tabs
- Automatic migration from v1.x single-window format

### UI Changes
- Workspace cards now show "X windows • Y tabs" count
- Updated metadata display for multi-window information

---

## Version 1.1.1 - 2025-10-09

### Bug Fixes
- Fixed delete button not clickable on Dia browser
- Added CSS z-index layers and proper event propagation handling
- Improved pointer-events for button interactions

---

## Version 1.1.0 - 2025-10-09

### Bug Fixes
- Fixed workspace restoration issues on Dia browser
- Added browser session restore detection and adaptation
- Improved compatibility with Dia browser window management

---

## Version 1.0.9 - 2025-10-09

### Bug Fixes
- Fixed multiple windows appearing on restart in Dia browser
- Added cleanup function to keep only active workspace windows
- Improved startup window management

---

## Version 1.0.8 - 2025-10-09

### Bug Fixes
- Fixed window size not being restored correctly
- Improved window dimension handling during workspace switches

---

## Version 1.0.7 - 2025-10-09

### Bug Fixes
- Fixed Dia browser new tab pages appearing when switching workspaces
- Added comprehensive new tab URL detection (dia://, chrome://, edge://, about:)
- Automatic removal of browser new tab pages

---

## Version 1.0.4 - 2025-10-09

### Features
- Added workspace color customization
- Color picker for each workspace
- Badge color updates to match workspace color

---

## Version 1.0.3 - 2025-10-09

### Features
- Added backup and restore functionality
- Export all workspaces to JSON file
- Import workspaces from backup file

---

## Version 1.0.0 - 2025-10-09

### Initial Release
- Create and manage multiple browser workspaces
- Switch between workspaces with automatic window closure
- Save and restore tabs for each workspace
- Keyboard shortcut (Cmd/Ctrl+Shift+W)
- Badge indicator showing active workspace
- Memory optimization by closing inactive workspace windows
- Settings for shared pinned tabs across workspaces

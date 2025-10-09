// Background service worker for Workspace Manager

// Store workspace data
let workspaces = {};
let activeWorkspaceId = null;
let isDataLoaded = false;
let sharedPinnedTabs = [];
let settings = {
  sharePinnedTabs: false // false = separate pinned tabs per workspace, true = shared across all
};
let isSwitchingWorkspace = false; // Flag to prevent window removal from updating workspace data

// Helper function to check if a URL is a blank/new tab page
function isBlankTab(url) {
  const blankTabPatterns = [
    'chrome://newtab',
    'chrome://new-tab-page',
    'edge://newtab',
    'about:newtab',
    'about:blank',
    'dia://new-tab-page',
    'dia://new-tab-page-third-party'
  ];
  
  return blankTabPatterns.some(pattern => url?.startsWith(pattern));
}

// Initialize storage and ensure data is loaded
async function initializeData() {
  if (isDataLoaded) return;
  
  return new Promise((resolve) => {
    chrome.storage.local.get(['workspaces', 'activeWorkspaceId', 'sharedPinnedTabs', 'settings'], (result) => {
      workspaces = result.workspaces || {};
      activeWorkspaceId = result.activeWorkspaceId || null;
      sharedPinnedTabs = result.sharedPinnedTabs || [];
      settings = result.settings || { sharePinnedTabs: false };
      
      // Migrate old data format (single windowId) to new format (windowIds array)
      for (const workspace of Object.values(workspaces)) {
        if (workspace.windowId !== undefined && !workspace.windowIds) {
          workspace.windowIds = workspace.windowId ? [workspace.windowId] : [];
          delete workspace.windowId;
        }
        // Ensure windowIds exists
        if (!workspace.windowIds) {
          workspace.windowIds = [];
        }
      }
      
      isDataLoaded = true;
      resolve();
    });
  });
}

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  initializeData();
});

// Initialize on startup
chrome.runtime.onStartup.addListener(async () => {
  await initializeData();
  updateBadge();
  
  // Clean up multiple windows on startup - only keep active workspace window
  await cleanupMultipleWindows();
});

// Load data immediately when service worker starts
initializeData().then(() => {
  updateBadge();
});

// Periodic cleanup: ensure only active workspace windows exist
// Run every 30 seconds to catch any orphaned windows
setInterval(async () => {
  await initializeData();
  const allWindows = await chrome.windows.getAll();
  
  // Only cleanup if we have windows
  if (allWindows.length > 0 && activeWorkspaceId && workspaces[activeWorkspaceId]) {
    const activeWorkspace = workspaces[activeWorkspaceId];
    
    // Get all window IDs that belong to ANY workspace
    const allWorkspaceWindowIds = new Set();
    for (const workspace of Object.values(workspaces)) {
      if (workspace.windowIds && Array.isArray(workspace.windowIds)) {
        workspace.windowIds.forEach(wId => allWorkspaceWindowIds.add(wId));
      }
    }
    
    // Set flag to prevent onRemoved from updating workspace data
    isSwitchingWorkspace = true;
    
    // Close windows that don't belong to the active workspace
    for (const window of allWindows) {
      // If this window belongs to active workspace, keep it
      if (activeWorkspace.windowIds && activeWorkspace.windowIds.includes(window.id)) {
        continue;
      }
      
      // If it doesn't belong to any workspace, it's orphaned - close it
      if (!allWorkspaceWindowIds.has(window.id)) {
        console.log('Closing orphaned window:', window.id);
        try {
          await chrome.windows.remove(window.id);
        } catch (e) {
          // Window might already be closed
        }
      } else {
        // Window belongs to another workspace (not active), close it
        console.log('Closing window from inactive workspace:', window.id);
        try {
          await chrome.windows.remove(window.id);
        } catch (e) {
          // Window might already be closed
        }
      }
    }
    
    // Clear flag
    isSwitchingWorkspace = false;
  }
}, 30000); // 30 seconds

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'getWorkspaces':
      // Ensure data is loaded before responding
      initializeData().then(() => {
        console.log('Sending workspaces to popup:', Object.keys(workspaces).length, 'workspaces');
        console.log('Workspace details:', workspaces);
        sendResponse({ workspaces, activeWorkspaceId });
      });
      return true; // Keep channel open for async response
    
    case 'createWorkspace':
      createWorkspace(request.name, request.includeCurrentTabs, request.color)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true; // Keep channel open for async response
    
    case 'switchWorkspace':
      switchWorkspace(request.workspaceId)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    
    case 'deleteWorkspace':
      console.log('Delete workspace request received:', request.workspaceId);
      deleteWorkspace(request.workspaceId)
        .then(result => {
          console.log('Delete workspace success:', result);
          sendResponse(result);
        })
        .catch(error => {
          console.error('Delete workspace error:', error);
          sendResponse({ error: error.message });
        });
      return true;
    
    case 'updateWorkspace':
      updateWorkspace(request.workspaceId, request.updates)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    
    case 'updateWorkspaceColor':
      updateWorkspaceColor(request.workspaceId, request.color)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    
    case 'renameWorkspace':
      renameWorkspace(request.workspaceId, request.name)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    
    case 'exportBackup':
      exportBackup()
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    
    case 'importBackup':
      importBackup(request.data)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
    
    case 'getSettings':
      sendResponse({ settings, sharedPinnedTabs });
      break;
    
    case 'updateSettings':
      updateSettings(request.settings)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
      return true;
  }
});

// Create a new workspace
async function createWorkspace(name, includeCurrentTabs = false, color = '#667eea') {
  const workspaceId = Date.now().toString();
  
  console.log('Creating workspace:', { name, includeCurrentTabs, color });
  
  // Get ALL current windows
  const allWindows = await chrome.windows.getAll({ populate: true });
  
  // Capture state and tabs from all windows
  const windowsData = [];
  
  if (includeCurrentTabs) {
    // Include current tabs - capture from existing windows
    for (const window of allWindows) {
      let windowState = { state: 'maximized' };
      if (window.state === 'normal') {
        windowState = {
          left: window.left,
          top: window.top,
          width: window.width,
          height: window.height,
          state: 'normal'
        };
      } else {
        windowState = { state: window.state };
      }
      
      // Get tabs from this window
      let windowTabs;
      if (settings.sharePinnedTabs) {
        // In shared mode, only get unpinned tabs (pinned tabs are shared)
        windowTabs = window.tabs
          .filter(tab => !tab.pinned && !isBlankTab(tab.url))
          .map(tab => ({ url: tab.url, title: tab.title, pinned: false }));
      } else {
        // In separate mode, get all tabs including pinned (but exclude blank tabs)
        windowTabs = window.tabs
          .filter(tab => !isBlankTab(tab.url))
          .map(tab => ({ 
            url: tab.url, 
            title: tab.title,
            pinned: tab.pinned || false
          }));
      }
      
      // If all tabs were filtered out (all were blank), add at least one new tab
      if (windowTabs.length === 0) {
        windowTabs = [{ url: 'chrome://newtab', title: 'New Tab', pinned: false }];
      }
      
      windowsData.push({
        windowId: window.id,
        windowState: windowState,
        tabs: windowTabs
      });
    }
  } else {
    // Don't include current tabs - create with just a new tab
    // Use first window's state as template
    const firstWindow = allWindows[0];
    let windowState = { state: 'maximized' };
    if (firstWindow && firstWindow.state === 'normal') {
      windowState = {
        left: firstWindow.left,
        top: firstWindow.top,
        width: firstWindow.width,
        height: firstWindow.height,
        state: 'normal'
      };
    }
    
    windowsData.push({
      windowId: firstWindow?.id || Date.now(),
      windowState: windowState,
      tabs: [{ url: 'chrome://newtab', title: 'New Tab', pinned: false }]
    });
  }
  
  // Calculate total tab count
  const totalTabs = windowsData.reduce((sum, w) => sum + w.tabs.length, 0);
  
  console.log('Creating workspace with windows:', {
    windowCount: allWindows.length,
    windowIds: allWindows.map(w => w.id),
    totalTabs: totalTabs,
    windowsData: windowsData
  });
  
  // Save workspace data with multiple windows
  workspaces[workspaceId] = {
    id: workspaceId,
    name: name || `Workspace ${Object.keys(workspaces).length + 1}`,
    windowIds: [],  // Will be set after window creation
    windows: windowsData,
    tabs: totalTabs, // Store total count for display
    color: color || '#667eea',
    createdAt: Date.now(),
    lastAccessed: Date.now()
  };
  
  console.log('Workspace created:', workspaces[workspaceId]);
  
  // If not including current tabs, we need to close and recreate windows
  if (!includeCurrentTabs) {
    console.log('Creating fresh workspace - closing current windows and creating new ones');
    
    // Set flag to prevent window removal listener from interfering
    isSwitchingWorkspace = true;
    
    // Close all current windows
    const currentWindows = await chrome.windows.getAll();
    for (const window of currentWindows) {
      await chrome.windows.remove(window.id).catch(() => {});
    }
    
    // Create new window with empty tab
    const newWindow = await chrome.windows.create({
      focused: true,
      state: windowsData[0].windowState.state || 'maximized',
      ...(windowsData[0].windowState.state === 'normal' && {
        left: windowsData[0].windowState.left,
        top: windowsData[0].windowState.top,
        width: windowsData[0].windowState.width,
        height: windowsData[0].windowState.height
      })
    });
    
    const defaultTab = newWindow.tabs[0];
    
    // If shared pinned tabs are enabled, add them to the new window
    if (settings.sharePinnedTabs && sharedPinnedTabs.length > 0) {
      console.log('Adding shared pinned tabs:', sharedPinnedTabs.length);
      for (const tab of sharedPinnedTabs) {
        await chrome.tabs.create({
          windowId: newWindow.id,
          url: tab.url,
          pinned: true
        });
      }
      
      // Remove the default new tab after adding pinned tabs
      try {
        await chrome.tabs.remove(defaultTab.id);
      } catch (e) {
        console.log('Could not remove default tab:', e);
      }
    }
    // If no shared pinned tabs, keep the default new tab
    
    // Update workspace with new window ID
    workspaces[workspaceId].windowIds = [newWindow.id];
    workspaces[workspaceId].windows[0].windowId = newWindow.id;
    
    // Clear the switching flag after a delay
    await new Promise(resolve => setTimeout(resolve, 500));
    isSwitchingWorkspace = false;
    
    console.log('New window created:', newWindow.id);
  } else {
    // Including current tabs - just assign current window IDs
    workspaces[workspaceId].windowIds = allWindows.map(w => w.id);
    console.log('Using current windows:', workspaces[workspaceId].windowIds);
  }
  
  activeWorkspaceId = workspaceId;
  await saveState();
  
  console.log('Active workspace set to:', activeWorkspaceId, '(' + workspaces[workspaceId].name + ')');
  updateBadge();
  console.log('Badge updated for workspace:', workspaces[workspaceId].name.substring(0, 3).toUpperCase());
  
  return { success: true, workspaceId };
}

// Switch to a workspace
async function switchWorkspace(workspaceId) {
  if (!workspaces[workspaceId]) {
    throw new Error('Workspace not found');
  }
  
  const workspace = workspaces[workspaceId];
  
  console.log('=== Starting workspace switch ===');
  console.log('From:', activeWorkspaceId, workspaces[activeWorkspaceId]?.name);
  console.log('To:', workspaceId, workspace.name);
  
  // Set flag FIRST to prevent any interference
  isSwitchingWorkspace = true;
  
  // Save current workspace state before switching
  if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
    console.log('Saving current workspace state...');
    await saveAllWorkspaceWindows();
    console.log('Current workspace saved:', {
      windows: workspaces[activeWorkspaceId].windows.length,
      tabs: workspaces[activeWorkspaceId].tabs
    });
  }
  
  // Close ALL current windows
  console.log('Closing all current windows...');
  const allWindows = await chrome.windows.getAll();
  for (const window of allWindows) {
    await chrome.windows.remove(window.id).catch(() => {});
  }
  
  // Recreate all windows for the target workspace
  const newWindowIds = [];
  
  if (workspace.windows && workspace.windows.length > 0) {
    for (let i = 0; i < workspace.windows.length; i++) {
      const windowData = workspace.windows[i];
      
      // Build window creation options
      const createOptions = {
        focused: i === 0 // Focus first window
      };
      
      // For normal state, set dimensions
      if (windowData.windowState.state === 'normal' && windowData.windowState.width && windowData.windowState.height) {
        createOptions.left = windowData.windowState.left;
        createOptions.top = windowData.windowState.top;
        createOptions.width = windowData.windowState.width;
        createOptions.height = windowData.windowState.height;
        createOptions.state = 'normal';
      } else {
        // For maximized/fullscreen, create in normal first, then update state
        // This is because Chrome ignores dimensions when state is set during creation
        createOptions.state = 'normal';
      }
      
      const newWindow = await chrome.windows.create(createOptions);
      newWindowIds.push(newWindow.id);
      
      // If the desired state is not normal, update it after creation
      if (windowData.windowState.state !== 'normal') {
        try {
          await chrome.windows.update(newWindow.id, { 
            state: windowData.windowState.state 
          });
        } catch (e) {
          console.error('Failed to set window state:', e);
        }
      }
      
      // Remove default tab
      const defaultTab = newWindow.tabs[0];
      
      // Determine which tabs to load
      let tabsToLoad;
      if (settings.sharePinnedTabs) {
        // Shared mode: Load shared pinned tabs first, then workspace tabs
        tabsToLoad = [...sharedPinnedTabs, ...windowData.tabs];
      } else {
        // Separate mode: Load all workspace tabs (includes pinned)
        tabsToLoad = windowData.tabs;
      }
      
      // Load pinned tabs first, then unpinned
      const pinnedTabs = tabsToLoad.filter(tab => tab.pinned);
      const unpinnedTabs = tabsToLoad.filter(tab => !tab.pinned);
      
      for (const tab of [...pinnedTabs, ...unpinnedTabs]) {
        await chrome.tabs.create({
          windowId: newWindow.id,
          url: tab.url,
          pinned: tab.pinned || false
        });
      }
      
      // Remove new tab pages
      try {
        await chrome.tabs.remove(defaultTab.id);
      } catch (e) {}
    }
  } else {
    // No saved windows, create a default one
    const newWindow = await chrome.windows.create({
      focused: true,
      state: 'maximized'
    });
    newWindowIds.push(newWindow.id);
  }
  
  workspace.windowIds = newWindowIds;
  workspace.lastAccessed = Date.now();
  activeWorkspaceId = workspaceId;
  
  console.log('Workspace switch complete. New windows:', newWindowIds);
  console.log('Active workspace:', activeWorkspaceId, workspace.name);
  
  await saveState();
  updateBadge();
  
  // Wait a bit to ensure all Chrome events have settled
  await new Promise(resolve => setTimeout(resolve, 500));
  
  // Clear the switching flag AFTER everything is saved and settled
  isSwitchingWorkspace = false;
  
  console.log('=== Workspace switch finished ===');
  
  return { success: true };
}

// Delete a workspace
async function deleteWorkspace(workspaceId) {
  console.log('deleteWorkspace called for:', workspaceId);
  console.log('Current workspaces:', Object.keys(workspaces));
  
  if (!workspaces[workspaceId]) {
    console.error('Workspace not found:', workspaceId);
    throw new Error('Workspace not found');
  }
  
  const workspace = workspaces[workspaceId];
  const wasActive = activeWorkspaceId === workspaceId;
  console.log('Deleting workspace:', workspace.name, 'wasActive:', wasActive);
  
  // Set flag to prevent window removal listener from updating data
  isSwitchingWorkspace = true;
  
  // Close all workspace windows if it's not the active workspace
  if (!wasActive && workspace.windowIds) {
    for (const windowId of workspace.windowIds) {
      try {
        console.log('Attempting to close window:', windowId);
        await chrome.windows.remove(windowId);
        console.log('Window closed successfully');
      } catch (e) {
        // Window may already be closed
        console.log('Could not close window:', e);
      }
    }
  }
  
  delete workspaces[workspaceId];
  console.log('Workspace deleted, remaining:', Object.keys(workspaces).length);
  
  // If deleting the active workspace, switch to the last visited one
  if (wasActive) {
    console.log('Active workspace deleted, switching to another...');
    activeWorkspaceId = null;
    
    // Find remaining workspaces sorted by last accessed
    const remainingWorkspaces = Object.values(workspaces)
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    
    if (remainingWorkspaces.length > 0) {
      // Switch to the most recently accessed workspace
      const nextWorkspace = remainingWorkspaces[0];
      console.log('Switching to workspace:', nextWorkspace.name);
      await saveState();
      await switchWorkspace(nextWorkspace.id);
    } else {
      // No workspaces left, create a blank window
      console.log('No workspaces remaining, creating blank window');
      await chrome.windows.create({
        focused: true,
        state: 'maximized'
      });
      await saveState();
      updateBadge();
    }
  } else {
    console.log('Non-active workspace deleted, saving state');
    await saveState();
    updateBadge();
  }
  
  // Clear the flag
  isSwitchingWorkspace = false;
  
  console.log('Delete workspace completed successfully');
  return { success: true };
}

// Update workspace
async function updateWorkspace(workspaceId, updates) {
  if (!workspaces[workspaceId]) {
    throw new Error('Workspace not found');
  }
  
  workspaces[workspaceId] = { ...workspaces[workspaceId], ...updates };
  await saveState();
  
  return { success: true };
}

// Update workspace color
async function updateWorkspaceColor(workspaceId, color) {
  if (!workspaces[workspaceId]) {
    throw new Error('Workspace not found');
  }
  
  workspaces[workspaceId].color = color;
  await saveState();
  
  // Update badge if this is the active workspace
  if (workspaceId === activeWorkspaceId) {
    updateBadge();
  }
  
  return { success: true };
}

// Rename workspace
async function renameWorkspace(workspaceId, newName) {
  console.log('renameWorkspace called:', { workspaceId, newName });
  console.log('Available workspaces:', Object.keys(workspaces));
  
  if (!workspaces[workspaceId]) {
    console.error('Workspace not found:', workspaceId);
    throw new Error('Workspace not found');
  }
  
  if (!newName || !newName.trim()) {
    console.error('Invalid workspace name:', newName);
    throw new Error('Workspace name cannot be empty');
  }
  
  const oldName = workspaces[workspaceId].name;
  workspaces[workspaceId].name = newName.trim();
  await saveState();
  
  console.log('Workspace renamed:', oldName, '->', newName.trim());
  return { success: true };
}

// Export backup
async function exportBackup() {
  // Save current active workspace tabs and window state before exporting
  if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
    await saveCurrentWorkspaceTabs();
    await saveCurrentWindowState();
  }
  
  const backupData = {
    version: '1.0.1',
    timestamp: Date.now(),
    workspaces: workspaces,
    activeWorkspaceId: activeWorkspaceId,
    settings: settings,
    sharedPinnedTabs: sharedPinnedTabs
  };
  
  return { success: true, data: backupData };
}

// Import backup
async function importBackup(data) {
  if (!data || !data.workspaces) {
    throw new Error('Invalid backup data');
  }
  
  // Close all current workspace windows
  const allWindows = await chrome.windows.getAll();
  for (const window of allWindows) {
    try {
      await chrome.windows.remove(window.id);
    } catch (e) {
      // Continue even if window close fails
    }
  }
  
  // Restore settings
  if (data.settings) {
    settings = data.settings;
  } else {
    settings = { sharePinnedTabs: false }; // Default for old backups
  }
  
  // Restore shared pinned tabs
  if (data.sharedPinnedTabs) {
    sharedPinnedTabs = data.sharedPinnedTabs;
  } else {
    sharedPinnedTabs = [];
  }
  
  // Restore workspaces (without window IDs as they're closed)
  workspaces = {};
  for (const [id, workspace] of Object.entries(data.workspaces)) {
    workspaces[id] = {
      ...workspace,
      windowId: null // Reset window ID as old windows are closed
    };
  }
  
  activeWorkspaceId = null;
  await saveState();
  
  // If there were workspaces, switch to the previously active one or most recent
  const workspaceArray = Object.values(workspaces);
  if (workspaceArray.length > 0) {
    let targetWorkspace;
    if (data.activeWorkspaceId && workspaces[data.activeWorkspaceId]) {
      targetWorkspace = workspaces[data.activeWorkspaceId];
    } else {
      // Find most recently accessed
      targetWorkspace = workspaceArray.sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
    }
    
    if (targetWorkspace) {
      await switchWorkspace(targetWorkspace.id);
    }
  } else {
    // No workspaces to restore, create blank window
    await chrome.windows.create({
      focused: true,
      state: 'maximized'
    });
  }
  
  return { success: true, count: workspaceArray.length };
}

// Update settings
async function updateSettings(newSettings) {
  settings = { ...settings, ...newSettings };
  
  // If switching to shared pinned tabs mode, extract pinned tabs from active workspace
  if (settings.sharePinnedTabs && activeWorkspaceId && workspaces[activeWorkspaceId]) {
    try {
      const workspace = workspaces[activeWorkspaceId];
      const window = await chrome.windows.get(workspace.windowId, { populate: true });
      
      // Extract pinned tabs to shared
      sharedPinnedTabs = window.tabs.filter(tab => tab.pinned).map(tab => ({
        url: tab.url,
        title: tab.title,
        pinned: true
      }));
      
      // Remove pinned tabs from all workspaces
      for (const ws of Object.values(workspaces)) {
        ws.tabs = ws.tabs.filter(tab => !tab.pinned);
      }
    } catch (e) {
      // Continue even if window not found
    }
  }
  
  await saveState();
  return { success: true };
}

// Save all windows for current workspace
async function saveAllWorkspaceWindows() {
  if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) {
    console.log('saveAllWorkspaceWindows: No active workspace');
    return;
  }
  
  // Don't save if we're in the middle of switching (unless explicitly called during switch prep)
  if (isSwitchingWorkspace) {
    console.log('saveAllWorkspaceWindows: Switching in progress, using special handling');
  }
  
  const workspace = workspaces[activeWorkspaceId];
  const allWindows = await chrome.windows.getAll({ populate: true });
  
  console.log('saveAllWorkspaceWindows: Found', allWindows.length, 'windows');
  
  // Save data for all current windows
  const windowsData = [];
  for (const window of allWindows) {
    let windowState = { state: 'maximized' };
    if (window.state === 'normal') {
      windowState = {
        left: window.left,
        top: window.top,
        width: window.width,
        height: window.height,
        state: 'normal'
      };
    } else {
      windowState = { state: window.state };
    }
    
    // Get tabs from this window
    let windowTabs;
    if (settings.sharePinnedTabs) {
      // In shared mode, save shared pinned tabs separately (exclude blank tabs)
      const pinnedTabs = window.tabs
        .filter(tab => tab.pinned && !isBlankTab(tab.url))
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: true
        }));
      if (pinnedTabs.length > 0) {
        sharedPinnedTabs = pinnedTabs;
      }
      
      // Only save unpinned tabs to workspace (exclude blank tabs)
      windowTabs = window.tabs
        .filter(tab => !tab.pinned && !isBlankTab(tab.url))
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: false
        }));
    } else {
      // Save all tabs including pinned (exclude blank tabs)
      windowTabs = window.tabs
        .filter(tab => !isBlankTab(tab.url))
        .map(tab => ({ 
          url: tab.url, 
          title: tab.title,
          pinned: tab.pinned || false
        }));
    }
    
    // If all tabs were filtered out (all were blank), add at least one new tab
    if (windowTabs.length === 0) {
      windowTabs = [{ url: 'chrome://newtab', title: 'New Tab', pinned: false }];
    }
    
    windowsData.push({
      windowId: window.id,
      windowState: windowState,
      tabs: windowTabs
    });
  }
  
  workspace.windows = windowsData;
  workspace.windowIds = allWindows.map(w => w.id);
  workspace.tabs = windowsData.reduce((sum, w) => sum + w.tabs.length, 0); // Total count
  
  await saveState();
}

// Save current workspace tabs
async function saveCurrentWorkspaceTabs() {
  if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return;
  
  const workspace = workspaces[activeWorkspaceId];
  
  try {
    const window = await chrome.windows.get(workspace.windowId, { populate: true });
    
    if (settings.sharePinnedTabs) {
      // Separate pinned and unpinned tabs (exclude blank tabs)
      const pinnedTabs = window.tabs
        .filter(tab => tab.pinned && !isBlankTab(tab.url))
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: true
        }));
      const unpinnedTabs = window.tabs
        .filter(tab => !tab.pinned && !isBlankTab(tab.url))
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: false
        }));
      
      // Update shared pinned tabs
      sharedPinnedTabs = pinnedTabs;
      
      // Save only unpinned tabs to workspace
      workspace.tabs = unpinnedTabs;
    } else {
      // Save all tabs (including pinned) to workspace (exclude blank tabs)
      workspace.tabs = window.tabs
        .filter(tab => !isBlankTab(tab.url))
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: tab.pinned || false
        }));
    }
    
    await saveState();
  } catch (e) {
    // Window may be closed
  }
}

// Save current window state (size and position)
async function saveCurrentWindowState() {
  if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return;
  
  const workspace = workspaces[activeWorkspaceId];
  
  try {
    const window = await chrome.windows.get(workspace.windowId);
    
    // Save window dimensions if in normal state
    if (window.state === 'normal') {
      workspace.windowState = {
        left: window.left,
        top: window.top,
        width: window.width,
        height: window.height,
        state: 'normal'
      };
    } else {
      workspace.windowState = {
        state: window.state
      };
    }
    
    await saveState();
  } catch (e) {
    // Window may be closed
  }
}

// Save state to storage
async function saveState() {
  await chrome.storage.local.set({ 
    workspaces, 
    activeWorkspaceId, 
    sharedPinnedTabs, 
    settings 
  });
  updateBadge();
}

// Update extension badge with current workspace
function updateBadge() {
  if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
    const workspace = workspaces[activeWorkspaceId];
    // Get first 3 characters of workspace name
    const badgeText = workspace.name.substring(0, 3).toUpperCase();
    
    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: workspace.color || '#667eea' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Monitor window closures
chrome.windows.onRemoved.addListener(async (windowId) => {
  // Don't update workspace data if we're in the middle of switching workspaces
  if (isSwitchingWorkspace) {
    console.log('Ignoring window removal during workspace switch:', windowId);
    return;
  }
  
  // Find workspace with this window and remove it from the array
  for (const [id, workspace] of Object.entries(workspaces)) {
    if (workspace.windowIds && workspace.windowIds.includes(windowId)) {
      console.log('Window closed, removing from workspace:', windowId);
      // Remove this window ID from the array
      workspace.windowIds = workspace.windowIds.filter(wId => wId !== windowId);
      
      // Also remove from windows data
      if (workspace.windows) {
        workspace.windows = workspace.windows.filter(w => w.windowId !== windowId);
      }
      
      await saveState();
      break;
    }
  }
});

// Monitor window state changes (resize, move, maximize, etc.)
let saveWindowStateTimeout;
chrome.windows.onBoundsChanged.addListener(async (window) => {
  // Don't save during workspace switching
  if (isSwitchingWorkspace) {
    console.log('Ignoring bounds change during workspace switch:', window.id);
    return;
  }
  
  // Debounce - wait 500ms after last change before saving
  clearTimeout(saveWindowStateTimeout);
  saveWindowStateTimeout = setTimeout(async () => {
    // Double-check we're not switching
    if (isSwitchingWorkspace) {
      console.log('Ignoring debounced bounds change during workspace switch');
      return;
    }
    
    // Find workspace with this window
    if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
      const workspace = workspaces[activeWorkspaceId];
      // Check if this window belongs to the active workspace
      if (workspace.windowIds && workspace.windowIds.includes(window.id)) {
        // Save state of all windows in the workspace
        await saveAllWorkspaceWindows();
      }
    }
  }, 500);
});

// Helper function to restore active workspace window state
async function restoreActiveWindowState(window) {
  if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) {
    // Try to find a workspace to associate with this window
    const workspaceEntries = Object.entries(workspaces);
    if (workspaceEntries.length > 0) {
      // Use the last accessed workspace
      const sortedWorkspaces = workspaceEntries.sort((a, b) => 
        (b[1].lastAccessed || 0) - (a[1].lastAccessed || 0)
      );
      const [id, workspace] = sortedWorkspaces[0];
      workspace.windowId = window.id;
      activeWorkspaceId = id;
    } else {
      return;
    }
  }
  
  const workspace = workspaces[activeWorkspaceId];
  
  // Always update window ID to ensure association
  workspace.windowId = window.id;
  
  // Update tabs from current window (browser may have restored them)
  try {
    const windowWithTabs = await chrome.windows.get(window.id, { populate: true });
    if (windowWithTabs.tabs && windowWithTabs.tabs.length > 0) {
      // Update workspace tabs to reflect current state
      workspace.tabs = windowWithTabs.tabs
        .filter(tab => !tab.pinned || !settings.sharePinnedTabs)
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: tab.pinned || false
        }));
    }
  } catch (e) {
    console.error('Error updating tabs from window:', e);
  }
  
  // Restore window dimensions if we have them
  if (!workspace.windowState) {
    await saveState();
    return;
  }
  
  const updateInfo = {};
  
  if (workspace.windowState.state === 'normal' && 
      workspace.windowState.width && 
      workspace.windowState.height) {
    // Restore normal state with dimensions
    updateInfo.state = 'normal';
    updateInfo.left = workspace.windowState.left;
    updateInfo.top = workspace.windowState.top;
    updateInfo.width = workspace.windowState.width;
    updateInfo.height = workspace.windowState.height;
  } else if (workspace.windowState.state) {
    // Restore maximized or fullscreen state
    updateInfo.state = workspace.windowState.state;
  }
  
  try {
    if (Object.keys(updateInfo).length > 0) {
      await chrome.windows.update(window.id, updateInfo);
    }
    await saveState();
  } catch (e) {
    console.error('Error restoring window state:', e);
  }
}

// Clean up multiple windows on startup
async function cleanupMultipleWindows() {
  try {
    const allWindows = await chrome.windows.getAll();
    
    // If we only have one window, restore its state and we're done
    if (allWindows.length === 1) {
      await restoreActiveWindowState(allWindows[0]);
      return;
    }
    
    // Find the active workspace window
    let activeWindow = null;
    if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
      const workspace = workspaces[activeWorkspaceId];
      try {
        activeWindow = await chrome.windows.get(workspace.windowId);
        // Restore the window state if found
        await restoreActiveWindowState(activeWindow);
      } catch (e) {
        // Window doesn't exist
      }
    }
    
    // If no active window found, keep the first window and make it active
    if (!activeWindow && allWindows.length > 0) {
      activeWindow = allWindows[0];
      // Use the restore function to handle workspace association and state
      await restoreActiveWindowState(activeWindow);
    }
    
    // Close all other windows
    for (const window of allWindows) {
      if (activeWindow && window.id !== activeWindow.id) {
        try {
          await chrome.windows.remove(window.id);
        } catch (e) {
          // Window might already be closed
        }
      }
    }
    
    await saveState();
    updateBadge();
  } catch (e) {
    console.error('Error cleaning up windows:', e);
  }
}

// Background service worker for Workspace Manager
if (typeof importScripts === 'function') importScripts('browser-api.js');

function restorableUrl(url) {
  if (typeof browser !== 'undefined' && browser.runtime?.getBrowserInfo && isBlankTab(url)) {
    return 'about:blank';
  }
  return url;
}

// Store workspace data
let workspaces = {};
let activeWorkspaceId = null;
let isDataLoaded = false;
let sharedPinnedTabs = [];
let settings = {
  sharePinnedTabs: false // false = separate pinned tabs per workspace, true = shared across all
};
let isSwitchingWorkspace = false;
let dataReady;
let stateQueue = Promise.resolve();
let durableState;
let startupState;
let recoverySessionId;
let recoveryJournal;
let recoveryMetadata;
let startupSuperseded = false;
let discardStartupOnSave = false;
let userMutationInProgress = false;
let saveWorkspaceTimeout;

const recoveryKey = 'workspaceRecovery';
const sessionKey = 'workspaceSessionId';

function markerUrl(operationId, slot) {
  const url = new URL(chrome.runtime.getURL('recovery.html'));
  url.searchParams.set('operation', operationId);
  url.searchParams.set('slot', String(slot));
  return url.href;
}

async function readRecoveryMetadata() {
  const session = await chrome.storage.session.get(sessionKey);
  recoverySessionId = session[sessionKey];
  if (!recoverySessionId) {
    recoverySessionId = crypto.randomUUID();
    await chrome.storage.session.set({ [sessionKey]: recoverySessionId });
  }
  const local = await chrome.storage.local.get([recoveryKey, 'workspaceStartup']);
  recoveryJournal = local[recoveryKey] || null;
  recoveryMetadata = local.workspaceStartup || null;
}

async function writeRecoveryJournal(journal) {
  await chrome.storage.local.set({ [recoveryKey]: journal });
  recoveryJournal = journal;
}

async function locatePreparedWindows(journal) {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows.filter(window => (journal.slots || []).some((slot, index) =>
    (slot.id === window.id && slot.id !== null) ||
    window.tabs?.some(tab => tab.url === markerUrl(journal.operationId, index))));
}

async function recoverTransition() {
  const journal = recoveryJournal;
  if (!journal) return;
  const sameSession = journal.sessionId === recoverySessionId;
  const windows = sameSession ? await locatePreparedWindows(journal) : [];
  if (journal.phase !== 'committed') {
    const sourceState = JSON.parse(JSON.stringify(journal.sourceState));
    if (!sameSession) {
      for (const workspace of Object.values(sourceState.workspaces)) workspace.windowIds = [];
    }
    await chrome.storage.local.set({ ...sourceState, [recoveryKey]: journal });
    applyState(sourceState);
    durableState = copyState();
    for (const window of windows) {
      try { await chrome.windows.remove(window.id); } catch (error) {
        if (!/No window|not found/i.test(error.message)) throw error;
      }
    }
  } else {
    if (sameSession) {
      const sourceIds = new Set(journal.sourceIds || []);
      for (const id of sourceIds) {
        try { await chrome.windows.remove(id); } catch (error) {
          if (!/No window|not found/i.test(error.message)) throw error;
        }
      }
      for (const workspace of Object.values(workspaces)) {
        workspace.windowIds = workspace.windowIds.filter(id => !sourceIds.has(id));
      }
    } else {
      for (const workspace of Object.values(workspaces)) workspace.windowIds = [];
    }
    if (journal.committedState) {
      const committedState = JSON.parse(JSON.stringify(journal.committedState));
      if (!sameSession) for (const workspace of Object.values(committedState.workspaces)) workspace.windowIds = [];
      else for (const workspace of Object.values(committedState.workspaces)) {
        workspace.windowIds = workspace.windowIds.filter(id => !(journal.sourceIds || []).includes(id));
      }
      const startup = { sessionId: recoverySessionId, state: committedState };
      await chrome.storage.local.set({ ...committedState, workspaceStartup: startup });
      recoveryMetadata = startup;
      applyState(committedState);
      durableState = copyState();
    }
  }
  await chrome.storage.local.remove(recoveryKey);
  recoveryJournal = null;
}

const excludedWindowIds = new Set();
const dirtyWindowIds = new Set();

function copyState() {
  return JSON.parse(JSON.stringify({ workspaces, activeWorkspaceId, sharedPinnedTabs, settings }));
}

function applyState(state) {
  ({ workspaces, activeWorkspaceId, sharedPinnedTabs, settings } = JSON.parse(JSON.stringify(state)));
}

// Chrome does not serialize async event listeners. Own mutations in one queue;
// internal helpers do not enqueue again, so import/delete can call switch safely.
function runStateOperation(operation) {
  const result = stateQueue.then(async () => {
    await initializeData();
    try {
      await recoverTransition();
      return await operation();
    } catch (error) {
      if (durableState) applyState(durableState);
      throw error;
    }
  });
  stateQueue = result.catch(() => {});
  return result;
}

function reportEventError(error) {
  console.error('Workspace event failed:', error);
}

async function withTransition(operation) {
  if (isSwitchingWorkspace) throw new Error('Workspace transition already in progress');
  isSwitchingWorkspace = true;
  clearTimeout(saveWorkspaceTimeout);
  dirtyWindowIds.clear();
  try {
    return await operation();
  } finally {
    isSwitchingWorkspace = false;
  }
}

function scheduleWorkspaceSave(windowId) {
  const duringTransition = isSwitchingWorkspace;
  // Check again in the queue: a timer/event can outlive a workspace switch.
  return runStateOperation(async () => {
    if (duringTransition || isSwitchingWorkspace || !activeWorkspaceId || excludedWindowIds.has(windowId)) return;
    const workspace = workspaces[activeWorkspaceId];
    if (!workspace) return;
    if (!workspace.windowIds.includes(windowId) && Object.entries(workspaces)
      .some(([id, ws]) => id !== activeWorkspaceId && ws.windowIds?.includes(windowId))) return;
    try {
      await chrome.windows.get(windowId);
    } catch (error) {
      return; // A delayed event can refer to an already closed window.
    }
    const workspaceId = activeWorkspaceId;
    dirtyWindowIds.add(windowId);
    clearTimeout(saveWorkspaceTimeout);
    saveWorkspaceTimeout = setTimeout(() => {
      runStateOperation(async () => {
        if (workspaceId !== activeWorkspaceId || isSwitchingWorkspace) return;
        let hasLiveChange = false;
        for (const id of dirtyWindowIds) {
          try {
            await chrome.windows.get(id);
            hasLiveChange = true;
            break;
          } catch (error) {
            // Closed windows alone retain recovery, but must not discard a
            // different live window's change in the same coalesced batch.
          }
        }
        if (hasLiveChange) await saveAllWorkspaceWindows();
        dirtyWindowIds.clear();
      }).catch(reportEventError);
    }, 500);
  }).catch(reportEventError);
}

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
function initializeData() {
  if (!dataReady) {
    dataReady = (async () => {
      const result = await new Promise((resolve, reject) => {
        chrome.storage.local.get(['workspaces', 'activeWorkspaceId', 'sharedPinnedTabs', 'settings'], value => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(value);
        });
      });
      workspaces = result.workspaces || {};
      activeWorkspaceId = result.activeWorkspaceId || null;
      sharedPinnedTabs = result.sharedPinnedTabs || [];
      settings = result.settings || { sharePinnedTabs: false };
      for (const workspace of Object.values(workspaces)) {
        if (workspace.windowId !== undefined && !workspace.windowIds) {
          workspace.windowIds = workspace.windowId ? [workspace.windowId] : [];
          delete workspace.windowId;
        }
        if (!workspace.windowIds) workspace.windowIds = [];
      }
      isDataLoaded = true;
      durableState = copyState();
      await readRecoveryMetadata();
      await recoverTransition();
      startupState = recoveryMetadata?.sessionId === recoverySessionId && recoveryMetadata.state !== null ? recoveryMetadata.state : copyState();
      if (recoveryJournal?.phase === 'committed' && recoveryJournal.committedState) startupState = copyState();
      if (recoveryMetadata?.sessionId !== recoverySessionId) {
        recoveryMetadata = { sessionId: recoverySessionId, state: copyState() };
        await chrome.storage.local.set({ workspaceStartup: recoveryMetadata });
      }
      startupSuperseded = recoveryMetadata?.sessionId === recoverySessionId && recoveryMetadata.state === null;
      if (startupSuperseded) startupState = null;
    })().catch(error => {
      dataReady = null;
      throw error;
    });
  }
  return dataReady;
}

chrome.runtime.onInstalled.addListener(() => {
  return runStateOperation(() => updateBadge()).catch(reportEventError);
});

chrome.runtime.onStartup.addListener(() => {
  return runStateOperation(() => restoreWorkspaceOnStartup()).catch(reportEventError);
});

// onSuspend cannot finish async Chrome work reliably. Persist during live events.
initializeData().then(updateBadge).catch(reportEventError);

chrome.windows.onCreated.addListener(window => {
  const duringTransition = isSwitchingWorkspace;
  return runStateOperation(async () => {
    if (duringTransition || excludedWindowIds.has(window.id) || !activeWorkspaceId || !workspaces[activeWorkspaceId]) return;
    const workspace = workspaces[activeWorkspaceId];
    if (workspace.windowIds.includes(window.id)) return;
    // Late events for closed/source windows must not adopt them into the target.
    if (Object.entries(workspaces).some(([id, ws]) => id !== activeWorkspaceId && ws.windowIds?.includes(window.id))) return;
    try {
      await chrome.windows.get(window.id);
    } catch (error) {
      return; // Event can arrive after this window has already closed.
    }
    await saveAllWorkspaceWindows();
  }).catch(reportEventError);
});

setInterval(() => {
  return runStateOperation(async () => {
    if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return;
    // Cleanup already owns the queue; do not cancel pending active-tab saves.
    const allWindows = await chrome.windows.getAll();
    const workspace = workspaces[activeWorkspaceId];
    for (const window of allWindows) {
      if (workspace.windowIds.includes(window.id)) continue;
      const inactive = Object.entries(workspaces).some(([id, ws]) =>
        id !== activeWorkspaceId && ws.windowIds?.includes(window.id));
      if (inactive) await chrome.windows.remove(window.id);
    }
  }).catch(reportEventError);
}, 30000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const actions = {
    getWorkspaces: () => ({ workspaces, activeWorkspaceId }),
    getSettings: () => ({ settings, sharedPinnedTabs }),
    createWorkspace: () => createWorkspace(request.name, request.includeCurrentTabs, request.color),
    switchWorkspace: () => switchWorkspace(request.workspaceId),
    deleteWorkspace: () => deleteWorkspace(request.workspaceId),
    updateWorkspace: () => updateWorkspace(request.workspaceId, request.updates),
    updateWorkspaceColor: () => updateWorkspaceColor(request.workspaceId, request.color),
    renameWorkspace: () => renameWorkspace(request.workspaceId, request.name),
    exportBackup: () => exportBackup(),
    importBackup: () => importBackup(request.data),
    updateSettings: () => updateSettings(request.settings)
  };
  if (!Object.prototype.hasOwnProperty.call(actions, request.action)) return;
  runStateOperation(async () => {
    const mutating = !['getSettings', 'getWorkspaces', 'exportBackup'].includes(request.action);
    const atomicMutation = ['renameWorkspace', 'updateWorkspace', 'updateWorkspaceColor', 'updateSettings'].includes(request.action);
    userMutationInProgress = mutating;
    discardStartupOnSave = atomicMutation;
    try {
      const result = await actions[request.action]();
      if (mutating) {
        if (!atomicMutation) {
          discardStartupOnSave = true;
          await saveState();
        }
        startupState = null;
        startupSuperseded = true;
      }
      return result;
    } finally {
      discardStartupOnSave = false;
      userMutationInProgress = false;
    }
  })
    .then(sendResponse)
    .catch(error => sendResponse({ error: error.message }));
  return true;
});

// Prepare every replacement tab before touching source windows. Persist target
// ownership before removal, leaving outgoing snapshots durable if worker dies.
async function prepareWorkspaceWindows(workspace, preparedIds, fresh = false) {
  const windows = workspace.windows?.length ? workspace.windows : [
    { windowState: { state: 'maximized' }, tabs: [] }
  ];
  const operation = recoveryJournal;
  for (const [index, windowData] of windows.entries()) {
    const state = windowData.windowState || { state: 'normal' };
    const options = { focused: index === 0, state: 'normal' };
    if (state.state === 'normal' && state.width && state.height) {
      Object.assign(options, { left: state.left, top: state.top, width: state.width, height: state.height });
    }
    if (operation) options.url = markerUrl(operation.operationId, index);
    const window = await chrome.windows.create(options);
    preparedIds.push(window.id);
    if (operation) {
      operation.slots[index].id = window.id;
      await writeRecoveryJournal(operation);
      await chrome.tabs.update(window.tabs[0].id, { url: typeof restorableUrl === 'function' ? restorableUrl('chrome://newtab') : 'chrome://newtab' });
    }
    if (state.state && state.state !== 'normal') {
      await chrome.windows.update(window.id, { state: state.state });
    }
    const workspaceTabs = fresh && settings.sharePinnedTabs && sharedPinnedTabs.length ? [] : windowData.tabs;
    const tabs = settings.sharePinnedTabs ? [...sharedPinnedTabs, ...workspaceTabs] : workspaceTabs;
    const ordered = [...tabs.filter(tab => tab.pinned), ...tabs.filter(tab => !tab.pinned)];
    for (const tab of ordered) {
      await chrome.tabs.create({ windowId: window.id, url: restorableUrl(tab.url), pinned: tab.pinned || false });
    }
    if (ordered.length && window.tabs?.[0]) await chrome.tabs.remove(window.tabs[0].id);
  }
}

async function replaceWorkspaceWindows(workspaceId, sourceWindows, previousState, fresh = false) {
  const preparedIds = [];
  let committed = false;
  const workspace = workspaceId ? workspaces[workspaceId] : { windows: [] };
  const operationId = crypto.randomUUID();
  const operation = { operationId, sessionId: recoverySessionId, phase: 'preparing',
    sourceState: previousState, sourceIds: sourceWindows.map(window => window.id), targetId: workspaceId,
    slots: (workspace.windows?.length ? workspace.windows : [{ tabs: [] }]).map((_, index) => ({ index, id: null })) };
  await writeRecoveryJournal(operation);
  try {
    await prepareWorkspaceWindows(workspace, preparedIds, fresh);
    if (workspaceId) {
      workspace.windowIds = preparedIds;
      workspace.lastAccessed = Date.now();
    }
    activeWorkspaceId = workspaceId;
    const committedJournal = { ...operation, phase: 'committed', committedState: copyState() };
    const startup = userMutationInProgress
      ? { sessionId: recoverySessionId, state: null }
      : { sessionId: recoverySessionId, state: committedJournal.committedState };
    await chrome.storage.local.set({ ...committedJournal.committedState, [recoveryKey]: committedJournal, workspaceStartup: startup });
    recoveryMetadata = startup;
    startupState = startup.state;
    recoveryJournal = committedJournal;
    durableState = copyState();
    updateBadge();
    committed = true;
    for (const window of sourceWindows) excludedWindowIds.add(window.id);
    for (const window of sourceWindows) await chrome.windows.remove(window.id);
    const sourceIds = new Set(sourceWindows.map(window => window.id));
    for (const ws of Object.values(workspaces)) {
      ws.windowIds = ws.windowIds.filter(id => !sourceIds.has(id));
    }
    const finalizedJournal = { ...committedJournal, committedState: copyState() };
    await chrome.storage.local.set({ ...finalizedJournal.committedState, [recoveryKey]: finalizedJournal });
    recoveryJournal = finalizedJournal;
    durableState = copyState();
    await chrome.storage.local.remove(recoveryKey);
    recoveryJournal = null;
  } catch (error) {
    if (!committed) {
      applyState(previousState);
      for (const id of preparedIds) {
        excludedWindowIds.add(id);
        try {
          await chrome.windows.remove(id);
        } catch (cleanupError) {
          console.error('Could not remove incomplete replacement:', cleanupError);
        }
      }
      if (recoveryJournal) await recoverTransition();
    }
    // After commit, leave fully prepared target open. Outgoing snapshots remain
    // recoverable even if only some source windows closed or final save failed.
    throw error;
  }
}

// Create a new workspace
async function createWorkspace(name, includeCurrentTabs = false, color = '#667eea') {
  return withTransition(async () => {
    await saveAllWorkspaceWindows();
    const previousState = copyState();
    const allWindows = await chrome.windows.getAll({ populate: true });
    let workspaceId = Date.now().toString();
    while (workspaces[workspaceId]) workspaceId = (Number(workspaceId) + 1).toString();
    const firstWindow = allWindows[0];
    const template = firstWindow?.state === 'normal' ? {
      state: 'normal', left: firstWindow.left, top: firstWindow.top,
      width: firstWindow.width, height: firstWindow.height
    } : { state: firstWindow?.state || 'maximized' };
    const windowsData = includeCurrentTabs ? allWindows.map(window => {
      const tabs = window.tabs.filter(tab => typeof tab.url === 'string' && tab.url.length > 0 && !isBlankTab(tab.url) && (!settings.sharePinnedTabs || !tab.pinned))
        .map(tab => ({ url: tab.url, title: tab.title, pinned: tab.pinned || false }));
      return {
        windowId: window.id,
        windowState: window.state === 'normal' ? {
          state: 'normal', left: window.left, top: window.top, width: window.width, height: window.height
        } : { state: window.state },
        tabs: tabs.length ? tabs : [{ url: 'chrome://newtab', title: 'New Tab', pinned: false }]
      };
    }) : [{ windowState: template, tabs: [{ url: 'chrome://newtab', title: 'New Tab', pinned: false }] }];
    workspaces[workspaceId] = {
      id: workspaceId, name: name || `Workspace ${Object.keys(workspaces).length + 1}`,
      color: color || '#667eea', createdAt: Date.now(), lastAccessed: Date.now(),
      windowIds: [], windows: windowsData, tabs: windowsData.reduce((sum, window) => sum + window.tabs.length, 0)
    };
    if (includeCurrentTabs) {
      const adoptedIds = allWindows.map(window => window.id);
      for (const ws of Object.values(workspaces)) ws.windowIds = ws.windowIds.filter(id => !adoptedIds.includes(id));
      workspaces[workspaceId].windowIds = adoptedIds;
      activeWorkspaceId = workspaceId;
      await saveState();
    } else {
      await replaceWorkspaceWindows(workspaceId, allWindows, previousState, true);
    }
    return { success: true, workspaceId };
  });
}

// Internal switch helper can run inside delete/import's owned transition.
async function performWorkspaceSwitch(workspaceId, saveOutgoing = true) {
  if (!workspaces[workspaceId]) throw new Error('Workspace not found');
  if (saveOutgoing) await saveAllWorkspaceWindows();
  const previousState = copyState();
  const sourceWindows = await chrome.windows.getAll();
  await replaceWorkspaceWindows(workspaceId, sourceWindows, previousState);
  return { success: true };
}

async function switchWorkspace(workspaceId) {
  return withTransition(() => performWorkspaceSwitch(workspaceId));
}

async function deleteWorkspace(workspaceId) {
  if (!workspaces[workspaceId]) throw new Error('Workspace not found');
  return withTransition(async () => {
    const workspace = workspaces[workspaceId];
    if (activeWorkspaceId === workspaceId) {
      const remaining = Object.values(workspaces).filter(ws => ws.id !== workspaceId)
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (remaining.length) {
        await performWorkspaceSwitch(remaining[0].id);
      } else {
        await saveAllWorkspaceWindows();
        const previousState = copyState();
        const sourceWindows = await chrome.windows.getAll();
        delete workspaces[workspaceId];
        activeWorkspaceId = null;
        await replaceWorkspaceWindows(null, sourceWindows, previousState);
        return { success: true };
      }
    } else {
      const liveWindows = await chrome.windows.getAll();
      for (const window of liveWindows) {
        if (workspace.windowIds.includes(window.id)) await chrome.windows.remove(window.id);
      }
    }
    delete workspaces[workspaceId];
    await saveState();
    return { success: true };
  });
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

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return Object.prototype.toString.call(value) === '[object Object]' &&
    (prototype === null || Object.getPrototypeOf(prototype) === null);
}

function isSafeBackupKey(value) {
  return typeof value === 'string' && value.length > 0 &&
    !['__proto__', 'prototype', 'constructor'].includes(value) && /^[a-zA-Z0-9_-]+$/.test(value);
}

function isSafeBackupName(value) {
  return typeof value === 'string' && value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeBackupUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^data:/i.test(value)) return /^data:[^,]*,[\s\S]*$/i.test(value);
  if (/^(?:chrome|edge|dia):\/\//i.test(value)) {
    return /^(?:chrome:\/\/(?:newtab|new-tab-page)(?:[/?#].*)?|edge:\/\/newtab(?:[/?#].*)?|dia:\/\/new-tab-page(?:-third-party)?(?:[/?#].*)?)$/i.test(value);
  }
  if (/^about:/i.test(value)) return /^about:(?:blank|newtab)$/i.test(value);
  if (/^(?:chrome-extension|moz-extension|safari-web-extension):\/\//i.test(value)) {
    try {
      const parsedExtensionUrl = new URL(value);
      return parsedExtensionUrl.hostname.length > 0 && parsedExtensionUrl.pathname.length > 0;
    } catch (error) {
      return false;
    }
  }
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'file:', 'data:'].includes(parsed.protocol);
  } catch (error) {
    return false;
  }
}

function normalizeBackupTab(tab) {
  if (!isPlainRecord(tab) || !isSafeBackupUrl(tab.url) ||
      (tab.title !== undefined && typeof tab.title !== 'string') ||
      (tab.pinned !== undefined && typeof tab.pinned !== 'boolean')) return null;
  return { url: tab.url, title: tab.title || '', pinned: tab.pinned === true };
}

function normalizeBackupWindow(window) {
  if (!isPlainRecord(window) || !Array.isArray(window.tabs)) return null;
  const tabs = window.tabs.map(normalizeBackupTab);
  if (tabs.some(tab => !tab)) return null;
  let state = { state: 'normal' };
  if (window.windowState !== undefined) {
    if (!isPlainRecord(window.windowState) || !['normal', 'minimized', 'maximized', 'fullscreen'].includes(window.windowState.state)) return null;
    const { state: stateName, left, top, width, height } = window.windowState;
    const geometry = [left, top, width, height];
    const hasGeometry = geometry.some(value => value !== undefined);
    if (stateName === 'normal' && hasGeometry &&
        (geometry.some(value => typeof value !== 'number' || !Number.isFinite(value)) || width <= 0 || height <= 0)) return null;
    if (stateName !== 'normal' && hasGeometry) return null;
    state = { state: stateName };
    if (stateName === 'normal' && hasGeometry) Object.assign(state, { left, top, width, height });
  }
  return { windowState: state, tabs };
}

function normalizeBackupWorkspace(id, workspace) {
  if (!isSafeBackupKey(id) || !isPlainRecord(workspace) || workspace.id !== id ||
      !isSafeBackupName(workspace.name) || typeof workspace.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(workspace.color) ||
      !Number.isFinite(workspace.createdAt) || workspace.createdAt < 0 ||
      !Number.isFinite(workspace.lastAccessed) || workspace.lastAccessed < 0 ||
      !Array.isArray(workspace.windows) ||
      (workspace.windowIds !== undefined && (!Array.isArray(workspace.windowIds) ||
        workspace.windowIds.some(windowId => !Number.isSafeInteger(windowId) || windowId < 0))) ||
      (workspace.tabs !== undefined && !(Number.isSafeInteger(workspace.tabs) && workspace.tabs >= 0) && !Array.isArray(workspace.tabs))) return null;
  const windows = workspace.windows.map(normalizeBackupWindow);
  if (windows.some(window => !window)) return null;
  const tabs = Array.isArray(workspace.tabs) ? workspace.tabs.map(normalizeBackupTab) : null;
  if (tabs?.some(tab => !tab)) return null;
  return {
    id,
    name: workspace.name.trim(),
    color: workspace.color,
    createdAt: workspace.createdAt,
    lastAccessed: workspace.lastAccessed,
    windowIds: [],
    windows,
    tabs: tabs || windows.reduce((total, window) => total + window.tabs.length, 0)
  };
}

function normalizeBackupData(data) {
  if (!isPlainRecord(data) || (data.version !== undefined && data.version !== '1.0.1') ||
      !isPlainRecord(data.workspaces)) return null;
  if (data.timestamp !== undefined && (!Number.isFinite(data.timestamp) || data.timestamp < 0)) return null;
  if (data.activeWorkspaceId !== undefined && data.activeWorkspaceId !== null && !isSafeBackupKey(data.activeWorkspaceId)) return null;
  if (data.settings !== undefined && (!isPlainRecord(data.settings) ||
      (data.settings.sharePinnedTabs !== undefined && typeof data.settings.sharePinnedTabs !== 'boolean'))) return null;
  if (data.sharedPinnedTabs !== undefined && !Array.isArray(data.sharedPinnedTabs)) return null;
  const normalizedWorkspaces = {};
  for (const [id, workspace] of Object.entries(data.workspaces)) {
    const normalized = normalizeBackupWorkspace(id, workspace);
    if (!normalized) return null;
    normalizedWorkspaces[id] = normalized;
  }
  const pins = (data.sharedPinnedTabs || []).map(normalizeBackupTab);
  if (pins.some(tab => !tab)) return null;
  return {
    workspaces: normalizedWorkspaces,
    activeWorkspaceId: data.activeWorkspaceId || null,
    settings: { sharePinnedTabs: data.settings?.sharePinnedTabs === true },
    sharedPinnedTabs: pins.map(tab => ({ ...tab, pinned: true }))
  };
}

// Import backup
async function importBackup(data) {
  const normalized = normalizeBackupData(data);
  if (!normalized) throw new Error('Invalid backup data');
  return withTransition(async () => {
    await saveAllWorkspaceWindows();
    const previousState = copyState();
    const sourceWindows = await chrome.windows.getAll();
    settings = normalized.settings;
    sharedPinnedTabs = normalized.sharedPinnedTabs;
    workspaces = normalized.workspaces;
    if (settings.sharePinnedTabs) {
      for (const workspace of Object.values(workspaces)) {
        workspace.windows = workspace.windows.map(window => ({
          ...window,
          tabs: window.tabs.filter(tab => !tab.pinned)
        }));
      }
    }
    activeWorkspaceId = null;
    const workspaceArray = Object.values(workspaces);
    const target = workspaces[normalized.activeWorkspaceId] || workspaceArray
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (target) {
      await replaceWorkspaceWindows(target.id, sourceWindows, previousState);
    } else {
      await replaceWorkspaceWindows(null, sourceWindows, previousState);
    }
    return { success: true, count: workspaceArray.length };
  });
}

function collectSharedPinnedTabs(windows) {
  const pins = [];
  const maximumCounts = new Map();
  for (const window of windows) {
    const counts = new Map();
    for (const tab of window.tabs) {
      if (!tab.pinned || typeof tab.url !== 'string' || !tab.url || isBlankTab(tab.url)) continue;
      const count = (counts.get(tab.url) || 0) + 1;
      counts.set(tab.url, count);
      if (count > (maximumCounts.get(tab.url) || 0)) {
        pins.push({ url: tab.url, title: tab.title, pinned: true });
        maximumCounts.set(tab.url, count);
      }
    }
  }
  return pins;
}

// Update settings
async function updateSettings(newSettings) {
  const wasSharing = settings.sharePinnedTabs;
  settings = { ...settings, ...newSettings };

  if (wasSharing && !settings.sharePinnedTabs) {
    // Snapshot while shared mode is still active so the pending tab state and
    // current pin set are captured together, even before the normal save debounce.
    if (activeWorkspaceId && workspaces[activeWorkspaceId]) await saveAllWorkspaceWindows();
    const liveWindows = activeWorkspaceId && workspaces[activeWorkspaceId]
      ? (await chrome.windows.getAll({ populate: true }))
          .filter(window => !excludedWindowIds.has(window.id) && (workspaces[activeWorkspaceId].windowIds.includes(window.id) ||
            !Object.entries(workspaces).some(([id, ws]) => id !== activeWorkspaceId && ws.windowIds?.includes(window.id))))
      : [];
    const pinsToPreserve = (liveWindows.length > 0 ? collectSharedPinnedTabs(liveWindows) : sharedPinnedTabs)
      .map(tab => ({ ...tab, pinned: true }));
    for (const workspace of Object.values(workspaces)) {
      workspace.windows = (workspace.windows || []).map(window => ({
        ...window,
        tabs: [...pinsToPreserve.map(tab => ({ ...tab })), ...window.tabs.filter(tab => !tab.pinned)]
      }));
      if (workspace.windows.length === 0) {
        workspace.windows = [{
          windowState: { state: 'maximized' },
          tabs: pinsToPreserve.map(tab => ({ ...tab }))
        }];
      }
      workspace.tabs = workspace.windows.reduce((total, window) => total + window.tabs.length, 0);
    }
    sharedPinnedTabs = [];
    await saveState();
    return { success: true };
  }

  // If switching to shared pinned tabs mode, extract pinned tabs from active workspace
  if (settings.sharePinnedTabs && activeWorkspaceId && workspaces[activeWorkspaceId]) {
    const workspace = workspaces[activeWorkspaceId];
    const windows = (await chrome.windows.getAll({ populate: true }))
      .filter(window => !excludedWindowIds.has(window.id) && (workspace.windowIds.includes(window.id) ||
        !Object.entries(workspaces).some(([id, ws]) => id !== activeWorkspaceId && ws.windowIds?.includes(window.id))));
    // Without eligible live windows, fall back to the saved active snapshot so
    // stripping saved pins below cannot silently discard them.
    const collected = collectSharedPinnedTabs(windows.length > 0 ? windows : workspace.windows || []);
    if (windows.length > 0 || collected.length > 0) sharedPinnedTabs = collected;
    for (const ws of Object.values(workspaces)) {
      if (ws.windows) {
        for (const windowData of ws.windows) {
          windowData.tabs = windowData.tabs.filter(tab => !tab.pinned);
        }
        ws.tabs = ws.windows.reduce((total, window) => total + window.tabs.length, 0);
      }
    }
  }
  if (wasSharing && !settings.sharePinnedTabs && activeWorkspaceId && workspaces[activeWorkspaceId]) {
    await saveAllWorkspaceWindows();
    return { success: true };
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
  const allWindows = (await chrome.windows.getAll({ populate: true }))
    .filter(window => !excludedWindowIds.has(window.id) && (workspace.windowIds.includes(window.id) ||
      !Object.entries(workspaces).some(([id, ws]) => id !== activeWorkspaceId && ws.windowIds?.includes(window.id))));

  if (allWindows.length === 0) {
    workspace.windowIds = [];
    await saveState();
    return;
  }

  if (settings.sharePinnedTabs) sharedPinnedTabs = collectSharedPinnedTabs(allWindows);

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
      // Only save unpinned tabs to workspace (exclude blank tabs)
      windowTabs = window.tabs
        .filter(tab => !tab.pinned && typeof tab.url === 'string' && tab.url.length > 0 && !isBlankTab(tab.url))
        .map(tab => ({
          url: tab.url,
          title: tab.title,
          pinned: false
        }));
    } else {
      // Save all tabs including pinned (exclude blank tabs)
      windowTabs = window.tabs
        .filter(tab => typeof tab.url === 'string' && tab.url.length > 0 && !isBlankTab(tab.url))
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

// Save current workspace tabs (used for backup export)
async function saveCurrentWorkspaceTabs() {
  if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return;
  
  // Use the comprehensive saveAllWorkspaceWindows instead
  await saveAllWorkspaceWindows();
}

// Save current window state (size and position) - used for backup export
async function saveCurrentWindowState() {
  if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return;
  
  // Use the comprehensive saveAllWorkspaceWindows instead
  await saveAllWorkspaceWindows();
}

// Save state to storage
async function saveState() {
  const state = copyState();
  if (discardStartupOnSave) {
    const startup = { sessionId: recoverySessionId, state: null };
    await chrome.storage.local.set({ ...state, workspaceStartup: startup });
    recoveryMetadata = startup;
    startupState = null;
    startupSuperseded = true;
    durableState = state;
    updateBadge();
    return;
  }
  if (recoveryJournal) {
    if (recoveryJournal.phase === 'committed') recoveryJournal.committedState = state;
    await chrome.storage.local.set({ ...state, [recoveryKey]: recoveryJournal });
  } else {
    await chrome.storage.local.set(state);
  }
  durableState = state;
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

// Window removals update live IDs, not the recoverable saved windows.
chrome.windows.onRemoved.addListener(windowId => {
  return runStateOperation(async () => {
    let changed = false;
    for (const workspace of Object.values(workspaces)) {
      if (workspace.windowIds.includes(windowId)) {
        workspace.windowIds = workspace.windowIds.filter(id => id !== windowId);
        changed = true;
      }
    }
    if (changed) await saveState();
  }).catch(reportEventError);
});

chrome.windows.onBoundsChanged?.addListener(window => scheduleWorkspaceSave(window.id));
chrome.tabs.onCreated.addListener(tab => scheduleWorkspaceSave(tab.windowId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (['url', 'title', 'pinned', 'status'].some(key => Object.prototype.hasOwnProperty.call(changeInfo, key))) {
    return scheduleWorkspaceSave(tab.windowId);
  }
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (!info.isWindowClosing) return scheduleWorkspaceSave(info.windowId);
  return runStateOperation(() => {}).catch(reportEventError);
});
chrome.tabs.onMoved.addListener((tabId, info) => scheduleWorkspaceSave(info.windowId));
chrome.tabs.onAttached.addListener((tabId, info) => scheduleWorkspaceSave(info.newWindowId));
chrome.tabs.onDetached.addListener((tabId, info) => scheduleWorkspaceSave(info.oldWindowId));

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
      workspace.windowIds = [window.id];
      activeWorkspaceId = id;
    } else {
      return;
    }
  }
  
  const workspace = workspaces[activeWorkspaceId];
  
  // Always update window IDs to ensure association
  if (!workspace.windowIds) {
    workspace.windowIds = [];
  }
  if (!workspace.windowIds.includes(window.id)) {
    workspace.windowIds = [window.id];
  }
  
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
  
  // Restore window dimensions from the workspace windows array
  if (!workspace.windows || workspace.windows.length === 0) {
    await saveState();
    return;
  }

  // Find the first saved window state (since this is startup, we're restoring to the first window)
  const savedWindowState = workspace.windows[0].windowState;
  if (!savedWindowState) {
    await saveState();
    return;
  }
  
  const updateInfo = {};
  
  if (savedWindowState.state === 'normal' &&
      savedWindowState.width &&
      savedWindowState.height) {
    // Restore normal state with dimensions (including position/display)
    updateInfo.state = 'normal';
    updateInfo.left = savedWindowState.left;
    updateInfo.top = savedWindowState.top;
    updateInfo.width = savedWindowState.width;
    updateInfo.height = savedWindowState.height;
  } else if (savedWindowState.state) {
    // Restore maximized or fullscreen state
    updateInfo.state = savedWindowState.state;
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

// Restore workspace windows on startup - overrides Chrome's startup behavior
async function restoreWorkspaceOnStartup() {
  if (!startupState) return;
  const initialState = startupState;
  const workspace = initialState.workspaces[initialState.activeWorkspaceId];
  // No valid saved target: Chrome's own session is safer than a blank replacement.
  const valid = workspace && Array.isArray(workspace.windows) && workspace.windows.length > 0 &&
    workspace.windows.every(window => window && window.windowState && Array.isArray(window.tabs) &&
      window.tabs.every(tab => tab && typeof tab.url === 'string' && tab.url.length > 0));
  if (!valid) {
    startupState = null;
    return;
  }
  applyState(initialState);
  // Earlier startup events may have adopted Chrome's session. Re-establish the
  // original durable target before any restoration API can fail.
  await saveState();
  // Unlike an explicit switch, startup must not snapshot Chrome's unrelated
  // startup session over the stored workspace it is about to restore.
  await withTransition(() => performWorkspaceSwitch(activeWorkspaceId, false));
  await chrome.storage.local.remove('workspaceStartup');
  recoveryMetadata = null;
  startupState = null;
  return { success: true };
}

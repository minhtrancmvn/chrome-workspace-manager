// Popup script for Workspace Manager

let workspaces = {};
let activeWorkspaceId = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadSettings();
  await loadWorkspaces();
});

// Setup event listeners
function setupEventListeners() {
  document.getElementById('createBtn').addEventListener('click', createWorkspace);
  document.getElementById('workspaceName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createWorkspace();
  });
  document.getElementById('exportBtn').addEventListener('click', exportBackup);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', importBackup);
  document.getElementById('sharePinnedTabs').addEventListener('change', updateSettings);
}

// Load settings
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
      if (response && response.settings) {
        document.getElementById('sharePinnedTabs').checked = response.settings.sharePinnedTabs || false;
      }
      resolve();
    });
  });
}

// Update settings
function updateSettings() {
  const sharePinnedTabs = document.getElementById('sharePinnedTabs').checked;
  
  chrome.runtime.sendMessage({
    action: 'updateSettings',
    settings: { sharePinnedTabs }
  }, (response) => {
    if (response && response.success) {
      // Show brief confirmation
      const checkbox = document.getElementById('sharePinnedTabs');
      const label = checkbox.parentElement;
      label.style.backgroundColor = '#e8f5e9';
      setTimeout(() => {
        label.style.backgroundColor = '';
      }, 500);
    }
  });
}

// Load workspaces from background
async function loadWorkspaces() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getWorkspaces' }, (response) => {
      if (response) {
        workspaces = response.workspaces || {};
        activeWorkspaceId = response.activeWorkspaceId;
        console.log('Loaded workspaces:', Object.keys(workspaces).length, 'Active:', activeWorkspaceId);
        console.log('Active workspace name:', workspaces[activeWorkspaceId]?.name);
        renderWorkspaces();
      }
      resolve();
    });
  });
}

// Render workspaces list
function renderWorkspaces() {
  const workspacesList = document.getElementById('workspacesList');
  const emptyState = document.getElementById('emptyState');
  
  workspacesList.innerHTML = '';
  
  const workspaceArray = Object.values(workspaces);
  
  if (workspaceArray.length === 0) {
    emptyState.style.display = 'block';
    workspacesList.style.display = 'none';
    return;
  }
  
  emptyState.style.display = 'none';
  workspacesList.style.display = 'flex';
  
  // Sort by last accessed
  workspaceArray.sort((a, b) => b.lastAccessed - a.lastAccessed);
  
  workspaceArray.forEach(workspace => {
    const workspaceItem = createWorkspaceElement(workspace);
    workspacesList.appendChild(workspaceItem);
  });
}

// Create workspace element
function createWorkspaceElement(workspace) {
  const div = document.createElement('div');
  div.className = 'workspace-item';
  if (workspace.id === activeWorkspaceId) {
    div.classList.add('active');
  }
  
  // Tab count is now stored directly as a number, or calculate from tabs array/windows array
  let tabCount = 0;
  if (typeof workspace.tabs === 'number') {
    tabCount = workspace.tabs;
  } else if (workspace.tabs && Array.isArray(workspace.tabs)) {
    tabCount = workspace.tabs.length;
  } else if (workspace.windows && Array.isArray(workspace.windows)) {
    tabCount = workspace.windows.reduce((sum, w) => sum + (w.tabs ? w.tabs.length : 0), 0);
  }
  
  const windowCount = workspace.windows ? workspace.windows.length : (workspace.windowIds ? workspace.windowIds.length : 1);
  const lastAccessed = formatDate(workspace.lastAccessed);
  const workspaceColor = workspace.color || '#667eea';
  
  div.innerHTML = `
    <div class="workspace-color-indicator" style="background-color: ${workspaceColor}"></div>
    <div class="workspace-info">
      <div class="workspace-name">
        <span class="workspace-name-text">${escapeHtml(workspace.name)}</span>
        <input type="text" class="workspace-name-input" value="${escapeHtml(workspace.name)}" style="display: none;">
        ${workspace.id === activeWorkspaceId ? '<span class="badge">ACTIVE</span>' : ''}
      </div>
      <div class="workspace-meta">
        <div class="meta-line">${windowCount} window${windowCount !== 1 ? 's' : ''} • ${tabCount} tab${tabCount !== 1 ? 's' : ''}</div>
        <div class="meta-line">Last accessed: ${lastAccessed}</div>
      </div>
    </div>
    <div class="workspace-actions">
      <button class="btn-edit" data-id="${workspace.id}" title="Rename workspace">
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path opacity="0.2" d="M24 15.0002L17 8.00016L20.7075 4.29266C20.895 4.10527 21.1493 4 21.4144 4C21.6795 4 21.9337 4.10527 22.1213 4.29266L27.7075 9.87516C27.8949 10.0627 28.0002 10.3169 28.0002 10.582C28.0002 10.8471 27.8949 11.1014 27.7075 11.2889L24 15.0002Z" fill="currentColor"/>
          <path d="M11.5863 27.0002H6C5.73478 27.0002 5.48043 26.8948 5.29289 26.7073C5.10536 26.5197 5 26.2654 5 26.0002V20.4139C5.00012 20.149 5.10532 19.8951 5.2925 19.7077L20.7075 4.29266C20.895 4.10527 21.1493 4 21.4144 4C21.6795 4 21.9337 4.10527 22.1213 4.29266L27.7075 9.87516C27.8949 10.0627 28.0002 10.3169 28.0002 10.582C28.0002 10.8471 27.8949 11.1014 27.7075 11.2889L12.2925 26.7077C12.1051 26.8948 11.8511 27 11.5863 27.0002Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M17 8L24 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M20.5 11.5L8.5 23.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M11.9362 26.936L5.06372 20.0635" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <input type="color" class="color-picker" value="${workspaceColor}" data-id="${workspace.id}" title="Change workspace color">
      <button class="btn-delete" data-id="${workspace.id}" title="Delete workspace">
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path opacity="0.2" d="M25 7V26C25 26.2652 24.8946 26.5196 24.7071 26.7071C24.5196 26.8946 24.2652 27 24 27H8C7.73478 27 7.48043 26.8946 7.29289 26.7071C7.10536 26.5196 7 26.2652 7 26V7H25Z" fill="currentColor"/>
          <path d="M27 7H5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M13 13V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M19 13V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M25 7V26C25 26.2652 24.8946 26.5196 24.7071 26.7071C24.5196 26.8946 24.2652 27 24 27H8C7.73478 27 7.48043 26.8946 7.29289 26.7071C7.10536 26.5196 7 26.2652 7 26V7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M21 7V5C21 4.46957 20.7893 3.96086 20.4142 3.58579C20.0391 3.21071 19.5304 3 19 3H13C12.4696 3 11.9609 3.21071 11.5858 3.58579C11.2107 3.96086 11 4.46957 11 5V7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  `;
  
  // Add event listeners
  const editBtn = div.querySelector('.btn-edit');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    startRenameWorkspace(workspace.id, div);
  });
  
  const colorPicker = div.querySelector('.color-picker');
  colorPicker.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  colorPicker.addEventListener('change', (e) => {
    e.stopPropagation();
    updateWorkspaceColor(workspace.id, e.target.value);
  });
  
  const deleteBtn = div.querySelector('.btn-delete');
  deleteBtn.addEventListener('click', (e) => {
    console.log('Delete button clicked!');
    e.stopPropagation();
    e.preventDefault();
    deleteWorkspace(workspace.id);
  });
  
  // Click on workspace to switch (unless it's already active)
  if (workspace.id !== activeWorkspaceId) {
    div.style.cursor = 'pointer';
    div.addEventListener('click', (e) => {
      // Don't switch if clicking on buttons or inputs
      if (e.target.closest('.btn-edit') || 
          e.target.closest('.btn-delete') || 
          e.target.closest('.color-picker') || 
          e.target.closest('button') ||
          e.target.closest('input')) {
        console.log('Click on button/input, ignoring workspace switch');
        return;
      }
      console.log('Switching workspace from card click');
      switchWorkspace(workspace.id);
    });
  } else {
    div.style.cursor = 'default';
  }
  
  return div;
}

// Start renaming a workspace
function startRenameWorkspace(workspaceId, workspaceElement) {
  const nameText = workspaceElement.querySelector('.workspace-name-text');
  const nameInput = workspaceElement.querySelector('.workspace-name-input');
  
  if (!nameText || !nameInput) {
    console.error('Could not find name elements');
    return;
  }
  
  // Show input, hide text
  nameText.style.display = 'none';
  nameInput.style.display = 'inline-block';
  nameInput.focus();
  nameInput.select();
  
  // Save on Enter
  const saveRename = () => {
    const newName = nameInput.value.trim();
    if (newName && newName !== nameText.textContent) {
      renameWorkspace(workspaceId, newName);
    } else {
      // Revert if empty or unchanged
      nameText.style.display = 'inline';
      nameInput.style.display = 'none';
    }
  };
  
  // Save on Enter key
  nameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    }
  });
  
  // Save on blur
  nameInput.addEventListener('blur', saveRename, { once: true });
  
  // Cancel on Escape
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      nameInput.value = nameText.textContent;
      nameText.style.display = 'inline';
      nameInput.style.display = 'none';
    }
  });
}

// Rename workspace
function renameWorkspace(workspaceId, newName) {
  console.log('Renaming workspace:', workspaceId, 'to:', newName);
  
  chrome.runtime.sendMessage({
    action: 'renameWorkspace',
    workspaceId: workspaceId,
    name: newName
  }, (response) => {
    console.log('Rename response:', response);
    
    // Check for Chrome runtime errors
    if (chrome.runtime.lastError) {
      console.error('Chrome runtime error:', chrome.runtime.lastError);
      alert('Failed to rename workspace: ' + chrome.runtime.lastError.message);
      return;
    }
    
    if (response && response.success) {
      console.log('Workspace renamed successfully');
      loadWorkspaces(); // Reload to show new name
    } else {
      console.error('Failed to rename workspace:', response?.error);
      alert('Failed to rename workspace: ' + (response?.error || 'Unknown error'));
    }
  });
}

// Create new workspace
function createWorkspace() {
  const nameInput = document.getElementById('workspaceName');
  const colorInput = document.getElementById('workspaceColor');
  const includeCurrentTabs = document.getElementById('includeCurrentTabs').checked;
  const name = nameInput.value.trim();
  const color = colorInput.value;
  
  if (!name) {
    alert('Please enter a workspace name');
    return;
  }
  
  console.log('Creating workspace with includeCurrentTabs:', includeCurrentTabs);
  
  chrome.runtime.sendMessage({
    action: 'createWorkspace',
    name: name,
    includeCurrentTabs: includeCurrentTabs,
    color: color
  }, (response) => {
    if (response.error) {
      alert('Error creating workspace: ' + response.error);
    } else {
      console.log('Workspace created successfully:', response);
      
      // Reset form and reload
      nameInput.value = '';
      colorInput.value = '#667eea'; // Reset to default
      loadWorkspaces();
    }
  });
}

// Update workspace color
function updateWorkspaceColor(workspaceId, color) {
  chrome.runtime.sendMessage({
    action: 'updateWorkspaceColor',
    workspaceId: workspaceId,
    color: color
  }, (response) => {
    if (response.error) {
      alert('Error updating color: ' + response.error);
    } else {
      loadWorkspaces();
    }
  });
}

// Switch to workspace
function switchWorkspace(workspaceId) {
  chrome.runtime.sendMessage({
    action: 'switchWorkspace',
    workspaceId: workspaceId
  }, (response) => {
    if (response.error) {
      alert('Error switching workspace: ' + response.error);
    } else {
      // Close popup after switching
      window.close();
    }
  });
}

// Delete workspace
function deleteWorkspace(workspaceId) {
  console.log('deleteWorkspace called from popup:', workspaceId);
  const workspace = workspaces[workspaceId];
  if (!workspace) {
    console.error('Workspace not found in popup cache:', workspaceId);
    return;
  }
  
  console.log('Confirming deletion of:', workspace.name);
  if (confirm(`Delete workspace "${workspace.name}"?`)) {
    console.log('User confirmed deletion, sending message to background...');
    chrome.runtime.sendMessage({
      action: 'deleteWorkspace',
      workspaceId: workspaceId
    }, (response) => {
      console.log('Response received from background:', response);
      
      if (chrome.runtime.lastError) {
        console.error('Runtime error:', chrome.runtime.lastError);
        alert('Error deleting workspace: ' + chrome.runtime.lastError.message);
        return;
      }
      
      if (!response) {
        console.error('No response received from background');
        alert('Error: No response from background script');
        return;
      }
      
      if (response.error) {
        console.error('Delete error from background:', response.error);
        alert('Error deleting workspace: ' + response.error);
      } else {
        console.log('Delete successful, reloading workspaces...');
        // Wait a moment for the workspace to be deleted before reloading
        setTimeout(() => {
          loadWorkspaces();
        }, 100);
      }
    });
  } else {
    console.log('User cancelled deletion');
  }
}

// Format date
function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  
  return date.toLocaleDateString();
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Export backup
function exportBackup() {
  chrome.runtime.sendMessage({ action: 'exportBackup' }, (response) => {
    if (response.error) {
      alert('Error exporting backup: ' + response.error);
      return;
    }
    
    const data = response.data;
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `workspace-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // Show success message
    const exportBtn = document.getElementById('exportBtn');
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = '✓ Exported!';
    exportBtn.disabled = true;
    setTimeout(() => {
      exportBtn.innerHTML = originalText;
      exportBtn.disabled = false;
    }, 2000);
  });
}

// Import backup
function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      
      // Confirm before importing
      const workspaceCount = Object.keys(data.workspaces || {}).length;
      if (!confirm(`Import ${workspaceCount} workspace(s)? This will close all current windows and replace your existing workspaces.`)) {
        return;
      }
      
      chrome.runtime.sendMessage({ 
        action: 'importBackup',
        data: data
      }, (response) => {
        if (response.error) {
          alert('Error importing backup: ' + response.error);
        } else {
          // Reload settings and close popup as windows will be recreated
          loadSettings().then(() => {
            window.close();
          });
        }
      });
    } catch (error) {
      alert('Error reading backup file: ' + error.message);
    }
  };
  reader.readAsText(file);
  
  // Reset file input
  event.target.value = '';
}

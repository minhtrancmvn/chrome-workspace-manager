const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.classList = { add: name => { this.className += ` ${name}`; } };
  }
  set innerHTML(value) {
    this.markup = value;
    this.children = [];
    this.nodes = {};
    for (const match of value.matchAll(/<(\w+)[^>]*class="([^"]+)"[^>]*>/g)) {
      const node = new Element(match[1]);
      node.className = match[2];
      for (const name of match[2].split(' ')) this.nodes[`.${name}`] = node;
    }
  }
  get innerHTML() { return this.markup || ''; }
  querySelector(selector) { return this.nodes?.[selector] || null; }
  appendChild(child) { this.children.push(child); child.parentElement = this; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  click() {
    for (const listener of this.listeners.click || []) listener({ target: this, stopPropagation() {}, preventDefault() {} });
  }
  closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
}

function harness() {
  const ids = Object.fromEntries(['sharePinnedTabs', 'workspacesList', 'emptyState', 'workspaceName',
    'workspaceColor', 'includeCurrentTabs', 'exportBtn'].map(id => [id, new Element()]));
  ids.sharePinnedTabs.parentElement = new Element();
  const alerts = [];
  const messages = [];
  let reply = { workspaces: {}, activeWorkspaceId: null };
  let error;
  let closes = 0;
  const runtime = {
    sendMessage(request, callback) {
      messages.push(request);
      runtime.lastError = error ? { message: error } : undefined;
      try { callback(reply); } finally { runtime.lastError = undefined; }
    }
  };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => ids[id], createElement: tag => new Element(tag) },
    chrome: { runtime }, alert: message => alerts.push(message), confirm: () => true,
    window: { close: () => { closes++; } }, console: { log() {}, error() {} },
    setTimeout() {}, Date, Blob, URL
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8'), context);
  return { ids, alerts, messages, context, run: code => vm.runInContext(code, context),
    reply(value, lastError) { reply = value; error = lastError; }, closes: () => closes };
}

const hostileWorkspace = { id: 'x" autofocus data-injected="yes', name: 'Name " <img src=x>',
  color: '#112233" data-injected="yes', tabs: 1, windows: [], lastAccessed: 1 };

test('workspace data never enters HTML markup or attribute syntax', () => {
  const env = harness();
  const card = env.run(`createWorkspaceElement(${JSON.stringify(hostileWorkspace)})`);
  assert.equal(card.innerHTML.includes('data-injected'), false);
  assert.equal(card.querySelector('.workspace-name-text').textContent, hostileWorkspace.name);
  assert.equal(card.querySelector('.workspace-name-input').value, hostileWorkspace.name);
  assert.equal(card.querySelector('.color-picker').value, '#667eea');
  assert.equal(card.querySelector('.btn-edit').dataset.id, hostileWorkspace.id);
});

test('legacy metadata cannot inject attributes through workspace markup', () => {
  const env = harness();
  const workspace = { ...hostileWorkspace, id: 'safe', color: '#123456',
    windows: { length: '<img data-injected="yes">' }, tabs: 1 };
  const card = env.run(`createWorkspaceElement(${JSON.stringify(workspace)})`);
  assert.equal(card.innerHTML.includes('data-injected'), false);
  assert.equal(card.querySelector('.workspace-count').textContent.includes('<img data-injected="yes">'), true);
});

test('workspace switching uses native named button distinct from edit controls', () => {
  const env = harness();
  env.reply({ success: true });
  const card = env.run(`createWorkspaceElement(${JSON.stringify({ ...hostileWorkspace, id: 'b', color: '#123456' })})`);
  const button = card.querySelector('.workspace-name-text');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('aria-label'), `Switch to workspace ${hostileWorkspace.name}`);
  button.click();
  assert.equal(env.messages[0].action, 'switchWorkspace');
  assert.equal(env.messages[0].workspaceId, 'b');
});

test('active workspace name button does not request another switch', () => {
  const env = harness();
  env.run("activeWorkspaceId = 'a'");
  const card = env.run("createWorkspaceElement({ id: 'a', name: 'Active', color: '#123456', tabs: 1, windows: [], lastAccessed: 1 })");
  const button = card.querySelector('.workspace-name-text');
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(env.messages.length, 0);
});

test('successful workspace load replaces cache and renders safe names', async () => {
  const env = harness();
  env.reply({ workspaces: { a: { id: 'a', name: 'Name < > "', color: '#123456', tabs: 1, windows: [], lastAccessed: 1 } }, activeWorkspaceId: 'a' });
  await env.run('loadWorkspaces()');
  assert.equal(env.run('activeWorkspaceId'), 'a');
  assert.equal(env.ids.workspacesList.children.length, 1);
  assert.equal(env.ids.workspacesList.children[0].querySelector('.workspace-name-text').textContent, 'Name < > "');
  assert.equal(env.alerts.length, 0);
});

test('successful settings mutation remembers state for subsequent failed retry', () => {
  const env = harness();
  env.ids.sharePinnedTabs.checked = true;
  env.reply({ success: true });
  env.run('updateSettings()');
  assert.equal(env.ids.sharePinnedTabs.disabled, false);
  env.ids.sharePinnedTabs.checked = false;
  env.reply({ error: 'Cannot save' });
  env.run('updateSettings()');
  assert.equal(env.ids.sharePinnedTabs.checked, true);
  assert.match(env.alerts[0], /Cannot save/);
});

for (const action of ['loadSettings', 'loadWorkspaces']) {
  test(`${action} reports transport failure and preserves cached state`, async () => {
    const env = harness();
    env.run('workspaces = { a: { id: "a", name: "Saved" } }; activeWorkspaceId = "a";');
    env.ids.sharePinnedTabs.checked = true;
    env.reply(undefined, 'Background unavailable');
    await env.run(`${action}()`);
    assert.equal(env.alerts.length, 1);
    assert.match(env.alerts[0], /Background unavailable/);
    assert.equal(env.run('activeWorkspaceId'), 'a');
    assert.equal(env.ids.sharePinnedTabs.checked, true);
  });
}

test('background error response does not erase cached workspace list', async () => {
  const env = harness();
  env.run('workspaces = { a: { id: "a", name: "Saved" } }; activeWorkspaceId = "a";');
  env.reply({ error: 'Storage failed' });
  await env.run('loadWorkspaces()');
  assert.equal(env.run('activeWorkspaceId'), 'a');
  assert.equal(env.run('workspaces.a.name'), 'Saved');
  assert.match(env.alerts[0], /Storage failed/);
});

for (const failure of [{ response: undefined }, { response: undefined, error: 'Disconnected' }, { response: {} }]) {
  test(`switch failure ${JSON.stringify(failure)} keeps popup open`, () => {
    const env = harness();
    env.reply(failure.response, failure.error);
    assert.doesNotThrow(() => env.run("switchWorkspace('b')"));
    assert.equal(env.closes(), 0);
    assert.equal(env.alerts.length, 1);
  });
}

for (const action of ['createWorkspace()', "updateWorkspaceColor('a', '#112233')", 'exportBackup()', "renameWorkspace('a', 'Renamed')", "deleteWorkspace('a')"]) {
  test(`${action} reports transport failure without clearing form`, () => {
    const env = harness();
    env.run('workspaces = { a: { id: "a", name: "Saved" } };');
    env.ids.workspaceName.value = 'New workspace';
    env.ids.workspaceColor.value = '#112233';
    env.reply(undefined, 'Disconnected');
    assert.doesNotThrow(() => env.run(action));
    assert.equal(env.alerts.length, 1);
    assert.match(env.alerts[0], /Disconnected/);
    assert.equal(env.ids.workspaceName.value, 'New workspace');
    assert.equal(env.closes(), 0);
  });
}

test('failed backup import reports transport error and keeps popup open', () => {
  const env = harness();
  env.context.FileReader = class {
    readAsText() { this.onload({ target: { result: '{"workspaces":{}}' } }); }
  };
  env.reply(undefined, 'Import disconnected');
  assert.doesNotThrow(() => env.run('importBackup({ target: { files: [{}], value: "backup.json" } })'));
  assert.match(env.alerts[0], /Import disconnected/);
  assert.equal(env.closes(), 0);
});

test('failed settings mutation restores checkbox and allows retry', () => {
  const env = harness();
  env.ids.sharePinnedTabs.checked = false;
  env.reply({ settings: { sharePinnedTabs: false } });
  env.run('loadSettings()');
  env.ids.sharePinnedTabs.checked = true;
  env.reply(undefined, 'Settings failed');
  env.run('updateSettings()');
  assert.equal(env.ids.sharePinnedTabs.checked, false);
  assert.equal(env.ids.sharePinnedTabs.disabled, false);
  assert.match(env.alerts[0], /Settings failed/);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const adapterSource = fs.readFileSync(path.join(root, 'browser-api.js'), 'utf8');
const stagingScript = path.join(root, 'scripts', 'prepare-browser.cjs');

function loadAdapter({ browser, chrome }) {
  const sandbox = { browser, chrome, Promise, WeakMap, Map, Proxy };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(adapterSource, sandbox, { filename: 'browser-api.js' });
  return sandbox;
}

test('Chrome API objects remain untouched when browser namespace is absent', async () => {
  const chrome = { runtime: { sendMessage() {} } };
  const sandbox = loadAdapter({ chrome });
  assert.equal(sandbox.chrome, chrome);

  const sharedChrome = { runtime: { sendMessage() {} } };
  const sharedSandbox = loadAdapter({ browser: sharedChrome, chrome: sharedChrome });
  assert.equal(sharedSandbox.chrome, sharedChrome);
});

test('Firefox methods support existing Promise callers and preserve event objects', async () => {
  const event = { addListener() {} };
  const promiseMethod = async value => value;
  const browser = { runtime: { onMessage: event, sendMessage: promiseMethod } };
  const chrome = { runtime: { onMessage: event, sendMessage: promiseMethod } };
  const sandbox = loadAdapter({ browser, chrome });
  assert.equal(sandbox.chrome.runtime.onMessage, event);
  assert.deepEqual(await sandbox.chrome.runtime.sendMessage({ action: 'getSettings' }), {
    action: 'getSettings'
  });
});

test('Firefox storage local and session APIs support Promise callers', async () => {
  const browser = {
    runtime: { sendMessage() {} },
    storage: {
      local: { get: async keys => ({ keys }), set: async value => value },
      session: { get: async keys => ({ keys }), set: async value => value }
    }
  };
  const chrome = {
    runtime: { sendMessage() {} },
    storage: {
      local: { get() {}, set() {} },
      session: { get() {}, set() {} }
    }
  };
  const sandbox = loadAdapter({ browser, chrome });
  assert.deepEqual(await sandbox.chrome.storage.local.get(['workspaces']), { keys: ['workspaces'] });
  assert.deepEqual(await sandbox.chrome.storage.session.get(['activeWorkspaceId']), {
    keys: ['activeWorkspaceId']
  });
});

test('Firefox methods support existing callback callers and callback lastError checks', async () => {
  const failure = new Error('No window with id: 42.');
  const browser = {
    windows: {
      get(id) {
        return id === 42 ? Promise.reject(failure) : Promise.resolve({ id });
      }
    },
    runtime: {}
  };
  const chrome = { windows: { get() {} }, runtime: {} };
  const sandbox = loadAdapter({ browser, chrome });
  const result = await new Promise(resolve => {
    sandbox.chrome.windows.get(7, window => resolve(window));
  });
  assert.deepEqual(result, { id: 7 });

  const error = await new Promise(resolve => {
    sandbox.chrome.windows.get(42, window => {
      resolve({ window, error: sandbox.chrome.runtime.lastError });
    });
  });
  assert.equal(error.window, undefined);
  assert.equal(error.error, failure);
  assert.equal(sandbox.chrome.runtime.lastError, undefined);
});

test('action methods map to Firefox browserAction namespace', async () => {
  const calls = [];
  const browser = {
    runtime: { sendMessage() {} },
    browserAction: {
      setBadgeText(options) { calls.push(['text', options]); return Promise.resolve(); },
      setBadgeBackgroundColor(options) { calls.push(['color', options]); return Promise.resolve(); }
    },
    action: undefined
  };
  const chrome = { action: { setBadgeText() {}, setBadgeBackgroundColor() {} } };
  const sandbox = loadAdapter({ browser, chrome });
  await sandbox.chrome.action.setBadgeText({ text: 'ABC' });
  await sandbox.chrome.action.setBadgeBackgroundColor({ color: '#123456' });
  assert.deepEqual(calls, [
    ['text', { text: 'ABC' }],
    ['color', { color: '#123456' }]
  ]);
});

test('stager builds a Firefox-only runtime allowlist without packaging a ZIP', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-manager-compat-'));
  const stage = path.join(temporaryRoot, 'firefox');
  try {
    const result = spawnSync(process.execPath, [stagingScript, 'firefox', stage], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.background, { scripts: ['browser-api.js', 'background.js'] });
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '115.0');
    assert.equal(manifest.browser_specific_settings.gecko.id, 'workspace-manager@local');
    assert.equal('minimum_chrome_version' in manifest, false);
    assert.equal('service_worker' in manifest.background, false);
    assert.equal(fs.existsSync(path.join(stage, 'background.js')), true);
    assert.equal(fs.existsSync(path.join(stage, 'popup.js')), true);
    assert.equal(fs.existsSync(path.join(stage, 'browser-api.js')), true);
    assert.equal(fs.existsSync(path.join(stage, 'README.md')), false);
    assert.match(fs.readFileSync(path.join(stage, 'popup.html'), 'utf8'),
      /<script src="browser-api\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
    assert.equal(fs.existsSync(path.join(stage, 'workspace-manager.zip')), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('stager refuses to overwrite a pre-existing destination', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-manager-compat-safe-'));
  const stage = path.join(temporaryRoot, 'not-empty');
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'keep.txt'), 'keep');
  try {
    const result = spawnSync(process.execPath, [stagingScript, 'firefox', stage], {
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.equal(fs.readFileSync(path.join(stage, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('stager refuses destinations inside repository', () => {
  const result = spawnSync(process.execPath, [stagingScript, 'firefox', path.join(root, '.tmp-stage')], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the repository/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const pump = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let sessionSequence = 0;
function saved(id, url = `https://${id}.test/`, overrides = {}) {
  return { id, name: id.toUpperCase(), color: '#667eea', createdAt: 1, lastAccessed: 1,
    windowIds: id === 'a' ? [1] : [], tabs: 1,
    windows: [{ windowId: 1, windowState: { state: 'normal', left: 0, top: 0, width: 900, height: 700 },
      tabs: [{ url, title: id, pinned: false }] }], ...overrides };
}
function live(id = 1, urls = ['https://live.test/']) {
  return { id, state: 'normal', left: 10, top: 20, width: 1000, height: 800,
    tabs: urls.map((url, index) => ({ id: id * 100 + index, windowId: id, index, url, title: url, pinned: false })) };
}
function harness({ data = { workspaces: { a: saved('a'), b: saved('b') }, activeWorkspaceId: 'a' },
  windows = [live()], delayedLoad = false, loadError = false, shared = null, firefox = false } = {}) {
  let stored = shared?.stored || copy(data);
  let local = shared?.local || {};
  let currentLoadError = loadError;
  let crashed = false;
  let sessionStored = shared?.sessionStored || {};
  const sessionIdentity = shared?.sessionIdentity || `session-${++sessionSequence}`;
  const open = new Map(copy(windows).map(window => [window.id, window]));
  let nextWindow = Math.max(10, ...[...open.keys()].map(id => id + 1));
  let nextTab = 10000;
  let loadCallback;
  let nextTimer = 1;
  const timers = new Map();
  const intervals = [];
  const browserEvents = [];
  const calls = [];
  const storageWrites = [];
  const failures = new Map();
  const gates = new Map();
  const afterGates = new Map();
  const logs = [];
  function event() {
    const listeners = [];
    return { listeners, addListener(fn) { listeners.push(fn); },
      emit(...args) { return listeners.map(fn => fn(...copy(args))); } };
  }
  async function api(name, args, action) {
    calls.push({ name, args: copy(args) });
    const gate = gates.get(name);
    if (gate) { gates.delete(name); await gate.promise; }
    if (crashed) throw new Error('Worker terminated');
    const failure = failures.get(name);
    if (failure) {
      failure.after -= 1;
      if (failure.after === 0) { failures.delete(name); throw new Error(`Injected ${name} failure`); }
    }
    const result = action();
    const afterGate = afterGates.get(name);
    if (afterGate) { afterGates.delete(name); await afterGate.promise; }
    return result;
  }
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onSuspend: event(), onMessage: event(), lastError: undefined,
      getURL: path => `chrome-extension://test/${path}` },
    windows: { onCreated: event(), onRemoved: event(), onBoundsChanged: event(),
      getAll: async options => api('windows.getAll', options, () => [...open.values()].map(window => {
        const result = copy(window);
        if (!options?.populate) delete result.tabs;
        return result;
      })),
      get: async (id, options) => api('windows.get', { id, options }, () => {
        if (!open.has(id)) throw new Error('No window');
        return copy(open.get(id));
      }),
      create: async options => api('windows.create', options, () => {
        const initialUrl = options.url;
        const window = live(nextWindow++, [initialUrl || 'chrome://newtab']);
        Object.assign(window, options);
        delete window.url;
        open.set(window.id, window);
        browserEvents.push(() => chrome.windows.onCreated.emit(copy(window)));
        browserEvents.push(() => chrome.tabs.onCreated.emit(copy(window.tabs[0])));
        return copy(window);
      }),
      update: async (id, options) => api('windows.update', { id, options }, () => {
        Object.assign(open.get(id), options);
        browserEvents.push(() => { if (open.has(id)) chrome.windows.onBoundsChanged.emit(copy(open.get(id))); });
        return copy(open.get(id));
      }),
      remove: async id => api('windows.remove', id, () => {
        const window = open.get(id);
        if (!window) throw new Error('No window');
        open.delete(id);
        browserEvents.push(() => chrome.windows.onRemoved.emit(id));
        for (const tab of window.tabs) browserEvents.push(() => chrome.tabs.onRemoved.emit(tab.id, { windowId: id, isWindowClosing: true }));
      }) },
    tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(), onAttached: event(), onDetached: event(),
      query: async ({ windowId }) => api('tabs.query', { windowId }, () => copy(open.get(windowId)?.tabs || [])),
      update: async (id, options) => api('tabs.update', { id, options }, () => {
        for (const window of open.values()) {
          const tab = window.tabs.find(item => item.id === id);
          if (tab) { Object.assign(tab, options); return copy(tab); }
        }
        throw new Error('No tab');
      }),
      create: async options => api('tabs.create', options, () => {
        const window = open.get(options.windowId);
        const tab = { id: nextTab++, index: window.tabs.length, title: options.url, ...options };
        window.tabs.push(tab);
        browserEvents.push(() => chrome.tabs.onCreated.emit(copy(tab)));
        return copy(tab);
      }),
      remove: async id => api('tabs.remove', id, () => {
        for (const window of open.values()) {
          const index = window.tabs.findIndex(tab => tab.id === id);
          if (index !== -1) {
            window.tabs.splice(index, 1);
            browserEvents.push(() => chrome.tabs.onRemoved.emit(id, { windowId: window.id, isWindowClosing: false }));
            return;
          }
        }
        throw new Error('No tab');
      }) },
    storage: { session: {
      get: async keys => api('storage.session.get', keys, () => copy(sessionStored)),
      set: async value => api('storage.session.set', value, () => { sessionStored = { ...sessionStored, ...copy(value) }; }),
      remove: async keys => api('storage.session.remove', keys, () => { for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStored[key]; })
    }, local: {
      get(keys, callback) {
        calls.push({ name: 'storage.get', args: keys });
        const value = { ...copy(stored), ...copy(local) };
        if (callback) {
          loadCallback = () => {
            chrome.runtime.lastError = currentLoadError ? { message: 'Injected storage.get failure' } : undefined;
            callback(value);
            chrome.runtime.lastError = undefined;
          };
          if (!delayedLoad) loadCallback();
        } else {
          return api('storage.local.get', keys, () => value);
        }
      },
      set: async value => api('storage.set', value, () => {
        calls.push({ name: 'storage.local.set', args: copy(value) });
        storageWrites.push(copy(value));
        const { workspaces, activeWorkspaceId, sharedPinnedTabs, settings, ...extra } = copy(value);
        for (const key of ['workspaces', 'activeWorkspaceId', 'sharedPinnedTabs', 'settings']) {
          if (Object.prototype.hasOwnProperty.call(value, key)) stored[key] = copy(value[key]);
        }
        local = { ...local, ...extra };
      }),
      remove: async keys => api('storage.remove', keys, () => { for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key]; })
    } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} }
  };
  if (firefox) delete chrome.windows.onBoundsChanged;
  const context = vm.createContext({ chrome, browser: firefox ? { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } } : undefined, crypto: { randomUUID: () => `id-${++sessionSequence}` },
    URL, console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(fn) { intervals.push(fn); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context, { filename: 'background.js' });
  const env = {
    chrome, open, calls, storageWrites, logs, timers, intervals, context,
    shared: { get stored() { return stored; }, get sessionStored() { return sessionStored; }, get local() { return local; }, sessionIdentity },
    stored: () => copy(stored), local: () => copy(local), sessionStored: () => copy(sessionStored), state: expression => copy(vm.runInContext(expression, context)),
    crash() { crashed = true; },
    load: () => loadCallback(),
    recoverLoad: () => { currentLoadError = false; },
    fail(name, after = 1) { failures.set(name, { after }); },
    hold(name) { const gate = deferred(); gates.set(name, gate); return gate; },
    holdAfter(name) { const gate = deferred(); afterGates.set(name, gate); return gate; },
    count: name => calls.filter(call => call.name === name).length,
    message(action, fields = {}) { return new Promise(resolve => chrome.runtime.onMessage.listeners[0]({ action, ...copy(fields) }, {}, value => resolve(copy(value)))); },
    async runTimers() {
      const pending = [...timers.values()]; timers.clear();
      for (const timer of pending) timer.fn();
      await pump();
    },
    async deliverEvents() {
      while (browserEvents.length) browserEvents.shift()();
      await pump();
    },
    async complete(promise) {
      let done = false;
      let result;
      let error;
      Promise.resolve(promise).then(value => { done = true; result = value; }, reason => { done = true; error = reason; });
      for (let i = 0; i < 100 && !done; i++) {
        await pump();
        await env.runTimers();
      }
      assert.ok(done, 'operation completes without a stuck queue or guard');
      if (error) throw error;
      return result;
    },
    async idle() { await pump(); await env.runTimers(); await pump(); }
  };
  return env;
}
const urls = workspace => workspace.windows.flatMap(window => window.tabs.map(tab => tab.url));

test('Firefox without bounds event still registers tab persistence listeners', async () => {
  const env = harness({ firefox: true });
  await env.idle();
  env.open.get(1).tabs[0].url = 'https://firefox.test/';
  env.chrome.tabs.onUpdated.emit(100, { url: 'https://firefox.test/' }, env.open.get(1).tabs[0]);
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://firefox.test/']);
});

test('Firefox fresh workspace uses native blank URL', async () => {
  const env = harness({ firefox: true });
  const result = await env.complete(env.message('createWorkspace', { name: 'Firefox Fresh' }));
  assert.equal(result.success, true);
  assert.deepEqual([...env.open.values()][0].tabs.map(tab => tab.url), ['about:blank']);
});

// Real Chrome event callbacks may arrive later than their API promises. Browser
// operations enqueue events; tests decide when to deliver them. Timers never
// auto-fire, so debounced work can race with explicit messages under test.

test('cold settings and workspace messages wait for one shared storage load', async () => {
  const env = harness({ delayedLoad: true, data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a', settings: { sharePinnedTabs: true } } });
  let answered = false;
  const settings = env.message('getSettings').then(value => { answered = true; return value; });
  const workspace = env.message('getWorkspaces');
  await pump();
  assert.equal(answered, false);
  assert.equal(env.count('storage.get'), 1);
  env.load();
  assert.equal((await env.complete(settings)).settings.sharePinnedTabs, true);
  assert.equal((await env.complete(workspace)).activeWorkspaceId, 'a');
});

test('cold window event waits for storage and tracks live window', async () => {
  const env = harness({ delayedLoad: true, windows: [live(), live(2)] });
  env.chrome.windows.onCreated.emit(live(2));
  env.load();
  await env.idle();
  assert.deepEqual(env.stored().workspaces.a.windowIds, [1, 2]);
});

test('tab updates coalesce into one durable multi-window snapshot', async () => {
  const env = harness({ windows: [live(), live(2)] });
  await env.idle();
  env.open.get(1).tabs[0].url = 'https://changed.test/';
  env.open.get(2).tabs[0].pinned = true;
  env.chrome.tabs.onUpdated.emit(100, { url: 'https://changed.test/' }, env.open.get(1).tabs[0]);
  env.chrome.tabs.onUpdated.emit(200, { pinned: true }, env.open.get(2).tabs[0]);
  env.chrome.tabs.onMoved.emit(200, { windowId: 2, fromIndex: 0, toIndex: 1 });
  await env.idle();
  assert.equal(env.storageWrites.filter(value => value.workspaces).length, 1);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://changed.test/', 'https://live.test/']);
  assert.equal(env.stored().workspaces.a.windows[1].tabs[0].pinned, true);
});

test('created removed attached detached tabs persist without bounds events', async () => {
  const env = harness({ windows: [live(), live(2)] });
  await env.idle();
  const added = { id: 500, windowId: 2, url: 'https://added.test/', title: 'Added', pinned: false };
  env.open.get(2).tabs.push(added);
  env.chrome.tabs.onCreated.emit(added);
  await env.idle();
  assert.ok(urls(env.stored().workspaces.a).includes(added.url));
  env.open.get(1).tabs.push(env.open.get(2).tabs.pop());
  added.windowId = 1;
  env.chrome.tabs.onDetached.emit(500, { oldWindowId: 2, oldPosition: 1 });
  env.chrome.tabs.onAttached.emit(500, { newWindowId: 1, newPosition: 1 });
  await env.idle();
  assert.equal(env.stored().workspaces.a.windows[0].tabs[1].url, added.url);
  env.open.get(1).tabs.pop();
  env.chrome.tabs.onRemoved.emit(500, { windowId: 1, isWindowClosing: false });
  await env.idle();
  assert.equal(urls(env.stored().workspaces.a).includes(added.url), false);
});

test('zero live windows preserves saved restoration snapshot and clears live IDs', async () => {
  const env = harness({ windows: [] });
  const result = await env.complete(env.message('exportBackup'));
  assert.equal(result.success, true);
  assert.deepEqual(urls(result.data.workspaces.a), ['https://a.test/']);
  assert.deepEqual(result.data.workspaces.a.windowIds, []);
  assert.equal(result.data.workspaces.a.tabs, 1);
});

test('periodic cleanup preserves pending live tab persistence', async () => {
  const env = harness();
  await env.idle();
  env.open.get(1).tabs[0].url = 'https://changed.test/';
  env.chrome.tabs.onUpdated.emit(100, { url: 'https://changed.test/' }, env.open.get(1).tabs[0]);
  await pump();
  await env.complete(env.intervals[0]());
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://changed.test/']);
});

test('worker suspension has no asynchronous final snapshot handler', () => {
  const env = harness();
  assert.equal(env.chrome.runtime.onSuspend.listeners.length, 0);
});

for (const includeCurrentTabs of [false, true]) {
  test(`create (${includeCurrentTabs ? 'adoption' : 'fresh'}) durably saves outgoing live tabs first`, async () => {
    const env = harness();
    const result = await env.complete(env.message('createWorkspace', { name: 'New', includeCurrentTabs }));
    assert.equal(result.success, true);
    assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
    assert.equal(env.stored().activeWorkspaceId, result.workspaceId);
    const firstSave = env.calls.find(call => call.name === 'storage.local.set' && call.args.workspaces)?.args;
    assert.equal(firstSave.activeWorkspaceId, 'a');
    assert.deepEqual(urls(firstSave.workspaces.a), ['https://live.test/']);
  });
}

test('fresh creation prepares replacement before removing source window', async () => {
  const env = harness();
  await env.complete(env.message('createWorkspace', { name: 'New' }));
  assert.ok(env.calls.findIndex(call => call.name === 'windows.create') < env.calls.findIndex(call => call.name === 'windows.remove'));
});

for (const target of [null, 'missing', 'a']) {
  test(`startup leaves browser session intact for invalid saved target ${target}`, async () => {
    const env = harness({ data: { workspaces: target === 'a' ? { a: saved('a', undefined, { windows: [] }) } : {}, activeWorkspaceId: target } });
    await env.complete(env.chrome.runtime.onStartup.emit()[0]);
    assert.equal(env.count('windows.remove'), 0);
    assert.equal(env.count('windows.create'), 0);
    assert.equal(env.open.get(1).tabs[0].url, 'https://live.test/');
  });
}

test('startup restores valid saved tabs rather than overwriting them from browser session', async () => {
  const env = harness();
  await env.complete(env.chrome.runtime.onStartup.emit()[0]);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://a.test/']);
  assert.equal([...env.open.values()][0].tabs[0].url, 'https://a.test/');
  assert.ok(env.calls.findIndex(call => call.name === 'tabs.create') < env.calls.findIndex(call => call.name === 'windows.remove'));
});

test('concurrent switches serialize source snapshots and guard ownership', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b'), c: saved('c') }, activeWorkspaceId: 'a' } });
  const hold = env.hold('tabs.create');
  const first = env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  const second = env.message('switchWorkspace', { workspaceId: 'c' });
  env.intervals[0]();
  await pump();
  assert.equal(env.state('isSwitchingWorkspace'), true);
  assert.equal(env.count('windows.create'), 1);
  hold.resolve();
  assert.equal((await env.complete(first)).success, true);
  assert.equal((await env.complete(second)).success, true);
  await env.idle();
  assert.equal(env.stored().activeWorkspaceId, 'c');
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
  assert.deepEqual(urls(env.stored().workspaces.b), ['https://b.test/']);
  assert.equal(env.state('isSwitchingWorkspace'), false);
});

test('delayed transition events cannot append removed source or partial replacement snapshots', async () => {
  const env = harness();
  const hold = env.hold('tabs.create');
  const switching = env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  env.chrome.windows.onBoundsChanged.emit(live());
  await env.deliverEvents();
  await env.runTimers();
  hold.resolve();
  assert.equal((await env.complete(switching)).success, true);
  await env.deliverEvents();
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.b), ['https://b.test/']);
  assert.deepEqual(env.stored().workspaces.b.windowIds, [...env.open.keys()]);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
});

for (const api of ['windows.create', 'windows.update', 'tabs.create', 'tabs.remove']) {
  test(`switch ${api} failure retains source and releases guard for next request`, async () => {
    const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b', undefined, {
      windows: [{ windowState: { state: 'maximized' }, tabs: [{ url: 'https://b.test/', pinned: false }] }]
    }) }, activeWorkspaceId: 'a' } });
    env.fail(api);
    const result = await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }));
    assert.match(result.error || '', /Injected/);
    assert.equal(env.open.has(1), true);
    assert.equal(env.state('isSwitchingWorkspace'), false);
    assert.equal(env.stored().activeWorkspaceId, 'a');
    assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
    assert.equal((await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }))).success, true);
  });
}

for (const after of [1, 2, 3]) {
  test(`storage rejection ${after} during switch preserves source recovery data`, async () => {
    const env = harness();
    env.fail('storage.set', after);
    const result = await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }));
    assert.match(result.error || '', /Injected storage.set failure/);
    assert.equal(env.state('isSwitchingWorkspace'), false);
    assert.deepEqual(urls(env.stored().workspaces.a), [after <= 2 ? 'https://a.test/' : 'https://live.test/']);
    if (after <= 2) assert.equal(env.open.has(1), true);
    assert.equal((await env.complete(env.message('renameWorkspace', { workspaceId: 'a', name: 'Recovered' }))).success, true);
  });
}

test('partial source removal failure retains full outgoing snapshot and errors', async () => {
  const env = harness({ windows: [live(), live(2, ['https://second.test/'])] });
  env.fail('windows.remove', 2);
  const result = await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }));
  assert.match(result.error || '', /Injected windows.remove failure/);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/', 'https://second.test/']);
  assert.equal(env.open.has(2), true);
  assert.equal(env.state('isSwitchingWorkspace'), false);
});

test('worker restart rolls back owned replacement created before tab response', async () => {
  const env = harness();
  const hold = env.hold('tabs.create');
  env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  assert.equal(env.open.size, 2, 'replacement exists while first tab create is unresolved');
  env.crash();

  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  const loaded = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(loaded.activeWorkspaceId, 'a');
  assert.deepEqual(urls(loaded.workspaces.a), ['https://live.test/']);
  assert.equal(restarted.open.size, 1, 'only original source window remains after recovery');
  assert.equal(restarted.open.has(1), true);
});

test('window marker recovers create completed before ID checkpoint', async () => {
  const env = harness();
  env.holdAfter('windows.create');
  env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  const prepared = [...env.open.values()].find(window => window.id !== 1);
  assert.match(prepared.tabs[0].url, /recovery.html\?operation=.*slot=0/);
  env.crash();
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  await restarted.complete(restarted.message('getWorkspaces'));
  assert.deepEqual([...restarted.open.keys()], [1]);
  assert.equal(restarted.local().workspaceRecovery, undefined);
  // Keep old worker abandoned; resolving its API later would not simulate process death.

});

test('worker restart after committed cross-session journal does not restore stale IDs or target', async () => {
  const source = harness();
  source.fail('windows.remove');
  await source.complete(source.message('switchWorkspace', { workspaceId: 'b' }));
  const restarted = harness({ data: source.stored(), windows: [live(20, ['https://user.test/'])],
    shared: { stored: source.shared.stored, local: source.shared.local, sessionStored: {}, sessionIdentity: 'new-browser-session' } });
  const loaded = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(loaded.activeWorkspaceId, 'b');
  assert.deepEqual(loaded.workspaces.b.windowIds, []);
  assert.deepEqual([...restarted.open.keys()], [20]);
  assert.equal(restarted.local().workspaceStartup.state.activeWorkspaceId, 'b');
});

test('commit storage rejection never removes source windows', async () => {
  const env = harness();
  env.fail('storage.set', 3);
  const result = await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }));
  assert.match(result.error || '', /Injected storage.set failure/);
  assert.equal(env.open.has(1), true);
  assert.equal(env.stored().activeWorkspaceId, 'a');
});

test('failed journal clear preserves committed target recovery state', async () => {
  const env = harness();
  env.fail('storage.remove');
  const result = await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }));
  assert.match(result.error || '', /Injected storage.remove failure/);
  assert.equal(env.local().workspaceRecovery.phase, 'committed');
  assert.equal(env.local().workspaceRecovery.committedState.activeWorkspaceId, 'b');
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  assert.equal((await restarted.complete(restarted.message('getWorkspaces'))).activeWorkspaceId, 'b');
  assert.deepEqual([...restarted.open.values()].flatMap(window => window.tabs.map(tab => tab.url)), ['https://b.test/']);
});

test('worker restart after commit keeps prepared target and finishes source cleanup', async () => {
  const env = harness();
  const hold = env.hold('windows.remove');
  env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  assert.equal(env.stored().activeWorkspaceId, 'b');
  assert.equal(env.open.size, 2);
  env.crash();
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(result.activeWorkspaceId, 'b');
  assert.equal(restarted.open.size, 1);
  assert.equal([...restarted.open.values()][0].tabs[0].url, 'https://b.test/');
  assert.equal(restarted.local().workspaceRecovery, undefined);
});

test('precommit recovery leaves unrelated windows and wrong markers untouched', async () => {
  const env = harness();
  const hold = env.hold('tabs.create');
  env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  const unrelated = live(40, ['https://user.test/']);
  const wrongMarker = live(41, ['chrome-extension://test/recovery.html?operation=other&slot=0']);
  const restarted = harness({ data: env.stored(), windows: [...env.open.values(), unrelated, wrongMarker], shared: env.shared });
  await restarted.complete(restarted.message('getWorkspaces'));
  assert.deepEqual([...restarted.open.keys()].sort((a, b) => a - b), [1, 40, 41]);
  assert.equal(restarted.open.get(40).tabs[0].url, 'https://user.test/');
  assert.match(restarted.open.get(41).tabs[0].url, /operation=other/);
  env.crash();
});

test('browser restart does not close unrelated reused numeric window IDs', async () => {
  const old = harness();
  old.fail('tabs.create');
  await old.complete(old.message('switchWorkspace', { workspaceId: 'b' }));
  const freshSessionWindow = live(10, ['https://user.test/']);
  const restarted = harness({ data: old.stored(), windows: [freshSessionWindow] });
  const loaded = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(loaded.activeWorkspaceId, 'a');
  assert.deepEqual([...restarted.open.keys()], [10]);
  assert.equal(restarted.open.get(10).tabs[0].url, 'https://user.test/');
});

test('manual window removal retains recovery until next nonempty explicit snapshot', async () => {
  const env = harness({ windows: [live(), live(2, ['https://second.test/'])] });
  await env.complete(env.message('exportBackup'));
  env.open.delete(2);
  env.chrome.windows.onRemoved.emit(2);
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/', 'https://second.test/']);
  const backup = await env.complete(env.message('exportBackup'));
  assert.deepEqual(urls(backup.data.workspaces.a), ['https://live.test/']);
});

test('empty backup import journals blank replacement before removing source', async () => {
  const env = harness();
  env.fail('windows.remove');
  const result = await env.complete(env.message('importBackup', { data: { workspaces: {}, activeWorkspaceId: null } }));
  assert.match(result.error || '', /Injected windows.remove failure/);
  assert.equal(env.local().workspaceRecovery.phase, 'committed');
  assert.deepEqual(urls(env.local().workspaceRecovery.sourceState.workspaces.a), ['https://live.test/']);
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(restarted.local().workspaceRecovery, undefined);
  assert.deepEqual(restarted.stored().workspaces, {});
  assert.deepEqual([...restarted.open.values()].flatMap(window => window.tabs.map(tab => tab.url)), ['chrome://newtab']);
});

test('valid backup import/export retains settings and restores windows', async () => {
  const env = harness();
  const backup = await env.complete(env.message('exportBackup'));
  const result = await env.complete(env.message('importBackup', { data: backup.data }));
  assert.equal(result.success, true);
  assert.equal(result.count, 2);
  assert.equal(env.stored().activeWorkspaceId, 'a');
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
  assert.deepEqual(env.stored().workspaces.a.windowIds, [...env.open.keys()]);
  assert.equal(env.state('isSwitchingWorkspace'), false);
});

const invalidBackups = [
  ['missing workspace map', { version: '1.0.1' }],
  ['unsupported legacy record without windows', { workspaces: { a: { ...saved('a'), windows: undefined } } }],
  ['non-object workspace map', { workspaces: [] }],
  ['empty workspace map with invalid value', { workspaces: { a: null } }],
  ['mismatched workspace ID', { workspaces: { a: saved('b') } }],
  ['null nested window', { workspaces: { a: saved('a', undefined, { windows: [null] }) } }],
  ['null tab list entry', { workspaces: { a: saved('a', undefined, { windows: [{ windowState: { state: 'normal' }, tabs: [null] }] }) } }],
  ['unsafe active workspace ID', { workspaces: { a: saved('a') }, activeWorkspaceId: '__proto__' }],
  ['unsupported backup version', { version: '9.9.9', workspaces: {} }],
  ['unproven legacy backup version', { version: '1.0', workspaces: {} }],
  ['unsafe color string', { workspaces: { a: saved('a', undefined, { color: 'red" onmouseover="alert(1)' }) } }],
  ['malformed JavaScript URL', { workspaces: { a: saved('a', 'javascript:alert(1)') } }],
  ['unrestorable browser internal URL', { workspaces: { a: saved('a', 'chrome://settings') } }],
  ['partial normal window geometry', { workspaces: { a: saved('a', undefined, { windows: [{ windowState: { state: 'normal', width: 800 }, tabs: [] }] }) } }],
  ['invalid settings type', { workspaces: { a: saved('a') }, settings: { sharePinnedTabs: 'yes' } }],
  ['null shared pin', { workspaces: {}, sharedPinnedTabs: [null] }],
  ['malformed workspace-level tab record', { workspaces: { a: saved('a', undefined, { tabs: [null] }) } }],
  ['invalid non-normal window geometry', { workspaces: { a: saved('a', undefined, { windows: [{ windowState: { state: 'maximized', width: 800 }, tabs: [] }] }) } }]
];

for (const [description, invalidData] of invalidBackups) {
  test(`invalid backup ${description} rejects before snapshot, storage, or window effects`, async () => {
    const env = harness();
    await env.complete(env.message('getWorkspaces'));
    const initialState = env.stored();
    const initialOpen = [...env.open.values()];
    const callsBefore = env.calls.length;
    const writesBefore = env.storageWrites.length;
    const result = await env.complete(env.message('importBackup', { data: invalidData }));
    assert.match(result.error || '', /Invalid backup data/);
    assert.deepEqual(env.stored(), initialState);
    assert.deepEqual([...env.open.values()], initialOpen);
    assert.equal(env.calls.slice(callsBefore).filter(call => call.name.startsWith('windows.') || call.name.startsWith('tabs.')).length, 0);
    assert.equal(env.storageWrites.length, writesBefore);
    assert.equal(env.state('isSwitchingWorkspace'), false);
  });
}

test('versionless valid backup normalizes optional settings and pins without mutating input', async () => {
  const env = harness();
  const source = { workspaces: { a: saved('a', 'about:blank') }, activeWorkspaceId: 'a' };
  const original = copy(source);
  const result = await env.complete(env.message('importBackup', { data: source }));
  assert.equal(result.success, true);
  assert.deepEqual(source, original);
  assert.deepEqual(env.stored().settings, { sharePinnedTabs: false });
  assert.deepEqual(env.stored().sharedPinnedTabs, []);
  assert.deepEqual(urls(env.stored().workspaces.a), ['about:blank']);
});

test('shared-pin normalization prunes copied workspace tabs without mutating backup', async () => {
  const env = harness();
  const source = { version: '1.0.1', workspaces: { a: saved('a', undefined, { windows: [{
    windowState: { state: 'maximized' },
    tabs: [{ url: 'https://pin.test/', pinned: true }, { url: 'https://keep.test/', pinned: false }]
  }] }) }, activeWorkspaceId: 'a', settings: { sharePinnedTabs: true },
  sharedPinnedTabs: [{ url: 'https://shared.test/', pinned: true }] };
  const original = copy(source);
  const result = await env.complete(env.message('importBackup', { data: source }));
  assert.equal(result.success, true);
  assert.deepEqual(source, original);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://keep.test/']);
  assert.deepEqual([...env.open.values()][0].tabs.map(tab => tab.url), ['https://shared.test/', 'https://keep.test/']);
});

test('valid empty backup remains supported', async () => {
  const env = harness();
  const result = await env.complete(env.message('importBackup', { data: { version: '1.0.1', workspaces: {} } }));
  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.deepEqual(env.stored().workspaces, {});
});

test('import ignores duplicate stale live window IDs and replaces them with runtime IDs', async () => {
  const env = harness();
  const workspace = saved('a', 'https://saved.test/', { windowIds: [1, 1] });
  const result = await env.complete(env.message('importBackup', { data: { workspaces: { a: workspace }, activeWorkspaceId: 'a' } }));
  assert.equal(result.success, true);
  assert.equal(new Set(env.stored().workspaces.a.windowIds).size, env.stored().workspaces.a.windowIds.length);
  assert.deepEqual(env.stored().workspaces.a.windowIds, [...env.open.keys()]);
});

test('data URL with spaces passes validator and survives import exactly', async () => {
  const env = harness();
  const url = 'data:text/html,workspace persistence smoke';
  assert.equal(env.state(`isSafeBackupUrl(${JSON.stringify(url)})`), true);
  const workspace = saved('a', url);
  const result = await env.complete(env.message('importBackup', { data: { workspaces: { a: workspace }, activeWorkspaceId: 'a' } }));
  assert.equal(result.success, true);
  assert.equal(env.stored().workspaces.a.windows[0].tabs[0].url, url);
  assert.equal([...env.open.values()][0].tabs.some(tab => tab.url === url), true);
});

test('restoreable exported URL protocols remain accepted', async () => {
  const env = harness();
  const supportedUrls = [
    'https://site.test/path?q=1#top',
    'file:///tmp/workspace.html',
    'data:text/html,workspace persistence smoke',
    'chrome-extension://test/options.html',
    'about:blank',
    'chrome://newtab',
    'edge://newtab',
    'dia://new-tab-page',
    'moz-extension://test/options.html',
    'safari-web-extension://test/options.html'
  ];
  const workspace = saved('a', supportedUrls[0], { windows: [{ windowState: { state: 'normal' },
    tabs: supportedUrls.map(url => ({ url, pinned: false })) }] });
  const result = await env.complete(env.message('importBackup', { data: { workspaces: { a: workspace }, activeWorkspaceId: 'a' } }));
  assert.equal(result.success, true);
  assert.deepEqual(env.stored().workspaces.a.windows[0].tabs.map(tab => tab.url), supportedUrls);
});

test('backup workspace object rejects prototype-pollution keys', async () => {
  const data = JSON.parse('{"workspaces":{"__proto__":{"id":"__proto__","name":"bad","color":"#112233","createdAt":1,"lastAccessed":1,"windowIds":[],"windows":[],"tabs":0}}}');
  const env = harness();
  await env.complete(env.message('getWorkspaces'));
  const callsBefore = env.calls.length;
  const result = await env.complete(env.message('importBackup', { data }));
  assert.match(result.error || '', /Invalid backup data/);
  assert.equal(env.calls.slice(callsBefore).filter(call => call.name.startsWith('windows.') || call.name.startsWith('tabs.')).length, 0);
});


test('delete active workspace serializes replacement switch without deadlock', async () => {
  const env = harness();
  const result = await env.complete(env.message('deleteWorkspace', { workspaceId: 'a' }));
  assert.equal(result.success, true);
  assert.equal(env.stored().workspaces.a, undefined);
  assert.equal(env.stored().activeWorkspaceId, 'b');
  assert.deepEqual([...env.open.values()].flatMap(window => window.tabs.map(tab => tab.url)), ['https://b.test/']);
  assert.equal(env.state('isSwitchingWorkspace'), false);
});

test('cross-session precommit recovery clears inactive ownership before cleanup', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b', undefined, { windowIds: [40] }) }, activeWorkspaceId: 'a' } });
  env.holdAfter('windows.create');
  env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  env.crash();
  const restarted = harness({ windows: [live(40, ['https://unrelated.test/'])], shared: {
    stored: env.shared.stored, local: env.shared.local, sessionStored: {}
  } });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.deepEqual(result.workspaces.b.windowIds, []);
  await restarted.complete(restarted.intervals[0]());
  assert.equal(restarted.open.has(40), true);
});

test('completed switch atomically supersedes startup checkpoint before cleanup', async () => {
  const env = harness();
  env.hold('windows.remove');
  env.message('switchWorkspace', { workspaceId: 'b' });
  await pump();
  assert.equal(env.stored().activeWorkspaceId, 'b');
  assert.equal(env.local().workspaceStartup.state, null);
});

test('final workspace deletion journals replacement before worker interruption', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a' } });
  env.holdAfter('windows.create');
  env.message('deleteWorkspace', { workspaceId: 'a' });
  await pump();
  assert.equal(env.local().workspaceRecovery.phase, 'preparing');
  env.crash();
  const restarted = harness({ windows: [...env.open.values()], shared: env.shared });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(result.activeWorkspaceId, 'a');
  assert.deepEqual([...restarted.open.keys()], [1]);
});

test('rename mutation and startup checkpoint invalidation share one durable write', async () => {
  const env = harness();
  await env.complete(env.message('getWorkspaces'));
  env.storageWrites.length = 0;
  assert.equal((await env.complete(env.message('renameWorkspace', { workspaceId: 'a', name: 'Renamed' }))).success, true);
  const mutationWrite = env.storageWrites.find(write => write.workspaces.a.name === 'Renamed');
  assert.deepEqual(mutationWrite.workspaceStartup, { sessionId: env.sessionStored().workspaceSessionId, state: null });
});

test('restart preserves rename committed before message response instead of restoring old checkpoint', async () => {
  const env = harness();
  await env.complete(env.message('getWorkspaces'));
  const gate = env.holdAfter('storage.set');
  const response = env.message('renameWorkspace', { workspaceId: 'a', name: 'Renamed' });
  for (let i = 0; i < 100 && env.stored().workspaces.a.name !== 'Renamed'; i++) await pump();
  assert.equal(env.stored().workspaces.a.name, 'Renamed');
  assert.deepEqual(env.local().workspaceStartup, { sessionId: env.sessionStored().workspaceSessionId, state: null });
  env.crash();
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  await restarted.complete(restarted.chrome.runtime.onStartup.emit()[0]);
  assert.equal(restarted.stored().workspaces.a.name, 'Renamed');
  gate.resolve();
  await response;
});

test('failed metadata storage write rolls memory back before next message', async () => {
  const env = harness();
  env.fail('storage.set');
  assert.match((await env.complete(env.message('renameWorkspace', { workspaceId: 'a', name: 'Bad' }))).error, /Injected/);
  assert.equal((await env.complete(env.message('getWorkspaces'))).workspaces.a.name, 'A');
});


test('late source events after partial close failure cannot overwrite target snapshot', async () => {
  const env = harness({ windows: [live(), live(2, ['https://second.test/'])] });
  env.fail('windows.remove', 2);
  assert.match((await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }))).error, /Injected/);
  await env.deliverEvents();
  env.chrome.windows.onBoundsChanged.emit(live(2));
  env.chrome.tabs.onUpdated.emit(200, { title: 'Late' }, live(2).tabs[0]);
  await env.idle();
  assert.equal(env.open.has(2), false, 'recovery completes remaining source cleanup');
  assert.deepEqual(urls(env.stored().workspaces.b), ['https://b.test/']);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/', 'https://second.test/']);
});

test('early-created tab without URL uses blank fallback until URL arrives', async () => {
  const env = harness();
  await env.idle();
  env.open.get(1).tabs = [{ id: 501, windowId: 1, pinned: false }];
  env.chrome.tabs.onCreated.emit(env.open.get(1).tabs[0]);
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['chrome://newtab']);
  env.open.get(1).tabs[0].url = 'https://loaded.test/';
  env.chrome.tabs.onUpdated.emit(501, { url: 'https://loaded.test/' }, env.open.get(1).tabs[0]);
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://loaded.test/']);
});

test('startup journal commit supersedes stale checkpoint on worker wake', async () => {
  const source = harness();
  source.fail('windows.remove');
  await source.complete(source.message('switchWorkspace', { workspaceId: 'b' }));
  const restarted = harness({ data: source.stored(), windows: [...source.open.values()], shared: source.shared });
  const loaded = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(loaded.activeWorkspaceId, 'b');
  await restarted.complete(restarted.chrome.runtime.onStartup.emit()[0]);
  assert.deepEqual([...restarted.open.values()].flatMap(window => window.tabs.map(tab => tab.url)), ['https://b.test/']);
});

test('failed startup cleanup keeps checkpoint retryable in same worker', async () => {
  const env = harness();
  env.fail('windows.remove');
  const first = await env.complete(env.chrome.runtime.onStartup.emit()[0]);
  assert.equal(first, undefined);
  assert.ok(env.local().workspaceStartup);
  const next = await env.complete(env.chrome.runtime.onStartup.emit()[0]);
  assert.equal(next.success, true);
  assert.equal(env.local().workspaceStartup, undefined);
});

test('worker restart keeps startup target checkpoint despite earlier browser events', async () => {
  const env = harness({ windows: [live(2)] });
  env.chrome.windows.onCreated.emit(live(2));
  await env.idle();
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()], shared: env.shared });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(result.activeWorkspaceId, 'a');
  await restarted.complete(restarted.chrome.runtime.onStartup.emit()[0]);
  assert.deepEqual([...restarted.open.values()].flatMap(window => window.tabs.map(tab => tab.url)), ['https://a.test/']);
  assert.equal(restarted.local().workspaceStartup, undefined);
});

test('startup restores original stored target despite earlier startup window events', async () => {
  const env = harness({ windows: [live(2)] });
  env.chrome.windows.onCreated.emit(live(2));
  env.chrome.tabs.onUpdated.emit(200, { url: 'https://live.test/' }, env.open.get(2).tabs[0]);
  await env.idle();
  await env.complete(env.chrome.runtime.onStartup.emit()[0]);
  assert.deepEqual([...env.open.values()].flatMap(window => window.tabs.map(tab => tab.url)), ['https://a.test/']);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://a.test/']);
});

test('cold load error reaches messages and next request retries after storage recovery', async () => {
  const env = harness({ loadError: true });
  assert.match((await env.complete(env.message('getSettings'))).error, /storage.get failure/);
  env.recoverLoad();
  assert.equal((await env.complete(env.message('getWorkspaces'))).activeWorkspaceId, 'a');
});

for (const action of ['createWorkspace', 'importBackup', 'deleteWorkspace']) {
  test(`${action} tab creation rejection keeps source and recoverable state`, async () => {
    const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b') }, activeWorkspaceId: 'a',
      settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://pin.test/', pinned: true }] } });
    env.fail('tabs.create');
    const fields = action === 'createWorkspace' ? { name: 'New' } : action === 'importBackup' ?
      { data: { workspaces: { c: saved('c') }, activeWorkspaceId: 'c' } } : { workspaceId: 'a' };
    assert.match((await env.complete(env.message(action, fields))).error || '', /Injected tabs.create failure/);
    assert.equal(env.open.has(1), true);
    assert.equal(env.stored().activeWorkspaceId, 'a');
    assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
    assert.equal(env.state('isSwitchingWorkspace'), false);
  });
}

test('earlier startup events then restore failure retain original durable target', async () => {
  const env = harness({ windows: [live(2)] });
  env.chrome.windows.onCreated.emit(live(2));
  await env.idle();
  env.fail('tabs.create');
  await env.complete(env.chrome.runtime.onStartup.emit()[0]);
  assert.equal(env.open.has(2), true);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://a.test/']);
});

test('debounced tab event followed by whole-window closure preserves closed-window recovery', async () => {
  const env = harness({ windows: [live(), live(2, ['https://second.test/'])] });
  await env.complete(env.message('exportBackup'));
  env.chrome.tabs.onUpdated.emit(200, { title: 'Updated' }, env.open.get(2).tabs[0]);
  await pump();
  env.open.delete(2);
  env.chrome.windows.onRemoved.emit(2);
  env.chrome.tabs.onRemoved.emit(200, { windowId: 2, isWindowClosing: true });
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/', 'https://second.test/']);
});

test('coalesced cross-window updates persist survivor when last event window closes', async () => {
  const env = harness({ windows: [live(), live(2, ['https://second.test/'])] });
  await env.complete(env.message('exportBackup'));
  env.open.get(1).tabs[0].url = 'https://changed.test/';
  env.chrome.tabs.onUpdated.emit(100, { url: 'https://changed.test/' }, env.open.get(1).tabs[0]);
  env.chrome.tabs.onUpdated.emit(200, { title: 'Updated' }, env.open.get(2).tabs[0]);
  await pump();
  env.open.delete(2);
  env.chrome.windows.onRemoved.emit(2);
  env.chrome.tabs.onRemoved.emit(200, { windowId: 2, isWindowClosing: true });
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://changed.test/']);
});

test('startup restore tab failure retains saved target and browser session', async () => {
  const env = harness();
  env.fail('tabs.create');
  await env.complete(env.chrome.runtime.onStartup.emit()[0]);
  assert.equal(env.open.has(1), true);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://a.test/']);
  assert.equal(env.state('isSwitchingWorkspace'), false);
  assert.ok(env.logs.some(args => args.some(value => value?.message?.includes('Injected tabs.create failure'))));
});

test('delayed events for failed prepared windows cannot blank source snapshot', async () => {
  const env = harness();
  env.fail('tabs.create');
  assert.match((await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }))).error, /Injected/);
  await env.deliverEvents();
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
  assert.deepEqual(env.stored().workspaces.a.windowIds, [1]);
});

test('live event storage rejection retains last durable snapshot then recovers on next event', async () => {
  const env = harness();
  await env.idle();
  env.fail('storage.set');
  env.open.get(1).tabs[0].url = 'https://changed.test/';
  env.chrome.tabs.onUpdated.emit(100, { url: 'https://changed.test/' }, env.open.get(1).tabs[0]);
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://a.test/']);
  assert.deepEqual(urls((await env.complete(env.message('getWorkspaces'))).workspaces.a), ['https://a.test/']);
  env.chrome.tabs.onUpdated.emit(100, { title: 'Changed' }, env.open.get(1).tabs[0]);
  await env.idle();
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://changed.test/']);
});

test('blank-only windows retain fallback and normal/maximized state with pinned ordering', async () => {
  const target = saved('b', undefined, { windows: [
    { windowState: { state: 'normal', left: 5, top: 6, width: 800, height: 600 }, tabs: [
      { url: 'https://unpin.test/', pinned: false }, { url: 'https://pin.test/', pinned: true } ] },
    { windowState: { state: 'maximized' }, tabs: [{ url: 'chrome://newtab', pinned: false }] }
  ] });
  const env = harness({ data: { workspaces: { a: saved('a'), b: target }, activeWorkspaceId: 'a' } });
  assert.equal((await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }))).success, true);
  const windows = [...env.open.values()];
  assert.equal(windows[0].width, 800);
  assert.equal(windows[0].left, 5);
  assert.equal(windows[1].state, 'maximized');
  assert.deepEqual(windows[0].tabs.map(tab => tab.url), ['https://pin.test/', 'https://unpin.test/']);
  assert.deepEqual(windows[1].tabs.map(tab => tab.url), ['chrome://newtab']);
});

function pinWindow(id, urls) {
  const window = live(id, urls);
  for (const tab of window.tabs) tab.pinned = true;
  return window;
}

for (const shareInitially of [false, true]) {
  test(`shared pins aggregate distinct windows when ${shareInitially ? 'saving' : 'enabling'}`, async () => {
    const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
      settings: { sharePinnedTabs: shareInitially } },
      windows: [pinWindow(1, ['https://one.test/']), pinWindow(2, ['https://two.test/'])] });
    const result = await env.complete(env.message(shareInitially ? 'exportBackup' : 'updateSettings',
      shareInitially ? {} : { settings: { sharePinnedTabs: true } }));
    assert.equal(result.success, true);
    assert.deepEqual(env.stored().sharedPinnedTabs.map(tab => tab.url), ['https://one.test/', 'https://two.test/']);
  });
}

test('shared pins count intentional duplicate multiplicity in a single window', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a', settings: { sharePinnedTabs: true } },
    windows: [pinWindow(1, ['https://one.test/', 'https://one.test/'])] });
  await env.complete(env.message('exportBackup'));
  assert.deepEqual(env.stored().sharedPinnedTabs.map(tab => tab.url), ['https://one.test/', 'https://one.test/']);
});

test('shared pins keep intentional duplicates without multiplying replicated windows', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true } }, windows: [
    pinWindow(1, ['https://one.test/', 'https://one.test/', 'https://two.test/']),
    pinWindow(2, ['https://one.test/', 'https://one.test/', 'https://two.test/'])
  ] });
  assert.equal((await env.complete(env.message('exportBackup'))).success, true);
  assert.deepEqual(env.stored().sharedPinnedTabs.map(tab => tab.url),
    ['https://one.test/', 'https://one.test/', 'https://two.test/']);
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: true } }))).success, true);
  assert.equal(env.stored().sharedPinnedTabs.length, 3);
});

test('removing every live shared pin clears saved pins', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://removed.test/', pinned: true }] } });
  assert.equal((await env.complete(env.message('exportBackup'))).success, true);
  assert.deepEqual(env.stored().sharedPinnedTabs, []);
});

test('disabling sharing snapshots active tab edits before debounce expires', async () => {
  const window = live(1, ['https://pin.test/', 'https://before.test/']);
  window.tabs[0].pinned = true;
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://pin.test/', pinned: true }] }, windows: [window] });
  env.open.get(1).tabs[1].url = 'https://latest.test/';
  env.chrome.tabs.onUpdated.emit(101, { url: 'https://latest.test/' }, env.open.get(1).tabs[1]);
  await pump();
  env.timers.clear();
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  assert(env.stored().workspaces.a.windows[0].tabs.some(tab => tab.url === 'https://latest.test/'));
  assert(env.stored().workspaces.a.windows[0].tabs.some(tab => tab.url === 'https://pin.test/' && tab.pinned));
});

test('disabling sharing immediately uses live pin changes before debounce', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b', undefined, { windows: [{ windowState: { state: 'normal' }, tabs: [
    { url: 'https://inactive-content.test/', title: 'Content', pinned: false }
  ] }] }) }, activeWorkspaceId: 'a', settings: { sharePinnedTabs: true },
    sharedPinnedTabs: [{ url: 'https://removed.test/', pinned: true }] },
    windows: [pinWindow(1, ['https://new.test/'])] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  assert.deepEqual(env.stored().workspaces.a.windows[0].tabs.filter(tab => tab.pinned).map(tab => tab.url), ['https://new.test/']);
  assert.deepEqual(env.stored().workspaces.b.windows[0].tabs.filter(tab => tab.pinned).map(tab => tab.url), ['https://new.test/']);
});

test('disabling shared pins snapshots active workspace pins before switching away', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://one.test/', pinned: true }] },
    windows: [pinWindow(1, ['https://one.test/'])] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  assert.equal(env.stored().workspaces.a.windows[0].tabs[0].pinned, true);
  assert.equal(env.stored().workspaces.a.windows[0].tabs[0].url, 'https://one.test/');
});

test('disabling shared pins creates a restorable window for workspaces without saved windows', async () => {
  const env = harness({ data: { workspaces: {
    a: saved('a', 'https://active.test/', { windows: [] }),
    b: saved('b', 'https://inactive.test/', { windows: [] })
  }, activeWorkspaceId: 'a', settings: { sharePinnedTabs: true },
    sharedPinnedTabs: [{ url: 'https://shared.test/', pinned: true }] },
    windows: [pinWindow(1, ['https://shared.test/'])] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  for (const id of ['a', 'b']) {
    assert.equal(env.stored().workspaces[id].windows.length, 1);
    assert(env.stored().workspaces[id].windows[0].tabs.some(tab => tab.url === 'https://shared.test/' && tab.pinned));
  }
});

test('disabling shared pins with no live windows keeps pins restorable', async () => {
  const pins = [{ url: 'https://saved-pin.test/', title: 'Saved', pinned: true }];
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: pins }, windows: [] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  assert.deepEqual(env.stored().workspaces.a.windows[0].tabs.filter(tab => tab.pinned), pins);
  assert.equal((await env.complete(env.message('switchWorkspace', { workspaceId: 'a' }))).success, true);
  assert.equal([...env.open.values()][0].tabs.some(tab => tab.url === pins[0].url && tab.pinned), true);
});

test('disabling shared pins with live windows clears global shared list', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://pin.test/', pinned: true }] },
    windows: [pinWindow(1, ['https://pin.test/'])] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  assert.deepEqual(env.stored().sharedPinnedTabs, []);
  assert.deepEqual(env.stored().workspaces.a.windows[0].tabs.filter(tab => tab.pinned).map(tab => tab.url), ['https://pin.test/']);
  assert.equal(env.stored().workspaces.a.windows[0].tabs[0].pinned, true);
});

test('failed shared-pin collection keeps old settings and pins', async () => {
  const oldPin = { url: 'https://saved.test/', title: 'Saved', pinned: true };
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: false }, sharedPinnedTabs: [oldPin] } });
  await env.complete(env.message('getSettings'));
  env.fail('windows.getAll');
  const result = await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: true } }));
  assert.match(result.error, /Injected/);
  assert.equal(env.stored().settings.sharePinnedTabs, false);
  assert.deepEqual(env.stored().sharedPinnedTabs, [oldPin]);
});

test('enabling shared pins without live windows extracts pins from saved active snapshot', async () => {
  const savedWindow = tabs => ({ windowState: { state: 'normal' }, tabs });
  const env = harness({ data: { workspaces: {
    a: saved('a', undefined, { windows: [savedWindow([
      { url: 'https://saved-one.test/', title: 'One', pinned: true },
      { url: 'https://saved-one.test/', title: 'One', pinned: true },
      { url: 'https://saved-two.test/', title: 'Two', pinned: true },
      { url: 'https://content.test/', title: 'Content', pinned: false }
    ])] }),
    b: saved('b', undefined, { windows: [savedWindow([
      { url: 'https://inactive-pin.test/', title: 'Inactive', pinned: true },
      { url: 'https://inactive-content.test/', title: 'Inactive content', pinned: false }
    ])] })
  }, activeWorkspaceId: 'a', settings: { sharePinnedTabs: false } }, windows: [] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: true } }))).success, true);
  assert.deepEqual(env.stored().sharedPinnedTabs.map(tab => tab.url),
    ['https://saved-one.test/', 'https://saved-one.test/', 'https://saved-two.test/']);
  assert.deepEqual(env.stored().workspaces.a.windows[0].tabs.map(tab => tab.url), ['https://content.test/']);
  assert.deepEqual(env.stored().workspaces.b.windows[0].tabs.map(tab => tab.url), ['https://inactive-content.test/']);
  assert.equal(env.stored().workspaces.a.tabs, 1);
});

test('enabling shared pins without live windows or saved pins keeps existing shared list', async () => {
  const existing = [{ url: 'https://existing.test/', title: 'Existing', pinned: true }];
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: false }, sharedPinnedTabs: existing }, windows: [] });
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: true } }))).success, true);
  assert.deepEqual(env.stored().sharedPinnedTabs, existing);
});

test('zero live windows preserves shared pins for recovery', async () => {
  const pins = [{ url: 'https://saved.test/', title: 'Saved', pinned: true }];
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: pins }, windows: [] });
  await env.complete(env.message('exportBackup'));
  assert.deepEqual(env.stored().sharedPinnedTabs, pins);
});

test('shared pinned settings backup round trip keeps existing pin policy', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://pin.test/', title: 'Pin', pinned: true }] },
    windows: [{ ...live(1), tabs: [{ id: 101, windowId: 1, url: 'https://pin.test/', title: 'Pin', pinned: true }, ...live(1).tabs] }] });
  const exported = await env.complete(env.message('exportBackup'));
  assert.equal((await env.complete(env.message('importBackup', { data: exported.data }))).success, true);
  assert.equal(env.stored().settings.sharePinnedTabs, true);
  assert.deepEqual([...env.open.values()][0].tabs.map(tab => tab.url), ['https://pin.test/', 'https://live.test/']);
});

function inactiveDeletionHarness() {
  return harness({ data: { workspaces: { a: saved('a'),
    b: saved('b', undefined, { windowIds: [2, 3] }) }, activeWorkspaceId: 'a' },
    windows: [live(), live(2), live(3), live(4)] });
}

test('inactive deletion commits cleanup intent before first window close', async () => {
  const env = inactiveDeletionHarness();
  env.hold('windows.remove');
  env.message('deleteWorkspace', { workspaceId: 'b' });
  await pump();
  assert.equal(env.stored().workspaces.b, undefined);
  assert.equal(env.local().workspaceRecovery?.phase, 'committed');
  assert.deepEqual(env.local().workspaceRecovery.sourceIds, [2, 3]);
  assert.equal(env.local().workspaceStartup.state, null);
  env.crash();
  const restarted = harness({ windows: [...env.open.values()], shared: env.shared });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(result.activeWorkspaceId, 'a');
  assert.equal(result.workspaces.b, undefined);
  assert.deepEqual([...restarted.open.keys()], [1, 4]);
  assert.equal(restarted.local().workspaceRecovery, undefined);
});

test('inactive deletion resumes after one removal completed before worker death', async () => {
  const env = inactiveDeletionHarness();
  env.holdAfter('windows.remove');
  env.message('deleteWorkspace', { workspaceId: 'b' });
  await pump();
  assert.equal(env.open.has(2), false);
  env.crash();
  const restarted = harness({ windows: [...env.open.values()], shared: env.shared });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(result.workspaces.b, undefined);
  assert.deepEqual([...restarted.open.keys()], [1, 4]);
});

test('inactive deletion recovers commit completed before its storage response', async () => {
  const env = inactiveDeletionHarness();
  await env.complete(env.message('getWorkspaces'));
  env.holdAfter('storage.set');
  env.message('deleteWorkspace', { workspaceId: 'b' });
  await pump();
  assert.equal(env.stored().workspaces.b, undefined);
  assert.deepEqual([...env.open.keys()], [1, 2, 3, 4]);
  env.crash();
  const restarted = harness({ windows: [...env.open.values()], shared: env.shared });
  await restarted.complete(restarted.message('getWorkspaces'));
  assert.deepEqual([...restarted.open.keys()], [1, 4]);
  assert.equal(restarted.local().workspaceStartup.state, null);
});

test('inactive deletion recovery retains journal when cleanup repeatedly rejects', async () => {
  const env = inactiveDeletionHarness();
  env.fail('windows.remove');
  await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }));
  const restarted = harness({ windows: [...env.open.values()], shared: env.shared });
  restarted.fail('windows.remove');
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.match(result.error, /Injected/);
  assert.equal(restarted.local().workspaceRecovery.phase, 'committed');
  assert.equal(restarted.stored().workspaces.b, undefined);
  assert.deepEqual([...restarted.open.keys()], [1, 2, 3, 4]);
  await restarted.complete(restarted.message('getWorkspaces'));
  assert.deepEqual([...restarted.open.keys()], [1, 4]);
});

test('inactive deletion closing events cannot overwrite active snapshot or adopt sources', async () => {
  const env = inactiveDeletionHarness();
  assert.equal((await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }))).success, true);
  await env.deliverEvents();
  await env.idle();
  assert.equal(env.stored().workspaces.b, undefined);
  assert.deepEqual(env.stored().workspaces.a.windowIds, [1]);
  assert.deepEqual(urls(env.stored().workspaces.a), ['https://a.test/']);
});

test('inactive deletion commit rejection leaves all windows and workspace intact', async () => {
  const env = inactiveDeletionHarness();
  await env.complete(env.message('getWorkspaces'));
  env.fail('storage.set');
  const result = await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }));
  assert.match(result.error, /Injected storage.set failure/);
  assert.deepEqual([...env.open.keys()], [1, 2, 3, 4]);
  assert.ok(env.stored().workspaces.b);
  assert.equal(env.local().workspaceRecovery, undefined);
});

test('inactive deletion API failure retains committed journal for retry', async () => {
  const env = inactiveDeletionHarness();
  env.fail('windows.remove', 2);
  const result = await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }));
  assert.match(result.error, /Injected windows.remove failure/);
  assert.equal(env.stored().workspaces.b, undefined);
  assert.equal(env.local().workspaceRecovery.phase, 'committed');
  assert.equal(env.state('isSwitchingWorkspace'), false);
  await env.complete(env.message('getWorkspaces'));
  assert.deepEqual([...env.open.keys()], [1, 4]);
  assert.equal(env.local().workspaceRecovery, undefined);
});

test('inactive deletion recovery never closes reused IDs in a new browser session', async () => {
  const env = inactiveDeletionHarness();
  env.hold('windows.remove');
  env.message('deleteWorkspace', { workspaceId: 'b' });
  await pump();
  env.crash();
  const restarted = harness({ windows: [live(2, ['https://unrelated.test/'])], shared: {
    stored: env.shared.stored, local: env.shared.local, sessionStored: {}
  } });
  const result = await restarted.complete(restarted.message('getWorkspaces'));
  assert.equal(result.workspaces.b, undefined);
  assert.deepEqual(result.workspaces.a.windowIds, []);
  assert.deepEqual([...restarted.open.keys()], [2]);
  assert.equal(restarted.count('windows.remove'), 0);
});

test('inactive deletion respects overlapping ownership of other workspaces', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'),
    b: saved('b', undefined, { windowIds: [1, 2, 3] }),
    c: saved('c', undefined, { windowIds: [3] }) }, activeWorkspaceId: 'a' },
    windows: [live(), live(2), live(3), live(4)] });
  assert.equal((await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }))).success, true);
  assert.deepEqual([...env.open.keys()], [1, 3, 4]);
  assert.deepEqual(env.stored().workspaces.a.windowIds, [1]);
  assert.deepEqual(env.stored().workspaces.c.windowIds, [3]);
});

test('inactive deletion recovery state-write failure retains cleanup intent', async () => {
  const env = inactiveDeletionHarness();
  await env.complete(env.message('getWorkspaces'));
  env.fail('storage.set', 2);
  const result = await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }));
  assert.match(result.error, /Injected storage.set failure/);
  assert.equal(env.stored().workspaces.b, undefined);
  assert.equal(env.local().workspaceRecovery.phase, 'committed');
  assert.deepEqual([...env.open.keys()], [1, 4]);
  await env.complete(env.message('getWorkspaces'));
  assert.equal(env.local().workspaceRecovery, undefined);
  assert.equal(env.stored().workspaces.b, undefined);
});

test('inactive deletion with no owned windows preserves active snapshot on same-session startup event', async () => {
  const env = harness();
  assert.equal((await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }))).success, true);
  assert.equal(env.count('windows.remove'), 0);
  assert.equal(env.count('windows.create'), 0);
  assert.equal(env.local().workspaceRecovery, undefined);
  const restarted = harness({ windows: [...env.open.values()], shared: env.shared });
  await restarted.complete(restarted.chrome.runtime.onStartup.emit()[0]);
  assert.equal(restarted.stored().workspaces.b, undefined);
  assert.equal(restarted.count('windows.create'), 0);
  assert.deepEqual(urls(restarted.stored().workspaces.a), ['https://a.test/']);
});

test('inactive deletion journal-clear failure stays replayable', async () => {
  const env = inactiveDeletionHarness();
  env.fail('storage.remove');
  const result = await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }));
  assert.match(result.error || '', /Injected storage.remove failure/);
  assert.equal(env.local().workspaceRecovery.phase, 'committed');
  await env.complete(env.message('getWorkspaces'));
  assert.deepEqual([...env.open.keys()], [1, 4]);
  assert.equal(env.local().workspaceRecovery, undefined);
});

test('nonactive deletion keeps active live windows and only removes owned windows', async () => {
  const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b', undefined, { windowIds: [2] }) }, activeWorkspaceId: 'a' },
    windows: [live(), live(2), live(3)] });
  assert.equal((await env.complete(env.message('deleteWorkspace', { workspaceId: 'b' }))).success, true);
  assert.deepEqual([...env.open.keys()], [1, 3]);
  assert.equal(env.stored().workspaces.b, undefined);
  assert.equal(env.stored().activeWorkspaceId, 'a');
});

test('fresh creation with shared pins removes default blank tab as before', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a',
    settings: { sharePinnedTabs: true }, sharedPinnedTabs: [{ url: 'https://pin.test/', pinned: true }] },
    windows: [pinWindow(1, ['https://pin.test/'])] });
  assert.equal((await env.complete(env.message('createWorkspace', { name: 'Fresh' }))).success, true);
  assert.deepEqual([...env.open.values()][0].tabs.map(tab => tab.url), ['https://pin.test/']);
});

test('deleting final workspace leaves null active ID and clears guard', async () => {
  const env = harness({ data: { workspaces: { a: saved('a') }, activeWorkspaceId: 'a' } });
  assert.equal((await env.complete(env.message('deleteWorkspace', { workspaceId: 'a' }))).success, true);
  assert.deepEqual(env.stored().workspaces, {});
  assert.equal(env.stored().activeWorkspaceId, null);
  assert.equal(env.state('isSwitchingWorkspace'), false);
});

test('legacy live ID migration and all metadata messages remain compatible', async () => {
  const a = saved('a');
  delete a.windowIds;
  a.windowId = 1;
  const env = harness({ data: { workspaces: { a }, activeWorkspaceId: 'a' } });
  assert.deepEqual((await env.complete(env.message('getWorkspaces'))).workspaces.a.windowIds, [1]);
  assert.equal((await env.complete(env.message('updateWorkspaceColor', { workspaceId: 'a', color: '#123456' }))).success, true);
  assert.equal((await env.complete(env.message('updateWorkspace', { workspaceId: 'a', updates: { name: 'Updated' } }))).success, true);
  assert.equal((await env.complete(env.message('updateSettings', { settings: { sharePinnedTabs: false } }))).success, true);
  assert.equal(env.stored().workspaces.a.name, 'Updated');
  assert.equal(env.stored().workspaces.a.color, '#123456');
});


for (const action of ['exportBackup', 'tabUpdate']) {
  test(`legacy adopted overlapping IDs prefer active ownership during ${action}`, async () => {
    const env = harness({ data: { workspaces: { a: saved('a'), b: saved('b', undefined, { windowIds: [1] }) }, activeWorkspaceId: 'a' } });
    if (action === 'exportBackup') {
      const result = await env.complete(env.message(action));
      assert.deepEqual(urls(result.data.workspaces.a), ['https://live.test/']);
    } else {
      await env.idle();
      env.chrome.tabs.onUpdated.emit(100, { title: 'Changed' }, env.open.get(1).tabs[0]);
      await env.idle();
      assert.deepEqual(urls(env.stored().workspaces.a), ['https://live.test/']);
    }
  });
}

test('restarted worker excludes surviving inactive source windows after partial removal', async () => {
  const env = harness({ windows: [live(), live(2, ['https://second.test/'])] });
  env.fail('windows.remove', 2);
  assert.match((await env.complete(env.message('switchWorkspace', { workspaceId: 'b' }))).error, /Injected/);
  const restarted = harness({ data: env.stored(), windows: [...env.open.values()] });
  await restarted.idle();
  const target = [...restarted.open.values()].find(window => window.id !== 2);
  restarted.chrome.tabs.onUpdated.emit(target.tabs[0].id, { title: 'Updated' }, target.tabs[0]);
  await restarted.idle();
  assert.deepEqual(urls(restarted.stored().workspaces.b), ['https://b.test/']);
  assert.deepEqual(urls(restarted.stored().workspaces.a), ['https://live.test/', 'https://second.test/']);
});

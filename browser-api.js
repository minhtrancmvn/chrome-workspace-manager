// Bridge Firefox's Promise-based browser.* APIs to this extension's chrome.* usage.
// Chrome keeps its native API objects untouched; load this before background.js and popup.js.
(function installBrowserApiCompatibility(global) {
  if (!global.browser || !global.browser.runtime || !global.chrome) {
    return;
  }

  const browserApi = global.browser;
  if (global.browser === global.chrome) {
    return;
  }

  let currentLastError;
  const namespaceCache = new Map();
  const nestedNamespaceCache = new Map();
  const namespaceAliases = { action: 'browserAction' };
  const chromeNamespaceToBrowser = new Map([
    ['action', 'browserAction'],
    ['browserAction', 'browserAction'],
    ['storage', 'storage'],
    ['runtime', 'runtime'],
    ['windows', 'windows'],
    ['tabs', 'tabs']
  ]);

  function getBrowserNamespace(name) {
    return browserApi[namespaceAliases[name] || name];
  }

  function getMethodNamespace(namespace, method, targetNamespace) {
    if (namespace === 'action' && typeof browserApi.action?.[method] === 'function') {
      return browserApi.action;
    }
    if (namespace === 'action' && typeof browserApi.browserAction?.[method] === 'function') {
      return browserApi.browserAction;
    }
    return targetNamespace;
  }

  function runCallback(callback, value, error) {
    currentLastError = error;
    try {
      callback(value);
    } finally {
      currentLastError = undefined;
    }
  }

  function wrapNestedNamespace(parentName, childName, chromeNamespace, browserNamespace) {
    const key = `${parentName}.${childName}`;
    if (nestedNamespaceCache.has(key)) {
      return nestedNamespaceCache.get(key);
    }
    if (!browserNamespace || !chromeNamespace || typeof chromeNamespace !== 'object') {
      return chromeNamespace;
    }

    const namespace = new Proxy(chromeNamespace, {
      get(target, property) {
        const browserValue = browserNamespace[property];
        if (typeof browserValue !== 'function') {
          return property in target ? target[property] : browserValue;
        }
        return (...args) => {
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
          let result;
          try {
            result = browserValue.apply(browserNamespace, args);
          } catch (error) {
            if (!callback) return Promise.reject(error);
            runCallback(callback, undefined, error);
            return undefined;
          }
          if (!callback) return result;
          Promise.resolve(result).then(
            value => runCallback(callback, value),
            error => runCallback(callback, undefined, error)
          );
          return undefined;
        };
      }
    });
    nestedNamespaceCache.set(key, namespace);
    return namespace;
  }

  function wrapNamespace(name, chromeNamespace, browserNamespaceOverride) {
    if (namespaceCache.has(name)) {
      return namespaceCache.get(name);
    }

    const browserNamespace = browserNamespaceOverride || getBrowserNamespace(name);
    if (!browserNamespace) {
      return chromeNamespace;
    }

    const wrappedNamespace = new Proxy(chromeNamespace || {}, {
      get(target, property) {
        if (name === 'runtime' && property === 'lastError') {
          return currentLastError;
        }

        if (name === 'storage' && ['local', 'session', 'sync', 'managed'].includes(property)) {
          return wrapNestedNamespace(name, property, target[property], browserNamespace[property]);
        }

        const methodNamespace = getMethodNamespace(name, property, browserNamespace);
        const browserValue = methodNamespace?.[property];
        if (typeof browserValue !== 'function') {
          return property in target ? target[property] : browserValue;
        }

        return (...args) => {
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
          let result;
          try {
            result = browserValue.apply(methodNamespace, args);
          } catch (error) {
            if (!callback) {
              return Promise.reject(error);
            }
            runCallback(callback, undefined, error);
            return undefined;
          }

          if (!callback) {
            return result;
          }

          Promise.resolve(result).then(
            value => runCallback(callback, value),
            error => runCallback(callback, undefined, error)
          );
          // Match Chrome callback-style methods while still handling their Promise.
          return undefined;
        };
      }
    });

    namespaceCache.set(name, wrappedNamespace);
    return wrappedNamespace;
  }

  const nativeChrome = global.chrome;
  global.chrome = new Proxy(nativeChrome, {
    get(target, property) {
      if (typeof property !== 'string') {
        return target[property];
      }
      const chromeNamespace = target[property];
      const browserName = chromeNamespaceToBrowser.get(property);
      const browserNamespace = browserName ? browserApi[browserName] : getBrowserNamespace(property);
      const browserNamespaceAlias = property === 'action' && browserApi.action
        ? browserApi.action
        : browserNamespace;
      if (!browserNamespaceAlias || typeof browserNamespaceAlias !== 'object') {
        return chromeNamespace;
      }
      return wrapNamespace(property, chromeNamespace || {}, browserNamespaceAlias);
    }
  });
})(globalThis);

const assert = require('assert');

class MockClassList {
  constructor() { this.classes = new Set(); }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
  toggle(c, force) {
    if (force === undefined) {
      if (this.classes.has(c)) this.classes.delete(c);
      else this.classes.add(c);
    } else if (force) {
      this.classes.add(c);
    } else {
      this.classes.delete(c);
    }
  }
}

class MockElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList();
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this._listeners = {};
    this.disabled = false;
    this.children = [];
  }
  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  dispatchEvent(event) {
    if (this._listeners[event.type]) {
      this._listeners[event.type].forEach(fn => fn(event));
    }
  }
  click() {
    this.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  }
  appendChild(child) {
    this.children.push(child);
  }
  closest(selector) { return null; }
  remove() {}
}

const mockDocument = {
  body: new MockElement('body'),
  elements: {},
  getElementById(id) {
    if (!this.elements[id]) {
      this.elements[id] = new MockElement(id);
    }
    return this.elements[id];
  },
  createElement(tag) { return new MockElement(null, tag); },
  querySelectorAll() { return []; },
  querySelector(sel) {
    if (sel === 'input[name="transfer-op"][value="copy"]') {
       return new MockElement('mock-radio', 'input');
    }
    return null;
  },
  addEventListener(event, fn) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
};

const mockLocalStorage = {
  store: {},
  getItem(k) { return this.store.hasOwnProperty(k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
  clear() { this.store = {}; }
};

let apiCalls = [];

global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.window = { location: { href: '' }, isSecureContext: true };
global.navigator = { clipboard: { writeText: async () => {} } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

global.fetch = async (path, opts) => {
  apiCalls.push({ path, opts });
  if (path.startsWith('/api/browse')) {
    const p = new URL('http://localhost' + path).searchParams.get('path');
    if (p === '/not-found') {
      return { ok: false, status: 404, json: async () => ({ detail: 'Not found' }) };
    }
    return { 
      ok: true, status: 200, 
      json: async () => ({ path: p || '/', entries: [], parent: null })
    };
  }
  if (path === '/api/roots') {
    return { ok: true, status: 200, json: async () => ({ roots: ['/root1', '/root2'] }) };
  }
  if (path === '/api/whoami') {
    return { ok: true, status: 200, json: async () => ({ username: 'test' }) };
  }
  if (path.startsWith('/api/activity')) {
    return { ok: true, status: 200, json: async () => ({ activity: [] }) };
  }
  if (path.startsWith('/api/tasks/active')) {
    return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

(async () => {
  console.log('Running LiteSync Picker Fallback JavaScript Test Suite...');
  
  const { state } = await import('../static/js/state.js');
  state.roots = ['/root1', '/root2'];
  
  // Create all required mock elements for app.js layout update
  ['split-container', 'left-pane', 'right-pane', 'bottom-pane', 'btn-single-pane', 'btn-dual-pane'].forEach(id => {
      mockDocument.elements[id] = new MockElement(id);
  });

  const app = await import('../static/js/app.js');

  const runTest = async (name, fn) => {
    mockLocalStorage.clear();
    mockDocument.elements = {};
    // ensure layout elements exist before each run
    ['split-container', 'left-pane', 'right-pane', 'bottom-pane', 'btn-single-pane', 'btn-dual-pane'].forEach(id => {
        mockDocument.elements[id] = new MockElement(id);
    });
    
    apiCalls = [];
    
    // Reset state
    state.singlePane = true;
    state.pickerDest.path = null;
    state.pickerDest.entries = [];
    
    try {
      await fn();
      console.log(`✓ ${name} passed`);
    } catch (e) {
      console.error(`✗ ${name} failed`);
      console.error(e);
      process.exit(1);
    }
  };

  await runTest('Test 1: valid stored path navigates normally', async () => {
    mockLocalStorage.setItem('litesync-last-destination', '/valid/path');
    await app.openConfirmModal();
    
    // Should have made an API call to the valid path
    assert.strictEqual(apiCalls.some(c => c.path.includes(encodeURIComponent('/valid/path'))), true);
    
    // The pickerDest state should be updated to the valid path
    assert.strictEqual(state.pickerDest.path, '/valid/path');
  });

  await runTest('Test 2: 404 stored path falls back to root list without an uncaught error', async () => {
    mockLocalStorage.setItem('litesync-last-destination', '/not-found');
    // Calling openConfirmModal should NOT throw an error (it should be caught gracefully)
    await app.openConfirmModal();
    
    // Should have attempted the dead path first
    assert.strictEqual(apiCalls.some(c => c.path.includes(encodeURIComponent('/not-found'))), true);
    
    // State should fall back to root list (null)
    assert.strictEqual(state.pickerDest.path, null);
    // State entries should contain the roots
    assert.strictEqual(state.pickerDest.entries.length, 2);
    assert.strictEqual(state.pickerDest.entries[0].name, '/root1');
  });

  await runTest('Test 3: stale path is removed from localStorage, second open goes straight to root', async () => {
    mockLocalStorage.setItem('litesync-last-destination', '/not-found');
    await app.openConfirmModal();
    
    // The invalid path should have been cleared
    assert.strictEqual(mockLocalStorage.getItem('litesync-last-destination'), null);
    
    apiCalls = []; // Reset api calls for second open
    
    await app.openConfirmModal();
    
    // Second open should NOT attempt the dead path again
    assert.strictEqual(apiCalls.some(c => c.path.includes(encodeURIComponent('/not-found'))), false);
    
    // Should still be at root list
    assert.strictEqual(state.pickerDest.path, null);
  });

  console.log('All tests passed.');
})();

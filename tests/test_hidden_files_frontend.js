const assert = require('assert');

console.log('Running LiteSync Hidden Files & Folders Frontend Test Suite...');

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
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new MockClassList();
    this.listeners = {};
    this.children = [];
    this.textContent = '';
    this._innerHTML = '';
    this.title = '';
    this.style = {};
    this.checked = false;
    this.indeterminate = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.scrollWidth = 100;
    this.parentElement = null;
    this.value = '';
  }

  set type(val) { this.setAttribute('type', val); }
  get type() { return this.getAttribute('type') || ''; }

  set className(val) {
    this.classList = new MockClassList();
    String(val).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }
  get className() {
    return Array.from(this.classList.classes).join(' ');
  }

  set innerHTML(val) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    } else if (val === '<span class="name">..</span>') {
      const span = new MockElement('span');
      span.className = 'name';
      span.textContent = '..';
      span.parentElement = this;
      this.children = [span];
    }
  }
  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] || null; }
  removeAttribute(k) { delete this.attributes[k]; }

  addEventListener(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    const handlers = this.listeners[event.type] || [];
    for (const h of handlers) {
      h(event);
      if (event._propagationStopped) break;
    }
    if (!event._propagationStopped && this.parentElement) {
      this.parentElement.dispatchEvent(event);
    }
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this, stopPropagation: () => {} });
  }

  appendChild(child) {
    if (child.isFragment) {
      for (const grandChild of child.children) {
        grandChild.parentElement = this;
        this.children.push(grandChild);
      }
      child.children = [];
      return;
    }
    child.parentElement = this;
    this.children.push(child);
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
  }

  querySelector(sel) {
    const list = this.querySelectorAll(sel);
    return list.length > 0 ? list[0] : null;
  }

  querySelectorAll(sel) {
    const result = [];
    const walk = (node) => {
      for (const c of node.children) {
        let match = false;
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          if (c.classList.contains(cls)) match = true;
        } else if (sel === 'input[type="checkbox"]') {
          if (c.tagName === 'INPUT' && c.getAttribute('type') === 'checkbox') match = true;
        } else if (sel.startsWith('input')) {
          if (c.tagName === 'INPUT') match = true;
        }
        if (match) result.push(c);
        walk(c);
      }
    };
    walk(this);
    return result;
  }

  closest(sel) {
    let curr = this;
    while (curr) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        if (curr.classList && curr.classList.contains(cls)) return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }
}

class MockDocumentFragment extends MockElement {
  constructor() {
    super('#document-fragment');
    this.isFragment = true;
  }
}

const mockLocalStorage = {
  store: {},
  getItem(k) { return this.store.hasOwnProperty(k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
  clear() { this.store = {}; }
};

const domElements = {};
function getOrCreateElement(id, tag = 'div') {
  if (!domElements[id]) {
    domElements[id] = new MockElement(tag, id);
  }
  return domElements[id];
}

const mockDocument = {
  elements: domElements,
  documentElement: new MockElement('html'),
  body: new MockElement('body'),
  getElementById(id) {
    return getOrCreateElement(id);
  },
  createElement(tag) {
    const el = new MockElement(tag);
    if (tag === 'input') el.setAttribute('type', 'text');
    return el;
  },
  createDocumentFragment() {
    return new MockDocumentFragment();
  },
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    if (sel.includes('[data-pane="source"]')) return getOrCreateElement('source-master-cb');
    if (sel.includes('[data-pane="dest"]')) return getOrCreateElement('dest-master-cb');
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.pane-master-cb') {
      return [getOrCreateElement('source-master-cb'), getOrCreateElement('dest-master-cb')];
    }
    return [];
  },
  addEventListener() {}
};

let browseApiCalls = [];
let allApiCalls = [];

global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.window = {
  matchMedia: () => ({ matches: false }),
  location: { href: '' },
  isSecureContext: true
};
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

global.fetch = async (url, opts) => {
  allApiCalls.push({ url, opts });
  if (url.startsWith('/api/browse')) {
    browseApiCalls.push({ url, opts });
    const parsed = new URL('http://localhost' + url);
    const p = parsed.searchParams.get('path');
    
    if (p === '/root/.hidden_dir') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          path: '/root/.hidden_dir',
          parent: '/root',
          entries: [
            { name: 'config.json', path: '/root/.hidden_dir/config.json', is_dir: false, size: 100, mtime: 1700000000 },
            { name: '.subhidden', path: '/root/.hidden_dir/.subhidden', is_dir: false, size: 50, mtime: 1700000000 }
          ]
        })
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        path: '/root',
        parent: null,
        entries: [
          { name: '.bashrc', path: '/root/.bashrc', is_dir: false, size: 220, mtime: 1700000000 },
          { name: '.config', path: '/root/.config', is_dir: true, size: 0, mtime: 1700000000 },
          { name: 'documents', path: '/root/documents', is_dir: true, size: 0, mtime: 1700000000 },
          { name: 'notes.txt', path: '/root/notes.txt', is_dir: false, size: 1024, mtime: 1700000000 }
        ]
      })
    };
  }
  if (url === '/api/roots') {
    return { ok: true, status: 200, json: async () => ({ roots: ['/root'] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

(async () => {
  // Pre-seed layout and UI elements so app.js and panes.js find all required IDs
  const allIds = [
    'split-container', 'left-pane', 'right-pane', 'bottom-pane',
    'btn-single-pane', 'btn-dual-pane', 'toast-stack',
    'source-path', 'source-body', 'source-master-cb',
    'dest-path', 'dest-body', 'dest-master-cb',
    'transfer-picker-path', 'transfer-picker-body',
    'transfer-btn', 'selection-inline', 'selection-inline-count',
    'selection-view-btn', 'selection-clear-btn', 'selection-preview',
    'selection-preview-list', 'selection-preview-count',
    'settings-modal', 'menu-settings', 'settings-modal-dismiss',
    'settings-cancel', 'settings-save', 'settings-theme',
    'settings-language', 'settings-show-hidden',
    'settings-current-password', 'settings-new-password', 'settings-confirm-password',
    'confirm-modal', 'confirm-ok'
  ];

  for (const id of allIds) {
    getOrCreateElement(id);
  }
  // Setup master checkboxes with data-pane attribute
  domElements['source-master-cb'].setAttribute('data-pane', 'source');
  domElements['dest-master-cb'].setAttribute('data-pane', 'dest');

  const { state } = await import('../static/js/state.js');
  const { renderPane, loadPane, updateMasterCheckboxState } = await import('../static/js/panes.js');
  const { initSettingsModal } = await import('../static/js/modals/settings.js');

  state.roots = ['/root'];

  let passed = 0;
  let failed = 0;

  async function runAsyncTest(name, fn) {
    try {
      await fn();
      console.log(`✓ ${name} passed`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name} failed:`, err);
      failed++;
    }
  }

  console.log('\n--- Running Tests ---');

  // Test 1: Default to OFF (hidden files not shown) when no preference stored
  await runAsyncTest('Test 1: Setting defaults to OFF (hidden files not shown) on first use with no stored preference', async () => {
    mockLocalStorage.clear();
    state.selection.clear();
    browseApiCalls = [];

    assert.strictEqual(mockLocalStorage.getItem('litesync-show-hidden'), null);

    await loadPane('source', '/root');
    const body = domElements['source-body'];
    const names = body.children.map(row => {
      const nameEl = row.children.find(c => c.classList.contains('name'));
      return nameEl ? nameEl.textContent : '';
    });

    // Hidden entries (.bashrc, .config) must NOT be rendered
    assert.strictEqual(names.includes('.bashrc'), false, '.bashrc should not be shown');
    assert.strictEqual(names.includes('.config'), false, '.config should not be shown');
    // Non-hidden entries must be rendered
    assert.strictEqual(names.includes('documents'), true, 'documents should be shown');
    assert.strictEqual(names.includes('notes.txt'), true, 'notes.txt should be shown');
  });

  // Test 2: Toggling the setting ON reveals dot-files immediately without a new network request
  await runAsyncTest('Test 2: Toggling ON reveals dot-files immediately without new /api/browse call', async () => {
    initSettingsModal();
    const browseCallsBefore = browseApiCalls.length;

    const toggle = domElements['settings-show-hidden'];
    toggle.checked = true;
    toggle.dispatchEvent({ type: 'change', target: toggle });

    const browseCallsAfter = browseApiCalls.length;
    assert.strictEqual(browseCallsAfter, browseCallsBefore, 'Zero new /api/browse network calls should be made on toggle');

    const body = domElements['source-body'];
    const names = body.children.map(row => {
      const nameEl = row.children.find(c => c.classList.contains('name'));
      return nameEl ? nameEl.textContent : '';
    });

    assert.strictEqual(names.includes('.bashrc'), true, '.bashrc must appear when toggle is ON');
    assert.strictEqual(names.includes('.config'), true, '.config must appear when toggle is ON');
    assert.strictEqual(names.includes('documents'), true);
    assert.strictEqual(names.includes('notes.txt'), true);
    assert.strictEqual(mockLocalStorage.getItem('litesync-show-hidden'), 'true');
  });

  // Test 3: Toggling OFF hides them again immediately without new network request
  await runAsyncTest('Test 3: Toggling OFF hides dot-files immediately without new /api/browse call', async () => {
    const browseCallsBefore = browseApiCalls.length;

    const toggle = domElements['settings-show-hidden'];
    toggle.checked = false;
    toggle.dispatchEvent({ type: 'change', target: toggle });

    const browseCallsAfter = browseApiCalls.length;
    assert.strictEqual(browseCallsAfter, browseCallsBefore, 'Zero new /api/browse network calls on toggle OFF');

    const body = domElements['source-body'];
    const names = body.children.map(row => {
      const nameEl = row.children.find(c => c.classList.contains('name'));
      return nameEl ? nameEl.textContent : '';
    });

    assert.strictEqual(names.includes('.bashrc'), false, '.bashrc must disappear when toggle is OFF');
    assert.strictEqual(names.includes('.config'), false, '.config must disappear when toggle is OFF');
    assert.strictEqual(names.includes('documents'), true);
    assert.strictEqual(names.includes('notes.txt'), true);
    assert.strictEqual(mockLocalStorage.getItem('litesync-show-hidden'), 'false');
  });

  // Test 4: Setting persists across a page reload (localStorage), consistent with theme/language
  await runAsyncTest('Test 4: Setting persists across page reload (localStorage) and initializes modal', async () => {
    mockLocalStorage.setItem('litesync-show-hidden', 'true');
    initSettingsModal();

    // Opening settings modal should populate checkbox from localStorage
    domElements['menu-settings'].click();
    assert.strictEqual(domElements['settings-show-hidden'].checked, true, 'Settings modal should load stored ON state');

    // Rendering pane with stored 'true' shows hidden files
    await loadPane('source', '/root');
    const body = domElements['source-body'];
    const names = body.children.map(row => {
      const nameEl = row.children.find(c => c.classList.contains('name'));
      return nameEl ? nameEl.textContent : '';
    });
    assert.strictEqual(names.includes('.bashrc'), true);
    assert.strictEqual(names.includes('.config'), true);

    // Save button also persists
    domElements['settings-show-hidden'].checked = false;
    domElements['settings-save'].click();
    assert.strictEqual(mockLocalStorage.getItem('litesync-show-hidden'), 'false');
  });

  // Test 5: Direct navigation to a hidden folder works when setting is OFF
  await runAsyncTest('Test 5: Direct navigation to a hidden folder works even when setting is OFF', async () => {
    mockLocalStorage.setItem('litesync-show-hidden', 'false');

    await loadPane('source', '/root/.hidden_dir');
    assert.strictEqual(state.source.path, '/root/.hidden_dir');
    assert.strictEqual(domElements['source-path'].textContent, '/root/.hidden_dir');

    const body = domElements['source-body'];
    const names = body.children.map(row => {
      const nameEl = row.children.find(c => c.classList.contains('name'));
      return nameEl ? nameEl.textContent : '';
    });

    // Parent '..' is present
    assert.strictEqual(names.includes('..'), true, 'Parent navigation must be present');
    // Non-hidden item inside hidden folder is present
    assert.strictEqual(names.includes('config.json'), true, 'config.json inside hidden folder must be shown');
    // Dotfile inside hidden folder is filtered because show-hidden is OFF
    assert.strictEqual(names.includes('.subhidden'), false, '.subhidden inside hidden folder must be hidden');
  });

  // Test 6: Selection persistence for hidden items across toggle
  await runAsyncTest('Test 6: Selected hidden item persists in SelectionState when toggled OFF, and restores in DOM when toggled ON', async () => {
    mockLocalStorage.setItem('litesync-show-hidden', 'true');
    state.selection.clear();
    await loadPane('source', '/root');

    // Select the hidden file .bashrc
    state.selection.select('/root/.bashrc');
    assert.strictEqual(state.selection.isPathSelected('/root/.bashrc'), true);
    assert.strictEqual(state.selection.size, 1);
    renderPane('source');

    let body = domElements['source-body'];
    let bashrcRow = body.children.find(r => r.getAttribute('data-path') === '/root/.bashrc');
    assert.ok(bashrcRow, '.bashrc row must exist when show-hidden is ON');
    assert.strictEqual(bashrcRow.classList.contains('selected'), true, '.bashrc row must be selected');

    // Toggle setting OFF
    mockLocalStorage.setItem('litesync-show-hidden', 'false');
    renderPane('source');

    body = domElements['source-body'];
    bashrcRow = body.children.find(r => r.getAttribute('data-path') === '/root/.bashrc');
    assert.strictEqual(bashrcRow, undefined, '.bashrc row must be removed from DOM when show-hidden is OFF');

    // Crucial check: SelectionState itself is unaffected by display filtering!
    assert.strictEqual(state.selection.isPathSelected('/root/.bashrc'), true, 'Path must still be selected in SelectionState');
    assert.strictEqual(state.selection.size, 1, 'Selection count must remain 1');
    const transferSources = state.selection.toTransferSources();
    assert.deepStrictEqual(transferSources, ['/root/.bashrc'], 'Transfer sources must still contain the hidden file');

    // Toggle setting back ON: re-rendered row should restore checked & selected state
    mockLocalStorage.setItem('litesync-show-hidden', 'true');
    renderPane('source');

    body = domElements['source-body'];
    bashrcRow = body.children.find(r => r.getAttribute('data-path') === '/root/.bashrc');
    assert.ok(bashrcRow, '.bashrc row must reappear in DOM');
    assert.strictEqual(bashrcRow.classList.contains('selected'), true, '.bashrc row must still be selected');
    const cb = bashrcRow.children.find(c => c.tagName === 'INPUT' && c.getAttribute('type') === 'checkbox');
    assert.strictEqual(cb.checked, true, '.bashrc checkbox must be checked');
  });

  // Test 7: Master checkbox only considers visible entries when OFF
  await runAsyncTest('Test 7: Master checkbox only considers visible entries when show-hidden is OFF', async () => {
    mockLocalStorage.setItem('litesync-show-hidden', 'false');
    state.selection.clear();
    await loadPane('source', '/root');

    // Select visible entries only: 'documents' and 'notes.txt'
    state.selection.select('/root/documents');
    state.selection.select('/root/notes.txt');

    updateMasterCheckboxState('source');

    const masterCb = domElements['source-master-cb'];
    // Since all visible entries are selected, master checkbox should be checked
    assert.strictEqual(masterCb.checked, true, 'Master checkbox must be checked when all visible items are selected');
    assert.strictEqual(masterCb.indeterminate, false);

    // Unselect one visible entry
    state.selection.unselect('/root/documents');
    updateMasterCheckboxState('source');
    assert.strictEqual(masterCb.checked, false);
    assert.strictEqual(masterCb.indeterminate, true, 'Master checkbox must be indeterminate when some visible items are selected');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();

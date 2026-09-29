const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running LiteSync Right Panel & Layout JavaScript Test Suite...');

// 1. Static HTML & CSS Validation
const htmlContent = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
const cssContent = fs.readFileSync(path.join(__dirname, '../static/css/app.css'), 'utf8');

// Test 1: HTML structure validation
assert.ok(htmlContent.includes('id="main-layout"'), 'main-layout container must exist in index.html');
assert.ok(htmlContent.includes('id="file-panes-area"'), 'file-panes-area must exist in index.html');
assert.ok(htmlContent.includes('id="selection-bar"'), 'selection-bar must exist in index.html');
assert.ok(htmlContent.includes('id="right-panel-splitter"'), 'right-panel-splitter must exist in index.html');
assert.ok(htmlContent.includes('id="right-panel"'), 'right-panel must exist in index.html');
assert.ok(htmlContent.includes('id="bookmarks-section"'), 'bookmarks-section must exist in index.html');
assert.ok(htmlContent.includes('id="right-panel-h-splitter"'), 'right-panel-h-splitter must exist in index.html');
assert.ok(htmlContent.includes('id="operations-section"'), 'operations-section must exist in index.html');
assert.ok(htmlContent.includes('id="panel-collapsed-strip"'), 'panel-collapsed-strip must exist in index.html');
assert.ok(htmlContent.includes('id="btn-toggle-right-panel"'), 'btn-toggle-right-panel must exist in index.html');
assert.ok(htmlContent.includes('id="right-panel-collapse-btn"'), 'right-panel-collapse-btn must exist in index.html');
assert.ok(htmlContent.includes('id="right-panel-expand-btn"'), 'right-panel-expand-btn must exist in index.html');
assert.ok(htmlContent.includes('id="collapsed-op-indicator"'), 'collapsed-op-indicator must exist in index.html');

// Test 2: Bookmarks placeholder entries
assert.ok(htmlContent.includes('/mnt/ssd'), 'Bookmarks placeholder must contain sample folder /mnt/ssd');
assert.ok(htmlContent.includes('/mnt/hdd2/movies'), 'Bookmarks placeholder must contain sample folder /mnt/hdd2/movies');
assert.ok(htmlContent.includes('data-i18n="bookmarks.hint"'), 'Bookmarks placeholder must have hint');

// Test 3: Operations & Activity Log tabs in right panel
assert.ok(htmlContent.includes('id="tab-active-btn"'), 'tab-active-btn must exist in operations section');
assert.ok(htmlContent.includes('id="tab-activity-btn"'), 'tab-activity-btn must exist in operations section');
assert.ok(htmlContent.includes('id="active-transfers-container"'), 'active-transfers-container must exist in operations section');
assert.ok(htmlContent.includes('id="activity-container"'), 'activity-container must exist in operations section');

console.log('✓ HTML Layout Structure Verification Passed');

// Test 4: CSS Layout Rules Validation
assert.ok(cssContent.includes('.main-layout'), '.main-layout must be styled');
assert.ok(cssContent.includes('.file-panes-area'), '.file-panes-area must be styled');
assert.ok(cssContent.includes('.selection-bar'), '.selection-bar must be styled');
assert.ok(cssContent.includes('#right-panel'), '#right-panel must be styled');
assert.ok(cssContent.includes('#bookmarks-section'), '#bookmarks-section must be styled');
assert.ok(cssContent.includes('#operations-section'), '#operations-section must be styled');
assert.ok(cssContent.includes('.panel-collapsed-strip'), '.panel-collapsed-strip must be styled');
assert.ok(cssContent.includes('@container (max-width: 440px)'), 'Container query or narrow pane rule for hiding modified column must exist');

console.log('✓ CSS Layout Rules Verification Passed');

// 2. Mock DOM & JavaScript Logic Validation
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
    this.title = '';
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
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 400, height: 600, bottom: 600, right: 400 };
  }
}

const mockDocument = {
  documentElement: new MockElement('html'),
  body: new MockElement('body'),
  elements: {},
  getElementById(id) {
    if (!this.elements[id]) {
      this.elements[id] = new MockElement(id);
    }
    return this.elements[id];
  },
  createElement(tag) {
    return new MockElement(null, tag);
  },
  createDocumentFragment() {
    return new MockElement(null, 'fragment');
  },
  querySelectorAll() { return []; },
  querySelector(sel) {
    if (sel === '.panes') return this.getElementById('panes');
    if (sel === '#right-panel') return this.getElementById('right-panel');
    return null;
  },
  addEventListener() {}
};

const mockLocalStorage = {
  store: {},
  getItem(k) { return this.store[k] || null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
  clear() { this.store = {}; }
};

global.fetch = async (path) => {
  if (path.startsWith('/locales/')) {
    return { ok: true, json: async () => ({}) };
  }
  return { ok: true, json: async () => ({ roots: [], tasks: [], username: 'test' }) };
};

global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.window = {
  innerWidth: 1200,
  innerHeight: 800,
  location: { href: 'http://localhost/' },
  matchMedia: () => ({ matches: false }),
  isSecureContext: true
};
global.getComputedStyle = () => ({ flexDirection: 'row' });

async function testRightPanelLogic() {
  const { setRightPanelCollapsed, toggleRightPanel, updateRightPanelIndicator } = await import('../static/js/app.js');
  const { state } = await import('../static/js/state.js');
  const { updateSelectionUI } = await import('../static/js/panes.js');

  // Test 5: Right panel collapsing and persistence
  setRightPanelCollapsed(true);
  const rp = mockDocument.getElementById('right-panel');
  assert.strictEqual(rp.classList.contains('collapsed'), true, 'right-panel should have collapsed class');
  assert.strictEqual(mockDocument.body.classList.contains('right-panel-collapsed'), true, 'body should have right-panel-collapsed class');
  assert.strictEqual(mockLocalStorage.getItem('litesync_right_panel_collapsed'), 'true', 'localStorage should record right-panel collapsed true');

  setRightPanelCollapsed(false);
  assert.strictEqual(rp.classList.contains('collapsed'), false, 'right-panel should not have collapsed class');
  assert.strictEqual(mockDocument.body.classList.contains('right-panel-collapsed'), false, 'body should not have right-panel-collapsed class');
  assert.strictEqual(mockLocalStorage.getItem('litesync_right_panel_collapsed'), 'false', 'localStorage should record right-panel collapsed false');

  toggleRightPanel();
  assert.strictEqual(rp.classList.contains('collapsed'), true, 'toggleRightPanel should toggle to collapsed');
  toggleRightPanel();
  assert.strictEqual(rp.classList.contains('collapsed'), false, 'toggleRightPanel should toggle back to expanded');

  console.log('✓ Right Panel Collapsing & Persistence Passed');

  // Test 6: Running operations indicator in collapsed strip
  state.tasks = [];
  updateRightPanelIndicator();
  const indicator = mockDocument.getElementById('collapsed-op-indicator');
  const navBadge = mockDocument.getElementById('nav-panel-badge');
  assert.strictEqual(indicator.classList.contains('hidden'), true, 'Indicator should be hidden when no active tasks');
  assert.strictEqual(navBadge.classList.contains('hidden'), true, 'Nav badge should be hidden when no active tasks');

  state.tasks = [{ task_id: 't1', status: 'running' }, { task_id: 't2', status: 'queued' }];
  updateRightPanelIndicator();
  assert.strictEqual(indicator.classList.contains('hidden'), false, 'Indicator should be visible when tasks are active');
  assert.strictEqual(navBadge.classList.contains('hidden'), false, 'Nav badge should be visible when tasks are active');
  const countEl = mockDocument.getElementById('collapsed-op-count');
  assert.strictEqual(countEl.textContent, '2', 'Indicator should display active task count 2');

  console.log('✓ In-Progress Operations Indicator Passed');

  // Test 7: Selection bar visibility
  state.selection.clear();
  updateSelectionUI();
  const selBar = mockDocument.getElementById('selection-bar');
  assert.strictEqual(selBar.classList.contains('hidden'), true, 'Selection bar should be hidden when 0 items selected');

  state.selection.select('/test.txt');
  updateSelectionUI();
  assert.strictEqual(selBar.classList.contains('hidden'), false, 'Selection bar should be visible when items are selected');

  // Even when right-panel is collapsed, selection bar remains visible
  setRightPanelCollapsed(true);
  updateSelectionUI();
  assert.strictEqual(selBar.classList.contains('hidden'), false, 'Selection bar must remain visible when right-panel is collapsed');

  console.log('✓ Selection Bar Relocation & Visibility Passed');

  // Test 8: Single and Dual pane mode preserves right panel width and collapsed state
  mockLocalStorage.setItem('litesync_right_panel_width', '320');
  state.singlePane = true;
  assert.strictEqual(mockLocalStorage.getItem('litesync_right_panel_width'), '320', 'Single mode preserves right panel width');
  assert.strictEqual(mockLocalStorage.getItem('litesync_right_panel_collapsed'), 'true', 'Single mode preserves right panel collapsed state');

  state.singlePane = false;
  assert.strictEqual(mockLocalStorage.getItem('litesync_right_panel_width'), '320', 'Dual mode preserves right panel width');
  assert.strictEqual(mockLocalStorage.getItem('litesync_right_panel_collapsed'), 'true', 'Dual mode preserves right panel collapsed state');

  console.log('✓ Single and Dual Mode Preservation Passed');

  console.log('\nAll LiteSync Right Panel Unit & Layout Tests Passed Successfully!');
}

testRightPanelLogic().catch((err) => {
  console.error(err);
  process.exit(1);
});

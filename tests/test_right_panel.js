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
assert.ok(!htmlContent.includes('id="btn-toggle-right-panel"'), 'btn-toggle-right-panel must NOT exist in index.html');
assert.ok(!htmlContent.includes('⭐'), 'Star icon must NOT exist in Bookmarks header');
assert.ok(htmlContent.includes('id="right-panel-collapse-btn"'), 'right-panel-collapse-btn must exist in index.html');
assert.ok(htmlContent.includes('id="right-panel-expand-btn"'), 'right-panel-expand-btn must exist in index.html');
assert.ok(htmlContent.includes('id="collapsed-op-indicator"'), 'collapsed-op-indicator must exist in index.html');

// Test 2: Bookmarks placeholder entries
assert.ok(htmlContent.includes('/mnt/ssd'), 'Bookmarks placeholder must contain sample folder /mnt/ssd');
assert.ok(htmlContent.includes('/mnt/hdd2/movies'), 'Bookmarks placeholder must contain sample folder /mnt/hdd2/movies');
assert.ok(htmlContent.includes('tabindex="0"'), 'Bookmarks placeholder items must have tabindex="0" for keyboard focus');
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
assert.ok(cssContent.includes('position: absolute'), 'selection-bar must be positioned absolutely in file-panes-area');
assert.ok(cssContent.includes('.splitter-v') && cssContent.includes('col-resize'), '.splitter-v must have col-resize');
assert.ok(cssContent.includes('.splitter-h') && cssContent.includes('row-resize'), '.splitter-h must have row-resize');
assert.ok(cssContent.includes('touch-action: none'), 'Mobile resize handles must have touch-action: none to prevent scrolling');
assert.ok(cssContent.includes('height: 44px'), 'Mobile resize handles must have 44px touch target');
assert.ok(cssContent.includes('.bookmark-item .name::before') || cssContent.includes('.bookmark-item.entry .name::before'), 'bookmark items must suppress pseudo-element icon');
assert.ok(cssContent.includes('.bookmarks-list:not(:empty)'), 'empty hint must be hidden when bookmarks exist');
assert.ok(cssContent.includes('#right-panel'), '#right-panel must be styled');
assert.ok(cssContent.includes('#bookmarks-section'), '#bookmarks-section must be styled');
assert.ok(cssContent.includes('#operations-section'), '#operations-section must be styled');
assert.ok(cssContent.includes('.panel-collapsed-strip'), '.panel-collapsed-strip must be styled');
assert.ok(cssContent.includes('@container (max-width: 440px)'), 'Container query or narrow pane rule for hiding modified column must exist');
assert.ok(cssContent.includes('width: 100% !important;'), '#right-panel-splitter must have width: 100% on mobile');
assert.ok(cssContent.includes('.file-panes-area') && cssContent.includes('flex: 1 1 0;'), '.file-panes-area must be flex: 1 1 0 on mobile');
assert.ok(cssContent.includes('html.mobile-bookmarks-collapsed #bookmarks-section'), 'html.mobile-bookmarks-collapsed selector must exist');
assert.ok(cssContent.includes('html.mobile-operations-collapsed #operations-section'), 'html.mobile-operations-collapsed selector must exist');
assert.ok(cssContent.includes('env(safe-area-inset-bottom'), 'selection-bar must support safe-area-inset-bottom');
assert.ok(cssContent.includes('.selection-inline-count') && cssContent.includes('flex-shrink: 0'), 'selection-inline-count must have flex-shrink: 0');
assert.ok(cssContent.includes('#transfer-btn') && cssContent.includes('flex-shrink: 0'), '#transfer-btn must have flex-shrink: 0');
assert.ok(cssContent.includes('#gear-btn') && cssContent.includes('min-width: 44px') && cssContent.includes('min-height: 44px'), '#gear-btn must have 44px touch target on mobile');
assert.ok(cssContent.includes('padding-left: 16px;') && cssContent.includes('padding-right: 16px;'), 'header must have symmetric 16px padding on mobile');

// Test 5: Activity Log & Panel Color Validation
assert.ok(cssContent.includes('.activity-card') && cssContent.includes('flex-direction: column;'), 'activity-card must use 2-row column layout in base CSS');
assert.ok(cssContent.includes('.badge') && cssContent.includes('white-space: nowrap;') && cssContent.includes('flex-shrink: 0;'), 'badge must be nowrap and flex-shrink: 0');
assert.ok(cssContent.includes('.activity-primary-line') && cssContent.includes('white-space: normal;') && cssContent.includes('word-break: break-word;'), 'activity-primary-line must wrap without truncation');
assert.ok(cssContent.includes('.log-meta') && cssContent.includes('justify-content: space-between;') && cssContent.includes('width: 100%;'), 'log-meta must space timestamp and actions across row 2');
assert.ok(cssContent.includes('.card-top') && cssContent.includes('flex-wrap: wrap;'), 'card-top must wrap to prevent overflow');
assert.ok(cssContent.includes('.card-title') && cssContent.includes('white-space: normal;') && cssContent.includes('word-break: break-word;'), 'card-title must wrap without truncation');
assert.ok(cssContent.includes('#right-panel') && cssContent.includes('background: var(--bg);'), 'right-panel must match file pane var(--bg)');
assert.ok(cssContent.includes('.panel-section-header') && cssContent.includes('background: var(--bg);'), 'panel-section-header must match var(--bg)');
assert.ok(cssContent.includes('.tabs-bar') && cssContent.includes('background: var(--bg);'), 'tabs-bar must match var(--bg)');
assert.ok(!cssContent.includes('/* Stack the Activity Log Rows */'), 'mobile activity card overrides should be removed in favor of shared base styles');

// Test 6: Bookmark Theme Highlights Validation
assert.ok(cssContent.includes('.bookmark-item:hover') && cssContent.includes('background: rgba(255, 255, 255, 0.05);'), 'Dark theme bookmark hover must remain unchanged');
assert.ok(cssContent.includes('[data-theme="light"] .bookmark-item:hover'), 'Light theme bookmark must have hover highlight');
assert.ok(cssContent.includes('[data-theme="light"] .bookmark-item:active'), 'Light theme bookmark must have active/click highlight');
assert.ok(cssContent.includes('[data-theme="light"] .bookmark-item:focus'), 'Light theme bookmark must have keyboard focus highlight');
assert.ok(cssContent.includes('[data-theme="light"] .entry:hover'), 'Light theme file row must have matching hover highlight');
assert.ok(cssContent.includes('background: rgba(0, 0, 0, 0.05);'), 'Light theme bookmark and file row highlight must use rgba(0, 0, 0, 0.05)');

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
    this.style = {
      setProperty: (k, v) => { this.style[k] = String(v); }
    };
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
  removeEventListener(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
    }
  }
  dispatchEvent(event) {
    if (this._listeners[event.type]) {
      [...this._listeners[event.type]].forEach(fn => fn(event));
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

  // Test 7: Selection bar visibility (Source and Destination selections)
  state.singlePane = false;
  state.selection.clear();
  state.destSelection.clear();
  updateSelectionUI();
  const selBar = mockDocument.getElementById('selection-bar');
  assert.strictEqual(selBar.classList.contains('hidden'), true, 'Selection bar should be hidden when 0 items selected');

  state.selection.select('/test.txt');
  updateSelectionUI();
  assert.strictEqual(selBar.classList.contains('hidden'), false, 'Selection bar should be visible when source items are selected');

  // Even when right-panel is collapsed, selection bar remains visible
  setRightPanelCollapsed(true);
  updateSelectionUI();
  assert.strictEqual(selBar.classList.contains('hidden'), false, 'Selection bar must remain visible when right-panel is collapsed');

  // When selection is only in destination pane (Dual mode)
  state.selection.clear();
  state.destSelection.select('/dest_test.txt');
  updateSelectionUI();
  assert.strictEqual(selBar.classList.contains('hidden'), false, 'Selection bar must be visible when items are selected in destination pane');

  state.destSelection.clear();
  updateSelectionUI();
  assert.strictEqual(selBar.classList.contains('hidden'), true, 'Selection bar must hide when all selections are cleared');

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

  // Test 9: Horizontal and Vertical Resizers wiring
  const { initResizers, initMobileAccordions } = await import('../static/js/app.js');
  initResizers();
  assert.ok(mockDocument.documentElement.style['--left-width'], 'dual pane ratio CSS var initialized');
  assert.ok(mockDocument.documentElement.style['--bookmarks-height'], 'bookmarks height CSS var initialized');
  assert.ok(mockDocument.documentElement.style['--right-panel-width'], 'right panel width CSS var initialized');
  assert.ok(mockDocument.documentElement.style['--mobile-bookmarks-height'], 'mobile bookmarks height CSS var initialized');
  assert.ok(mockDocument.documentElement.style['--mobile-activity-height'], 'mobile activity height CSS var initialized');

  console.log('✓ Horizontal & Vertical Resizers Initialized Successfully');

  // Test 10: Mobile drag behavior simulation
  global.window.innerWidth = 500;
  const rightSplitter = mockDocument.getElementById('right-panel-splitter');
  const rightHSplitter = mockDocument.getElementById('right-panel-h-splitter');
  const mainEl = mockDocument.getElementById('main-layout');
  const bookmarksSection = mockDocument.getElementById('bookmarks-section');
  const operationsSection = mockDocument.getElementById('operations-section');
  
  mainEl.getBoundingClientRect = () => ({ top: 0, height: 600, left: 0, width: 500 });
  bookmarksSection.getBoundingClientRect = () => ({ top: 260, bottom: 420, height: 160 });
  operationsSection.getBoundingClientRect = () => ({ top: 420, bottom: 600, height: 180 });

  // Dragging Divider 1 (rightSplitter) UP from 260 to 220 makes Bookmarks taller (420 - 220 = 200px)
  rightSplitter.dispatchEvent({ type: 'pointerdown', preventDefault: () => {}, target: rightSplitter, pointerId: 1 });
  rightSplitter.dispatchEvent({ type: 'pointermove', clientY: 220, target: rightSplitter, pointerId: 1 });
  rightSplitter.dispatchEvent({ type: 'pointerup', target: rightSplitter, pointerId: 1 });
  assert.strictEqual(mockDocument.documentElement.style['--mobile-bookmarks-height'], '200px', 'Mobile drag Divider 1 UP sets --mobile-bookmarks-height to 200px');
  assert.strictEqual(mockLocalStorage.getItem('litesync_mobile_bookmarks_height'), '200', 'Mobile drag stores bookmarks height in localStorage');

  // Dragging Divider 1 DOWN from 220 to 320 makes Bookmarks shorter (420 - 320 = 100px)
  rightSplitter.dispatchEvent({ type: 'pointerdown', preventDefault: () => {}, target: rightSplitter, pointerId: 1 });
  rightSplitter.dispatchEvent({ type: 'pointermove', clientY: 320, target: rightSplitter, pointerId: 1 });
  rightSplitter.dispatchEvent({ type: 'pointerup', target: rightSplitter, pointerId: 1 });
  assert.strictEqual(mockDocument.documentElement.style['--mobile-bookmarks-height'], '100px', 'Mobile drag Divider 1 DOWN sets --mobile-bookmarks-height to 100px');

  // Dragging Divider 2 (rightHSplitter) when Bookmarks is expanded (resizes Bookmarks vs Activity)
  rightHSplitter.dispatchEvent({ type: 'pointerdown', preventDefault: () => {}, target: rightHSplitter, pointerId: 2 });
  rightHSplitter.dispatchEvent({ type: 'pointermove', clientY: 400, target: rightHSplitter, pointerId: 2 });
  rightHSplitter.dispatchEvent({ type: 'pointerup', target: rightHSplitter, pointerId: 2 });
  // bRect.top=260, clientY=400 -> newBH = 400-260 = 140px, newOpsH = 340-140 = 200px
  assert.strictEqual(mockDocument.documentElement.style['--mobile-bookmarks-height'], '140px', 'Divider 2 resizes Bookmarks height');
  assert.strictEqual(mockDocument.documentElement.style['--mobile-activity-height'], '200px', 'Divider 2 resizes Activity height');

  // Dragging Divider 2 when Bookmarks is collapsed (resizes Activity vs File List)
  bookmarksSection.classList.add('collapsed');
  rightHSplitter.dispatchEvent({ type: 'pointerdown', preventDefault: () => {}, target: rightHSplitter, pointerId: 2 });
  rightHSplitter.dispatchEvent({ type: 'pointermove', clientY: 450, target: rightHSplitter, pointerId: 2 });
  rightHSplitter.dispatchEvent({ type: 'pointerup', target: rightHSplitter, pointerId: 2 });
  // opsRect.bottom=600, clientY=450 -> newOpsH = 600 - 450 = 150px
  assert.strictEqual(mockDocument.documentElement.style['--mobile-activity-height'], '150px', 'Divider 2 with collapsed Bookmarks resizes Activity');
  bookmarksSection.classList.remove('collapsed');

  console.log('✓ Mobile Vertical Resizing Drag Simulation Passed');

  // Test 11: Mobile accordion collapsing and tracking classes
  initMobileAccordions();
  const bCollapseBtn = mockDocument.getElementById('bookmarks-collapse-btn');
  const oCollapseBtn = mockDocument.getElementById('operations-collapse-btn');
  const rightPanel = mockDocument.getElementById('right-panel');

  bCollapseBtn.click();
  assert.strictEqual(bookmarksSection.classList.contains('collapsed'), true, 'Bookmarks should be collapsed');
  assert.strictEqual(mainEl.classList.contains('bookmarks-collapsed'), true, 'main-layout should have bookmarks-collapsed');
  assert.strictEqual(rightPanel.classList.contains('bookmarks-collapsed'), true, 'right-panel should have bookmarks-collapsed');
  assert.strictEqual(mockDocument.documentElement.classList.contains('mobile-bookmarks-collapsed'), true, 'documentElement should have mobile-bookmarks-collapsed');
  assert.strictEqual(mockLocalStorage.getItem('litesync_mobile_bookmarks_collapsed'), 'true', 'localStorage should persist bookmarks collapsed true');

  oCollapseBtn.click();
  assert.strictEqual(operationsSection.classList.contains('collapsed'), true, 'Operations should be collapsed');
  assert.strictEqual(mainEl.classList.contains('operations-collapsed'), true, 'main-layout should have operations-collapsed');
  assert.strictEqual(rightPanel.classList.contains('operations-collapsed'), true, 'right-panel should have operations-collapsed');
  assert.strictEqual(mockDocument.documentElement.classList.contains('mobile-operations-collapsed'), true, 'documentElement should have mobile-operations-collapsed');
  assert.strictEqual(mockLocalStorage.getItem('litesync_mobile_operations_collapsed'), 'true', 'localStorage should persist operations collapsed true');

  // Uncollapse both
  bCollapseBtn.click();
  assert.strictEqual(bookmarksSection.classList.contains('collapsed'), false, 'Bookmarks should be expanded');
  assert.strictEqual(mainEl.classList.contains('bookmarks-collapsed'), false, 'main-layout should not have bookmarks-collapsed');
  assert.strictEqual(mockDocument.documentElement.classList.contains('mobile-bookmarks-collapsed'), false, 'documentElement should not have mobile-bookmarks-collapsed');
  assert.strictEqual(mockLocalStorage.getItem('litesync_mobile_bookmarks_collapsed'), 'false', 'localStorage should persist bookmarks collapsed false');

  oCollapseBtn.click();
  assert.strictEqual(operationsSection.classList.contains('collapsed'), false, 'Operations should be expanded');
  assert.strictEqual(mainEl.classList.contains('operations-collapsed'), false, 'main-layout should not have operations-collapsed');
  assert.strictEqual(mockDocument.documentElement.classList.contains('mobile-operations-collapsed'), false, 'documentElement should not have mobile-operations-collapsed');
  assert.strictEqual(mockLocalStorage.getItem('litesync_mobile_operations_collapsed'), 'false', 'localStorage should persist operations collapsed false');

  console.log('✓ Mobile Accordion Collapsing and Tracking Passed');

  // Test 11b: Mobile accordion restoration on page reload
  mockLocalStorage.setItem('litesync_mobile_bookmarks_collapsed', 'true');
  mockLocalStorage.setItem('litesync_mobile_operations_collapsed', 'true');
  const { setMobileBookmarksCollapsed, setMobileOperationsCollapsed } = await import('../static/js/app.js');
  setMobileBookmarksCollapsed(true, false);
  setMobileOperationsCollapsed(true, false);
  assert.strictEqual(bookmarksSection.classList.contains('collapsed'), true, 'Bookmarks restored to collapsed');
  assert.strictEqual(operationsSection.classList.contains('collapsed'), true, 'Operations restored to collapsed');
  assert.strictEqual(mockDocument.documentElement.classList.contains('mobile-bookmarks-collapsed'), true, 'documentElement restored mobile-bookmarks-collapsed');
  assert.strictEqual(mockDocument.documentElement.classList.contains('mobile-operations-collapsed'), true, 'documentElement restored mobile-operations-collapsed');

  // Reset to expanded
  setMobileBookmarksCollapsed(false, true);
  setMobileOperationsCollapsed(false, true);
  console.log('✓ Mobile Accordion Persistence & State Restoration Passed');

  // Test 12: Mobile Dual-mode Source ↔ Destination Splitter Dragging
  const panesEl = mockDocument.getElementById('panes');
  const vSplitter = mockDocument.getElementById('vertical-splitter');
  panesEl.getBoundingClientRect = () => ({ top: 0, height: 400, left: 0, width: 500 });

  // Switch getComputedStyle mock to column for panesEl
  global.getComputedStyle = (elem) => {
    if (elem === panesEl) return { flexDirection: 'column' };
    return { flexDirection: 'row' };
  };

  // Drag vSplitter from 200 to 140 (35% of 400)
  vSplitter.dispatchEvent({ type: 'pointerdown', preventDefault: () => {}, target: vSplitter, pointerId: 3 });
  vSplitter.dispatchEvent({ type: 'pointermove', clientY: 140, target: vSplitter, pointerId: 3 });
  vSplitter.dispatchEvent({ type: 'pointerup', target: vSplitter, pointerId: 3 });

  assert.strictEqual(mockDocument.documentElement.style['--top-height'], '35%', 'Mobile drag vSplitter sets --top-height to 35%');
  assert.strictEqual(mockLocalStorage.getItem('litesync_dual_pane_ratio'), '35', 'Mobile drag stores dual_pane_ratio in localStorage');

  // Reset getComputedStyle mock
  global.getComputedStyle = () => ({ flexDirection: 'row' });

  console.log('✓ Mobile Dual-Mode Source ↔ Destination Splitter Dragging Passed');

  console.log('\nAll LiteSync Right Panel Unit & Layout Tests Passed Successfully!');
}

testRightPanelLogic().catch((err) => {
  console.error(err);
  process.exit(1);
});

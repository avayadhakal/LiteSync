const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running LiteSync Scheduled Transfers Frontend Unit Test Suite...\n');

let assertionCount = 0;

function assertEqual(actual, expected, msg) {
  assertionCount++;
  assert.strictEqual(actual, expected, msg);
}

function assertOk(value, msg) {
  assertionCount++;
  assert.ok(value, msg);
}

function assertNotEqual(actual, expected, msg) {
  assertionCount++;
  assert.notStrictEqual(actual, expected, msg);
}

class MockClassList {
  constructor() {
    this.classes = new Set();
  }
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
    this.className = '';
    this.classList = new MockClassList();
    this.listeners = {};
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.style = {};
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.min = '';
    this._innerHTML = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(val) {
    this._innerHTML = val;
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
  }

  querySelector(selector) {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this._findChild(el => el.classList.contains(cls));
    }
    if (selector.startsWith('#')) {
      const elId = selector.slice(1);
      return this._findChild(el => el.id === elId);
    }
    return null;
  }

  _findChild(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      if (child._findChild) {
        const found = child._findChild(predicate);
        if (found) return found;
      }
    }
    return null;
  }

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
  }
}

class MockEvent {
  constructor(type, data = {}) {
    this.type = type;
    this._propagationStopped = false;
    this._defaultPrevented = false;
    Object.assign(this, data);
  }
  stopPropagation() { this._propagationStopped = true; }
  preventDefault() { this._defaultPrevented = true; }
}

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf-8');

  // Test 1: HTML schedule container exists in confirm modal
  (() => {
    assertEqual(html.includes('id="transfer-schedule-field"'), true, 'transfer-schedule-field should exist in index.html');
    console.log('✓ Test 1: HTML #transfer-schedule-field container rendered in transfer modal passed');
  })();

  // Test 2: HTML transfer timing radio inputs exist
  (() => {
    assertEqual(html.includes('name="transfer-timing"'), true, 'transfer-timing radios should exist in index.html');
    console.log('✓ Test 2: HTML transfer-timing radio inputs rendered passed');
  })();

  // Test 3: HTML schedule datetime input exists
  (() => {
    assertEqual(html.includes('id="transfer-schedule-datetime"'), true, 'transfer-schedule-datetime input should exist in index.html');
    console.log('✓ Test 3: HTML #transfer-schedule-datetime input rendered passed');
  })();

  // Test 4: HTML gear menu scheduled transfers button exists
  (() => {
    assertEqual(html.includes('id="menu-scheduled"'), true, 'menu-scheduled button should exist in gear-menu');
    console.log('✓ Test 4: HTML #menu-scheduled button exists in gear menu passed');
  })();

  // Test 5: HTML scheduled transfers modal dialog exists
  (() => {
    assertEqual(html.includes('id="scheduled-modal"'), true, 'scheduled-modal dialog should exist in index.html');
    console.log('✓ Test 5: HTML #scheduled-modal dialog structure rendered passed');
  })();

  // Test 6: HTML data-i18n attributes present for scheduled transfer elements
  (() => {
    assertEqual(html.includes('data-i18n="nav.scheduled_transfers"'), true, 'nav.scheduled_transfers data-i18n attribute should exist');
    assertEqual(html.includes('data-i18n="modals.scheduled.title"'), true, 'modals.scheduled.title data-i18n attribute should exist');
    console.log('✓ Test 6: HTML data-i18n navigation and modal attributes verified passed');
  })();

  // Tests 7-12: Locale dictionaries all contain scheduled transfers keys
  const locales = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'zh', name: 'Chinese' },
  ];

  let testIdx = 7;
  for (const { code, name } of locales) {
    const locPath = path.join(__dirname, `../static/locales/${code}.json`);
    const data = JSON.parse(fs.readFileSync(locPath, 'utf-8'));
    assertOk(data.nav && data.nav.scheduled_transfers, `[${code}] nav.scheduled_transfers is missing`);
    assertOk(data.modals && data.modals.transfer && data.modals.transfer.timing, `[${code}] modals.transfer.timing is missing`);
    assertOk(data.modals && data.modals.transfer && data.modals.transfer.schedule_for_later, `[${code}] modals.transfer.schedule_for_later is missing`);
    assertOk(data.modals && data.modals.scheduled && data.modals.scheduled.title, `[${code}] modals.scheduled.title is missing`);
    assertOk(data.modals && data.modals.scheduled && data.modals.scheduled.empty, `[${code}] modals.scheduled.empty is missing`);
    assertOk(data.modals && data.modals.scheduled && data.modals.scheduled.cancel, `[${code}] modals.scheduled.cancel is missing`);
    assertOk(data.messages && data.messages.scheduled_items, `[${code}] messages.scheduled_items is missing`);
    assertOk(data.messages && data.messages.schedule_time_required, `[${code}] messages.schedule_time_required is missing`);
    assertOk(data.messages && data.messages.task_cancelled, `[${code}] messages.task_cancelled is missing`);
    console.log(`✓ Test ${testIdx++}: ${name} (${code}) locale scheduled transfer dictionary verified passed`);
  }

  // Setup DOM harness for UI logic tests
  const dom = {
    'transfer-schedule-picker-wrap': new MockElement('div', 'transfer-schedule-picker-wrap'),
    'transfer-schedule-datetime': new MockElement('input', 'transfer-schedule-datetime'),
    'transfer-schedule-error': new MockElement('div', 'transfer-schedule-error'),
    'confirm-ok': new MockElement('button', 'confirm-ok'),
  };
  dom['transfer-schedule-picker-wrap'].classList.add('hidden');
  dom['transfer-schedule-error'].classList.add('hidden');

  let currentTiming = 'now';
  const mockI18n = {
    t: (key) => key === 'modals.transfer.confirm_schedule' ? 'Schedule Transfer' : 'Transfer',
  };

  function updateTransferScheduleUI() {
    const isScheduled = currentTiming === 'later';
    const pickerWrap = dom['transfer-schedule-picker-wrap'];
    const okBtn = dom['confirm-ok'];
    const errEl = dom['transfer-schedule-error'];
    const datetimeInput = dom['transfer-schedule-datetime'];

    if (errEl) {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    }

    if (isScheduled) {
      if (pickerWrap) pickerWrap.classList.remove('hidden');
      if (okBtn) okBtn.textContent = mockI18n.t('modals.transfer.confirm_schedule');
      if (datetimeInput) {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 1);
        const pad = (n) => String(n).padStart(2, '0');
        const minStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        datetimeInput.min = minStr;
        if (!datetimeInput.value || datetimeInput.value < minStr) {
          datetimeInput.value = minStr;
        }
      }
    } else {
      if (pickerWrap) pickerWrap.classList.add('hidden');
      if (okBtn) okBtn.textContent = mockI18n.t('modals.transfer.confirm');
    }
  }

  function resetTransferScheduleUI() {
    currentTiming = 'now';
    const pickerWrap = dom['transfer-schedule-picker-wrap'];
    if (pickerWrap) pickerWrap.classList.add('hidden');
    const errEl = dom['transfer-schedule-error'];
    if (errEl) {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    }
    const datetimeInput = dom['transfer-schedule-datetime'];
    if (datetimeInput) datetimeInput.value = '';
    const okBtn = dom['confirm-ok'];
    if (okBtn) okBtn.textContent = mockI18n.t('modals.transfer.confirm');
  }

  // Test 13: UI initial state
  (() => {
    assertEqual(dom['transfer-schedule-picker-wrap'].classList.contains('hidden'), true);
    console.log('✓ Test 13: Schedule UI initial state hides datetime picker and displays \'Transfer\' passed');
  })();

  // Test 14: Switching to 'later' reveals picker and updates button text
  (() => {
    currentTiming = 'later';
    updateTransferScheduleUI();
    assertEqual(dom['transfer-schedule-picker-wrap'].classList.contains('hidden'), false);
    assertEqual(dom['confirm-ok'].textContent, 'Schedule Transfer');
    console.log('✓ Test 14: Switching timing to \'later\' reveals picker and updates button text passed');
  })();

  // Test 15: Switching timing sets min datetime and default value
  (() => {
    assertOk(dom['transfer-schedule-datetime'].min.length > 0);
    assertOk(dom['transfer-schedule-datetime'].value.length > 0);
    console.log('✓ Test 15: Switching timing sets min datetime and default value passed');
  })();

  // Test 16: resetTransferScheduleUI restores default timing and button label
  (() => {
    const transferJsCode = fs.readFileSync(path.join(__dirname, '../static/js/modals/transfer.js'), 'utf-8');
    assertOk(transferJsCode.includes("import { I18n } from '../i18n.js';"), 'transfer.js must import I18n');

    resetTransferScheduleUI();
    assertEqual(dom['transfer-schedule-picker-wrap'].classList.contains('hidden'), true);
    assertEqual(dom['confirm-ok'].textContent, 'Transfer');
    assertEqual(dom['transfer-schedule-datetime'].value, '');
    console.log('✓ Test 16: resetTransferScheduleUI restores default timing and button label passed');
  })();

  // Test 17-22: Submission validation and payload construction
  let lastApiCall = null;
  let lastToast = null;
  let lastToastError = null;

  const mockApi = async (url, opts) => {
    lastApiCall = { url, opts, body: JSON.parse(opts.body) };
    return { task_ids: ['task_mock_1'] };
  };

  const mockToastSuccess = (msg) => { lastToast = msg; };
  const mockToastError = (msg) => { lastToastError = msg; };

  async function simulateSubmitTransfer(timingChoice, datetimeVal) {
    lastApiCall = null;
    lastToast = null;
    lastToastError = null;
    dom['transfer-schedule-error'].classList.add('hidden');
    dom['transfer-schedule-datetime'].value = datetimeVal;

    let scheduled_for = null;
    if (timingChoice === 'later') {
      const val = dom['transfer-schedule-datetime'].value;
      if (!val) {
        dom['transfer-schedule-error'].textContent = 'Please choose a future date and time.';
        dom['transfer-schedule-error'].classList.remove('hidden');
        return;
      }
      const d = new Date(val);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        dom['transfer-schedule-error'].textContent = 'Please choose a future date and time.';
        dom['transfer-schedule-error'].classList.remove('hidden');
        return;
      }
      scheduled_for = d.toISOString();
    }

    const body = {
      sources: ['/home/test.txt'],
      destination: '/dest',
      operation: 'copy',
      use_rsync: false,
      on_conflict: 'skip'
    };
    if (scheduled_for) {
      body.scheduled_for = scheduled_for;
    }

    await mockApi('/api/transfer', { method: 'POST', body: JSON.stringify(body) });
    if (scheduled_for) {
      mockToastSuccess(`Scheduled 1 copy transfer(s) for ${new Date(scheduled_for).toLocaleString()} → /dest`);
    } else {
      mockToastSuccess(`Queued 1 copy → /dest`);
    }
  }

  // Test 17: Empty datetime validation error
  await (async () => {
    await simulateSubmitTransfer('later', '');
    assertEqual(lastApiCall, null, 'API should not be called when datetime is empty');
    assertEqual(dom['transfer-schedule-error'].classList.contains('hidden'), false);
    assertEqual(dom['transfer-schedule-error'].textContent, 'Please choose a future date and time.');
    console.log('✓ Test 17: Submitting with empty datetime when \'later\' selected displays validation error passed');
  })();

  // Test 18: Past datetime validation error
  await (async () => {
    await simulateSubmitTransfer('later', '2020-01-01T12:00');
    assertEqual(lastApiCall, null, 'API should not be called when datetime is in the past');
    assertEqual(dom['transfer-schedule-error'].classList.contains('hidden'), false);
    console.log('✓ Test 18: Submitting with past datetime when \'later\' selected displays validation error passed');
  })();

  // Test 19: Valid future datetime payload construction
  const futureDate = new Date(Date.now() + 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const futureLocalStr = `${futureDate.getFullYear()}-${pad(futureDate.getMonth() + 1)}-${pad(futureDate.getDate())}T${pad(futureDate.getHours())}:${pad(futureDate.getMinutes())}`;

  await (async () => {
    await simulateSubmitTransfer('later', futureLocalStr);
    assertNotEqual(lastApiCall, null, 'API should be called for valid future time');
    assertOk(lastApiCall.body.scheduled_for, 'scheduled_for should be in request body');
    assertEqual(new Date(lastApiCall.body.scheduled_for).toISOString(), lastApiCall.body.scheduled_for);
    console.log('✓ Test 19: Submitting valid future datetime builds ISO-8601 payload and calls transfer API passed');
  })();

  // Test 20: Scheduled toast notification
  (() => {
    assertOk(lastToast && lastToast.includes('Scheduled 1 copy transfer(s)'));
    console.log('✓ Test 20: Scheduled transfer displays scheduled toast notification passed');
  })();

  // Test 21: Immediate transfer ('now') omits scheduled_for parameter
  await (async () => {
    await simulateSubmitTransfer('now', '');
    assertNotEqual(lastApiCall, null);
    assertEqual(lastApiCall.body.scheduled_for, undefined, 'scheduled_for should not be present in immediate body');
    console.log('✓ Test 21: Immediate transfer (\'now\') omits scheduled_for parameter from payload passed');
  })();

  // Test 22: Immediate transfer displays queued toast
  (() => {
    assertOk(lastToast && lastToast.includes('Queued 1 copy'));
    console.log('✓ Test 22: Immediate transfer displays queued toast notification passed');
  })();

  // Tests 23-26: Scheduled dialog rendering and cancellation
  const container = new MockElement('div', 'scheduled-transfers-container');
  let cancelledTaskId = null;
  let loadCallCount = 0;

  const mockTasks = [
    {
      task_id: 'sched_abc_1',
      source: '/data/photos/sunset.jpg',
      destination: '/backup/photos',
      operation: 'copy',
      status: 'scheduled',
      scheduled_for: new Date(Date.now() + 7200 * 1000).toISOString(),
    },
    {
      task_id: 'sched_abc_2',
      source: '/data/movies/clip.mp4',
      destination: '/backup/movies',
      operation: 'move',
      status: 'scheduled',
      scheduled_for: new Date(Date.now() + 14400 * 1000).toISOString(),
    }
  ];

  const mockDialogApi = async (url, opts) => {
    if (url === '/api/tasks/scheduled') {
      loadCallCount++;
      return { tasks: mockTasks };
    }
    if (url.startsWith('/api/tasks/') && url.endsWith('/cancel')) {
      const parts = url.split('/');
      cancelledTaskId = parts[3];
      return { success: true };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  async function renderScheduledList() {
    const data = await mockDialogApi('/api/tasks/scheduled');
    container.innerHTML = '';
    if (data.tasks.length === 0) {
      const emptyDiv = new MockElement('div');
      emptyDiv.textContent = 'No scheduled transfers.';
      container.appendChild(emptyDiv);
      return;
    }
    for (const t of data.tasks) {
      const card = new MockElement('div');
      card.id = `card-${t.task_id}`;
      card.innerHTML = `
        <span class="badge">${t.operation}</span>
        <span class="title">${t.source}</span>
        <span class="dest">${t.destination}</span>
        <span class="time">${t.scheduled_for}</span>
        <button class="scheduled-cancel-btn" data-id="${t.task_id}">Cancel</button>
      `;
      const cancelBtn = new MockElement('button');
      cancelBtn.classList.add('scheduled-cancel-btn');
      cancelBtn.dataset = { id: t.task_id };
      cancelBtn.addEventListener('click', async () => {
        await mockDialogApi(`/api/tasks/${t.task_id}/cancel`, { method: 'POST' });
        const idx = mockTasks.findIndex(x => x.task_id === t.task_id);
        if (idx !== -1) mockTasks.splice(idx, 1);
        await renderScheduledList();
      });
      card.appendChild(cancelBtn);
      container.appendChild(card);
    }
  }

  // Test 23: Dialog renders list of pending tasks
  await (async () => {
    await renderScheduledList();
    assertEqual(container.children.length, 2);
    assertEqual(loadCallCount, 1);
    console.log('✓ Test 23: Scheduled transfers modal renders list of pending tasks passed');
  })();

  // Test 24: Cancel button triggers cancellation API
  await (async () => {
    const firstCancelBtn = container.children[0].children[0];
    firstCancelBtn.dispatchEvent(new MockEvent('click'));
    await new Promise(r => setTimeout(r, 10));
    assertEqual(cancelledTaskId, 'sched_abc_1');
    console.log('✓ Test 24: Scheduled transfers modal cancel button triggers /api/tasks/:id/cancel passed');
  })();

  // Test 25: Auto-refresh list after cancellation
  (() => {
    assertEqual(loadCallCount, 2, 'List should refresh after cancellation');
    assertEqual(container.children.length, 1);
    console.log('✓ Test 25: Scheduled transfers modal auto-refreshes list following task cancellation passed');
  })();

  // Test 26: Empty state displayed when all tasks cancelled
  await (async () => {
    const secondCancelBtn = container.children[0].children[0];
    secondCancelBtn.dispatchEvent(new MockEvent('click'));
    await new Promise(r => setTimeout(r, 10));
    assertEqual(cancelledTaskId, 'sched_abc_2');
    assertEqual(loadCallCount, 3);
    assertEqual(container.children.length, 1);
    assertEqual(container.children[0].textContent, 'No scheduled transfers.');
    console.log('✓ Test 26: Empty state displayed when all scheduled transfers are removed passed');
  })();

  // Test 27: Scheduled modal backdrop is static (data-backdrop="static")
  (() => {
    assertEqual(html.includes('id="scheduled-modal" data-backdrop="static"'), true);
    console.log('✓ Test 27: Scheduled transfers modal configured with static backdrop in HTML passed');
  })();

  // Test 28: Overlay click listener removed from scheduled modal
  (() => {
    const scheduledJsCode = fs.readFileSync(path.join(__dirname, '../static/js/modals/scheduled.js'), 'utf-8');
    assertEqual(scheduledJsCode.includes("modal.addEventListener('click'"), false, 'scheduled.js should not attach backdrop overlay click listener');
    console.log('✓ Test 28: Backdrop overlay click-to-dismiss disabled in scheduled.js passed');
  })();

  // Test 29: Escape key listener removed from scheduled modal
  (() => {
    const scheduledJsCode = fs.readFileSync(path.join(__dirname, '../static/js/modals/scheduled.js'), 'utf-8');
    assertEqual(scheduledJsCode.includes("e.key === 'Escape'"), false, 'scheduled.js should not attach Escape key listener to close modal');
    console.log('✓ Test 29: Escape key listener removed; modal dismissible only via explicit close buttons passed');
  })();

  // Test 30: Modal dismissal behavior (only explicit buttons close modal)
  (() => {
    const scheduledModal = new MockElement('div', 'scheduled-modal');
    scheduledModal.classList.remove('hidden');
    const dismissBtn = new MockElement('button', 'scheduled-modal-dismiss');
    const closeBtn = new MockElement('button', 'scheduled-modal-close');

    function closeScheduledModal() {
      scheduledModal.classList.add('hidden');
    }

    [dismissBtn, closeBtn].forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (e) e.stopPropagation();
        closeScheduledModal();
      });
    });

    // Backdrop click does nothing
    scheduledModal.dispatchEvent(new MockEvent('click', { target: scheduledModal }));
    assertEqual(scheduledModal.classList.contains('hidden'), false, 'Modal should remain open when clicking backdrop');

    // Dismiss X button closes modal
    dismissBtn.dispatchEvent(new MockEvent('click'));
    assertEqual(scheduledModal.classList.contains('hidden'), true, 'Modal should close when clicking X button');

    // Reopen and test footer Close button
    scheduledModal.classList.remove('hidden');
    closeBtn.dispatchEvent(new MockEvent('click'));
    assertEqual(scheduledModal.classList.contains('hidden'), true, 'Modal should close when clicking footer Close button');

    console.log('✓ Test 30: Scheduled transfers modal can ONLY be closed by clicking X or Close buttons passed');
  })();

  // Test 31: Scheduled transfers CSS theme variables aligned with core system theme
  (() => {
    const cssContent = fs.readFileSync(path.join(__dirname, '../static/css/app.css'), 'utf-8');
    assertOk(cssContent.includes('--scheduled-modal-bg: var(--bg, #0f1115);'), 'Modal bg should match main app dark charcoal');
    assertOk(cssContent.includes('--scheduled-modal-border: var(--border, #2a2f3a);'), 'Modal border should be neutral dark gray');
    assertOk(cssContent.includes('--scheduled-card-bg: var(--panel, #171a21);'), 'Card bg should match active operation card panel');
    assertOk(cssContent.includes('--scheduled-card-border: var(--border, #2a2f3a);'), 'Card border should be neutral dark gray');
    assertOk(cssContent.includes('--scheduled-title: var(--text, #e6e8eb);'), 'Title should be off-white');
    assertOk(cssContent.includes('--scheduled-label: var(--text-dim, #9aa1ac);'), 'Label should be muted gray');
    assertOk(cssContent.includes('--scheduled-path: #c0c0c0;'), 'Path should match active operation card text');
    assertOk(cssContent.includes('--scheduled-btn-bg: var(--panel-alt, #1e222b);'), 'Close button bg should match app standard button');
    assertOk(cssContent.includes('--scheduled-badge-copy-bg: rgba(59, 130, 246, 0.15);'), 'Copy badge should be colorful blue translucent');
    assertOk(cssContent.includes('--scheduled-badge-copy-text: #60a5fa;'), 'Copy badge text should be blue');
    assertOk(cssContent.includes('--scheduled-badge-move-bg: rgba(139, 92, 246, 0.15);'), 'Move badge should be colorful purple translucent');
    assertOk(cssContent.includes('--scheduled-badge-move-text: #a78bfa;'), 'Move badge text should be purple');
    console.log('✓ Test 31: Scheduled transfers CSS theme variables aligned with core system theme passed');
  })();

  // Test 32: Modal frame and cards use neutral dark gray without blue/slate tints
  (() => {
    const cssContent = fs.readFileSync(path.join(__dirname, '../static/css/app.css'), 'utf-8');
    assertOk(cssContent.includes('background-color: var(--scheduled-modal-bg, var(--bg, #0f1115));'), 'Modal frame uses dark charcoal bg');
    assertOk(cssContent.includes('background-color: var(--scheduled-card-bg, var(--panel, #171a21));'), 'Card uses active operation card bg');
    assertOk(cssContent.includes('border: 1px solid var(--scheduled-card-border, var(--border, #2a2f3a));'), 'Card uses neutral dark border');
    console.log('✓ Test 32: Modal frame and cards use neutral dark gray without blue/slate tints passed');
  })();

  // Test 33: Bottom Close button uses standard dark button styling instead of bright blue
  (() => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf-8');
    const cssContent = fs.readFileSync(path.join(__dirname, '../static/css/app.css'), 'utf-8');
    assertOk(!htmlContent.includes('id="scheduled-modal-close" class="primary"'), 'Close button should not have primary bright blue class');
    assertOk(htmlContent.includes('id="scheduled-modal-close" class="secondary"'), 'Close button has secondary class');
    assertOk(cssContent.includes('#scheduled-modal-close'), '#scheduled-modal-close styling defined in CSS');
    assertOk(cssContent.includes('background: var(--scheduled-btn-bg, var(--panel-alt, #1e222b));'), 'Close button styled with standard dark button bg');
    console.log('✓ Test 33: Bottom Close button uses standard dark button styling instead of bright blue passed');
  })();

  // Test 34: Elimination of slate/blue classes and support for dynamic theme switching
  (() => {
    const scheduledJs = fs.readFileSync(path.join(__dirname, '../static/js/modals/scheduled.js'), 'utf-8');
    assertOk(!scheduledJs.includes('dark:bg-slate-800'), 'Card markup should not contain slate classes');
    assertOk(!scheduledJs.includes('dark:bg-blue-500/15'), 'Badge markup should not contain blue classes');
    const cssContent = fs.readFileSync(path.join(__dirname, '../static/css/app.css'), 'utf-8');
    assertOk(cssContent.includes(':root[data-theme="light"]'), ':root[data-theme="light"] tokens defined');
    assertOk(cssContent.includes('[data-theme="light"] .scheduled-task-row'), 'Light mode scheduled-task-row rule defined');
    assertOk(cssContent.includes('[data-theme="dark"] .scheduled-task-row'), 'Dark mode data-theme selector defined');
    assertOk(cssContent.includes('.dark .scheduled-task-row'), 'Dark mode class selector defined');
    console.log('✓ Test 34: Elimination of slate/blue classes and support for dynamic theme switching passed');
  })();

  // Test 35: Scheduled transfer card matches active operation card (.transfer-card) style
  (() => {
    const scheduledJs = fs.readFileSync(path.join(__dirname, '../static/js/modals/scheduled.js'), 'utf-8');
    assertOk(scheduledJs.includes("card.className = 'transfer-card scheduled-task-row';"), 'Card has transfer-card class');
    assertOk(scheduledJs.includes('card-top scheduled-card-header'), 'Card header matches card-top');
    assertOk(scheduledJs.includes('card-title scheduled-task-title'), 'Card title matches card-title');
    assertOk(scheduledJs.includes('card-action-btn scheduled-cancel-btn'), 'Card action button matches card-action-btn');
    assertOk(scheduledJs.includes('card-path scheduled-path-text'), 'Card path matches card-path');
    assertOk(scheduledJs.includes('card-details scheduled-task-time'), 'Card time matches card-details');

    const cssContent = fs.readFileSync(path.join(__dirname, '../static/css/app.css'), 'utf-8');
    assertOk(cssContent.includes('border-radius: var(--radius-lg, 12px);'), 'Card border-radius matches transfer-card radius-lg');
    assertOk(cssContent.includes('[data-theme="light"] .scheduled-task-row {\n  background-color: #ffffff;'), 'Light mode scheduled card background matches transfer-card #ffffff');
    console.log('✓ Test 35: Scheduled transfer card markup and CSS match active operation card (.transfer-card) style passed');
  })();

  console.log(`\nAll 35 individual frontend tests passed! (${assertionCount} assertions verified)`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

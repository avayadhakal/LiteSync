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
    this._innerHTML = '';
    this._listeners = {};
    this.disabled = false;
    this.children = [];
  }
  
  get innerHTML() {
    return this._innerHTML;
  }
  
  set innerHTML(val) {
    this._innerHTML = val;
    this._syncFromHTML(val);
  }

  _syncFromHTML(html) {
    // Parse IDs and classes into mock children registry so getElementById and querySelector work
    const idRegex = /id="([^"]+)"/g;
    let match;
    while ((match = idRegex.exec(html)) !== null) {
      const elId = match[1];
      if (!mockDocument.elements[elId]) {
        mockDocument.elements[elId] = new MockElement(elId);
      }
    }
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

  querySelector(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      if (this.innerHTML.includes(`class="`) && this.innerHTML.includes(cls)) {
        const dummy = new MockElement(null, 'button');
        dummy.classList.add(cls);
        return dummy;
      }
    }
    return null;
  }
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
  querySelector(sel) { return null; },
  addEventListener() {}
};

class MockEventSource {
  constructor(url) {
    this.url = url;
    this._listeners = {};
    this.readyState = 1;
    MockEventSource.instances.push(this);
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
  simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data });
  }
  simulateStatus(status) {
    this.dispatchEvent({ type: 'status', data: JSON.stringify({ status }) });
  }
  close() {
    this.readyState = 2;
    MockEventSource.closedCount++;
  }
}
MockEventSource.instances = [];
MockEventSource.closedCount = 0;

const mockLocalStorage = {
  store: {},
  getItem(k) { return this.store.hasOwnProperty(k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
  clear() { this.store = {}; }
};

global.document = mockDocument;
global.localStorage = mockLocalStorage;
global.EventSource = MockEventSource;
global.window = { location: { href: '' }, isSecureContext: true };
global.navigator = { clipboard: { writeText: async () => {} } };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let apiCalls = [];
global.fetch = async (path, opts) => {
  apiCalls.push({ path, opts });
  if (path === '/api/roots') {
    return { ok: true, status: 200, json: async () => ({ roots: ['/root1', '/root2'] }) };
  }
  if (path.startsWith('/api/browse')) {
    return { ok: true, status: 200, json: async () => ({ path: '/', entries: [], parent: null }) };
  }
  if (path.startsWith('/api/activity')) {
    return { ok: true, status: 200, json: async () => ({ activity: [] }) };
  }
  if (path.startsWith('/api/tasks/')) {
    const id = path.split('/')[3];
    return { ok: true, status: 200, json: async () => ({ status: 'running', task_id: id }) };
  }
  if (path.startsWith('/api/tasks')) {
    return { ok: true, status: 200, json: async () => ({ tasks: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

(async () => {
  console.log('Running LiteSync Tasks UI & State Transitions Test Suite...');

  const { state } = await import('../static/js/state.js');
  state.roots = ['/root1', '/root2'];
  const tasksUi = await import('../static/js/tasks-ui.js');

  const runTest = async (name, fn) => {
    mockDocument.elements = {};
    mockDocument.elements['active-transfers-container'] = new MockElement('active-transfers-container');
    MockEventSource.instances = [];
    MockEventSource.closedCount = 0;
    tasksUi.activeStreams.clear();
    state.historyTab = 'active';
    state.tasks = [];
    apiCalls = [];

    try {
      await fn();
      console.log(`✓ ${name} passed`);
    } catch (e) {
      console.error(`✗ ${name} failed`);
      console.error(e);
      process.exit(1);
    }
  };

  await runTest('Test 1: Queued task renders explicit Queued status label and Cancel button only', async () => {
    const taskQueued = {
      task_id: 'task_q1',
      source: '/data/source/file1.txt',
      destination: '/data/dest',
      status: 'queued',
      use_rsync: true,
      created_at: new Date().toISOString()
    };
    state.tasks = [taskQueued];

    tasksUi.renderActiveTransfers();

    const container = mockDocument.getElementById('active-transfers-container');
    assert.strictEqual(container.children.length, 1);

    const card = container.children[0];
    const html = card.innerHTML;

    // Check for explicit "Queued" status badge
    assert.strictEqual(html.includes('Queued'), true, 'Card HTML should contain "Queued"');
    assert.strictEqual(html.includes('0%'), true, 'Card HTML should contain "0%"');
    // Check for Cancel button
    assert.strictEqual(html.includes('Cancel'), true, 'Card HTML should contain "Cancel" button');
    // Check that Pause button is NOT present while queued
    assert.strictEqual(html.includes('pause-btn'), false, 'Card should not contain pause-btn when queued');
    // EventSource attached
    assert.strictEqual(MockEventSource.instances.length, 1);
  });

  await runTest('Test 2: Authoritative status event (queued -> running) updates card in-place with Pause+Cancel and no stream teardown', async () => {
    const task = {
      task_id: 'task_q2',
      source: '/data/source/file2.txt',
      destination: '/data/dest',
      status: 'queued',
      use_rsync: true,
      created_at: new Date().toISOString()
    };
    state.tasks = [task];

    tasksUi.renderActiveTransfers();
    const es = MockEventSource.instances[0];
    assert.strictEqual(MockEventSource.closedCount, 0);

    // Simulate backend sending authoritative status event: running
    es.simulateStatus('running');

    assert.strictEqual(task.status, 'running');
    // Stream must NOT have been closed or torn down
    assert.strictEqual(MockEventSource.closedCount, 0);
    assert.strictEqual(tasksUi.activeStreams.has('task_q2'), true);

    const topControls = mockDocument.getElementById('top-controls-task_q2');
    const controlsHtml = topControls.innerHTML;

    // "Queued" badge must be gone or hidden, Pause button must now be present
    assert.strictEqual(controlsHtml.includes('pause-btn'), true, 'Pause button should be present after transition to running');
    assert.strictEqual(controlsHtml.includes('cancel-btn'), true, 'Cancel button should be present');
    assert.strictEqual(controlsHtml.includes('badge-status-queued'), false, 'Queued badge should not be in controls');
  });

  await runTest('Test 3: Live progress lines update percentage and file detail', async () => {
    const task = {
      task_id: 'task_q3',
      source: '/data/source/file3.txt',
      destination: '/data/dest',
      status: 'running',
      use_rsync: true,
      created_at: new Date().toISOString()
    };
    state.tasks = [task];

    tasksUi.renderActiveTransfers();
    const es = MockEventSource.instances[0];

    // Simulate rsync filename and percent log line
    es.simulateMessage('document.pdf');
    const detailEl = mockDocument.getElementById('progress-detail-task_q3');
    assert.strictEqual(detailEl.textContent, 'Copying: document.pdf');

    es.simulateMessage('150.00M 45% 1.2MB/s 0:00:02');
    const pctEl = mockDocument.getElementById('progress-pct-task_q3');
    const fillEl = mockDocument.getElementById('progress-fill-task_q3');
    const speedEl = mockDocument.getElementById('progress-speed-task_q3');
    const sizeEl = mockDocument.getElementById('progress-size-task_q3');
    assert.strictEqual(pctEl.textContent, '45%');
    assert.strictEqual(fillEl.style.width, '45%');
    assert.strictEqual(speedEl.textContent, '1.2MB/s');
    assert.strictEqual(sizeEl.textContent.includes('150.0 MB'), true);
  });

  await runTest('Test 4: Pause/Resume transitions update controls in place', async () => {
    const task = {
      task_id: 'task_q4',
      source: '/data/source/file4.txt',
      destination: '/data/dest',
      status: 'running',
      use_rsync: true,
      created_at: new Date().toISOString()
    };
    state.tasks = [task];

    tasksUi.renderActiveTransfers();

    // Transition to paused via status event
    const es = MockEventSource.instances[0];
    es.simulateStatus('paused');

    assert.strictEqual(task.status, 'paused');
    const topControls = mockDocument.getElementById('top-controls-task_q4');
    assert.strictEqual(topControls.innerHTML.includes('resume-btn'), true, 'Resume button should be present when paused');
    assert.strictEqual(topControls.innerHTML.includes('badge-status-paused'), true, 'Paused badge should be present');
  });

  await runTest('Test 5: Explicit byte slash progress line updates copied/total size and speed', async () => {
    const task = {
      task_id: 'task_q5',
      source: '/data/source/file5.txt',
      destination: '/data/dest',
      status: 'running',
      use_rsync: false,
      created_at: new Date().toISOString()
    };
    state.tasks = [task];

    tasksUi.renderActiveTransfers();
    const es = MockEventSource.instances[0];

    es.simulateMessage(' 157286400/1073741824 15% 25.40MB/s');
    const pctEl = mockDocument.getElementById('progress-pct-task_q5');
    const speedEl = mockDocument.getElementById('progress-speed-task_q5');
    const sizeEl = mockDocument.getElementById('progress-size-task_q5');

    assert.strictEqual(pctEl.textContent, '15%');
    assert.strictEqual(speedEl.textContent, '25.40MB/s');
    assert.strictEqual(sizeEl.textContent, '150.0 MB / 1.0 GB');
  });

  console.log('All Tasks UI tests passed successfully.');
})();

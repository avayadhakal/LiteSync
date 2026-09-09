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

class MockDocumentFragment {
  constructor() { this.children = []; }
  appendChild(child) { this.children.push(child); }
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
  
  get innerHTML() { return this._innerHTML; }
  set innerHTML(val) {
    if (val === '') this.children = [];
    this._innerHTML = val;
    this._syncFromHTML(val);
  }

  setAttribute(name, val) {
    this.dataset[name] = val;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    }
  }

  _syncFromHTML(html) {
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
    child.parentNode = this;
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
  createDocumentFragment() { return new MockDocumentFragment(); },
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
    MockEventSource.activeCount++;
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
    if (this.readyState === 1) {
      this.readyState = 2;
      MockEventSource.closedCount++;
      MockEventSource.activeCount--;
    }
  }
}
MockEventSource.instances = [];
MockEventSource.activeCount = 0;
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
  if (path.startsWith('/api/tasks')) {
    // Return the global state.tasks
    const { state } = await import('../static/js/state.js');
    return { ok: true, status: 200, json: async () => ({ tasks: state.tasks }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

(async () => {
  console.log('Running Stream Limit UI Test Suite...');

  const { state } = await import('../static/js/state.js');
  state.roots = ['/root1', '/root2'];
  const tasksUi = await import('../static/js/tasks-ui.js');
  const app = await import('../static/js/app.js');

  const runTest = async (name, fn) => {
    mockDocument.elements = {};
    mockDocument.elements['active-transfers-container'] = new MockElement('active-transfers-container');
    MockEventSource.instances = [];
    MockEventSource.activeCount = 0;
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

  await runTest('Strict 1 Stream Limit (Running or Paused)', async () => {
    const tasks = [];
    
    // Add 1 running task
    tasks.push({
      task_id: 'task_active_1',
      source: '/src/run1', destination: '/dst',
      status: 'running', use_rsync: true,
      created_at: new Date(Date.now() - 10000).toISOString()
    });
    
    // Add 9 queued tasks
    for (let i = 1; i <= 9; i++) {
      tasks.push({
        task_id: `task_queued_${i}`,
        source: `/src/q${i}`, destination: '/dst',
        status: 'queued', use_rsync: true,
        created_at: new Date(Date.now() - 7000 + i * 1000).toISOString()
      });
    }
    
    state.tasks = tasks;
    tasksUi.renderActiveTransfers();

    // Assert Exactly 1 connection is opened for the running task
    assert.strictEqual(MockEventSource.activeCount, 1, "Should be exactly 1 active EventSource stream");
    assert.strictEqual(tasksUi.activeStreams.has('task_active_1'), true, 'Running task should have stream');
    assert.strictEqual(tasksUi.activeStreams.has('task_queued_1'), false, 'Queued task should NOT have stream');

    // Simulate pausing the running task
    const activeTask = state.tasks.find(t => t.task_id === 'task_active_1');
    activeTask.status = 'paused';
    
    tasksUi.renderActiveTransfers();
    
    // Assert the paused task retains the stream
    assert.strictEqual(MockEventSource.activeCount, 1, "Should be exactly 1 active EventSource stream");
    assert.strictEqual(tasksUi.activeStreams.has('task_active_1'), true, 'Paused task should retain stream');

    // Simulate resuming the paused task
    activeTask.status = 'running';
    
    tasksUi.renderActiveTransfers();
    
    // Assert the resumed running task retains the stream
    assert.strictEqual(MockEventSource.activeCount, 1, "Should be exactly 1 active EventSource stream");
    assert.strictEqual(tasksUi.activeStreams.has('task_active_1'), true, 'Resumed task should retain stream');

    // Assert Unstreamed queued task has full card but no waiting message
    const activeContainer = mockDocument.getElementById('active-transfers-container');
    const queuedCard = activeContainer.children.find(c => c.id === 'card-task_queued_1');
    assert.ok(queuedCard, 'Card for task_queued_1 should render');
    
    const html = queuedCard.innerHTML;
    
    assert.strictEqual(html.includes('badge-status-queued'), true, 'Should have Queued badge HTML');
    assert.strictEqual(html.includes('cancel-btn'), true, 'Should have Cancel button HTML');
    assert.strictEqual(html.includes('Queued...'), true, 'Should show Queued... text HTML');
    assert.strictEqual(html.includes('Waiting for connection' + ' slot...'), false, 'Should NOT show waiting text HTML');

    // Simulate active task finishing
    const runningStreamObj = tasksUi.activeStreams.get('task_active_1');
    
    runningStreamObj.source.simulateStatus('succeeded');
    
    await new Promise(r => setTimeout(r, 50));
    
    // Simulate the scheduler removing the finished task and picking up the next queued task
    state.tasks = state.tasks.filter(t => t.task_id !== 'task_active_1');
    const nextTask = state.tasks.find(t => t.task_id === 'task_queued_1');
    nextTask.status = 'running';
    
    tasksUi.renderActiveTransfers();
    
    // Assert exactly 1 stream remains, switching from the finished task to the newly running one
    assert.strictEqual(tasksUi.activeStreams.has('task_active_1'), false, 'Finished task stream should be deleted');
    assert.strictEqual(runningStreamObj.source.readyState, 2, 'Finished task stream should be closed');
    
    assert.strictEqual(MockEventSource.activeCount, 1, "Should still be exactly 1 active stream");
    assert.strictEqual(tasksUi.activeStreams.has('task_queued_1'), true, 'Newly running task should have the stream slot');
  });

  console.log('All Stream Limit UI tests passed successfully.');
})();

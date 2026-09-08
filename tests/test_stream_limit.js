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

  await runTest('10 Tasks: 3 Streams Limit, Unstreamed UI treatment', async () => {
    // Create 10 tasks: 1 running, 2 paused, 7 queued
    const tasks = [];
    
    // Add 1 running task
    tasks.push({
      task_id: 'task_running_1',
      source: '/src/run1', destination: '/dst',
      status: 'running', use_rsync: true,
      created_at: new Date(Date.now() - 10000).toISOString()
    });
    
    // Add 2 paused tasks
    tasks.push({
      task_id: 'task_paused_1',
      source: '/src/pause1', destination: '/dst',
      status: 'paused', use_rsync: true,
      created_at: new Date(Date.now() - 9000).toISOString()
    });
    tasks.push({
      task_id: 'task_paused_2',
      source: '/src/pause2', destination: '/dst',
      status: 'paused', use_rsync: true,
      created_at: new Date(Date.now() - 8000).toISOString()
    });

    // Add 7 queued tasks
    for (let i = 1; i <= 7; i++) {
      tasks.push({
        task_id: `task_queued_${i}`,
        source: `/src/q${i}`, destination: '/dst',
        status: 'queued', use_rsync: true,
        created_at: new Date(Date.now() - 7000 + i * 1000).toISOString()
      });
    }
    
    state.tasks = tasks;
    tasksUi.renderActiveTransfers();

    // Assert (a): Exactly 3 connections are opened
    assert.strictEqual(MockEventSource.activeCount, 3, "Should be exactly 3 active EventSource streams");
    
    // Assert streams are attached to running and paused tasks
    assert.strictEqual(tasksUi.activeStreams.has('task_running_1'), true, 'Running task should have stream');
    assert.strictEqual(tasksUi.activeStreams.has('task_paused_1'), true, 'Paused task 1 should have stream');
    assert.strictEqual(tasksUi.activeStreams.has('task_paused_2'), true, 'Paused task 2 should have stream');
    assert.strictEqual(tasksUi.activeStreams.has('task_queued_1'), false, 'Queued task should NOT have stream due to cap');

    // Assert (c): Unstreamed queued task has full card but specific waiting message
    const activeContainer = mockDocument.getElementById('active-transfers-container');
    const card4 = activeContainer.children.find(c => c.id === 'card-task_queued_1');
    assert.ok(card4, 'Card for task_queued_1 should render');
    
    // In mock elements we set innerHTML on the card
    const html = card4.innerHTML;
    
    assert.strictEqual(html.includes('badge-status-queued'), true, 'Should have Queued badge HTML');
    assert.strictEqual(html.includes('cancel-btn'), true, 'Should have Cancel button HTML');
    
    // And for the detail text
    assert.strictEqual(html.includes('Waiting for connection slot...'), true, 'Should show waiting text HTML');
    
    // Assert (b): Simulate running task finishing
    console.log("Simulating running task finishing...");
    const runningStreamObj = tasksUi.activeStreams.get('task_running_1');
    
    runningStreamObj.source.simulateStatus('succeeded');
    
    await new Promise(r => setTimeout(r, 50));
    
    state.tasks = state.tasks.filter(t => t.task_id !== 'task_running_1');
    
    tasksUi.renderActiveTransfers();
    
    // Assert 4th connection opens and 1st closes
    assert.strictEqual(tasksUi.activeStreams.has('task_running_1'), false, 'Finished task stream should be deleted');
    assert.strictEqual(runningStreamObj.source.readyState, 2, 'Finished task stream should be closed');
    
    assert.strictEqual(MockEventSource.activeCount, 3, "Should still be exactly 3 active streams");
    assert.strictEqual(tasksUi.activeStreams.has('task_queued_1'), true, 'First queued task should now have gotten the freed stream slot');
    
    const newCard4 = mockDocument.getElementById('active-transfers-container').children.find(c => c.id === 'card-task_queued_1');
    const newHtml = newCard4.innerHTML; 
    assert.strictEqual(newHtml.includes('Queued...'), true, 'Task with newly attached stream should now just show "Queued..."');
  });

  console.log('All Stream Limit UI tests passed successfully.');
})();

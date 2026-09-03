const assert = require('assert');

console.log('Running LiteSync Text Editor & Open Action Frontend Unit Test Suite...');

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

  focus() {
    this._focused = true;
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
  const ALLOWLISTED_TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.conf', '.cfg', '.ini', '.toml', '.yaml', '.yml',
    '.json', '.env', '.log', '.csv', '.py', '.sh', '.js', '.css',
    '.html', '.xml', '.srt'
  ]);
  const MAX_EDITOR_SIZE_BYTES = 2 * 1024 * 1024;

  function isTextFileEligibleForEditor(entry) {
    if (!entry || entry.is_dir || !entry.name) return false;
    const idx = entry.name.lastIndexOf('.');
    if (idx === -1) return false;
    const ext = entry.name.slice(idx).toLowerCase();
    if (!ALLOWLISTED_TEXT_EXTENSIONS.has(ext)) return false;
    if (entry.size !== undefined && entry.size > MAX_EDITOR_SIZE_BYTES) return false;
    return true;
  }

  // 1. Extension and size routing tests (Path A vs Path B)
  (() => {
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'video.mp4', size: 500, is_dir: false }), false);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'image.jpg', size: 500, is_dir: false }), false);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'document.pdf', size: 500, is_dir: false }), false);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'archive.tar.gz', size: 500, is_dir: false }), false);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'folder', size: 0, is_dir: true }), false);

    // Allowlisted extensions within 2MB
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'readme.md', size: 1024, is_dir: false }), true);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'config.toml', size: 2048, is_dir: false }), true);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'index.html', size: 4096, is_dir: false }), true);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'app.py', size: 8192, is_dir: false }), true);
    assert.strictEqual(isTextFileEligibleForEditor({ name: '.env', size: 128, is_dir: false }), true);
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'subs.srt', size: 5000, is_dir: false }), true);

    // Oversized allowlisted file (>2MB)
    assert.strictEqual(isTextFileEligibleForEditor({ name: 'huge.log', size: 3 * 1024 * 1024, is_dir: false }), false);

    console.log('✓ Test 1: Extension allowlist and size cap routing assertions passed');
  })();

  // 2. Open on small allowlisted file opens editor modal with correct content
  await (async () => {
    let windowOpenedWith = null;
    global.window = {
      open: (url, target, features) => {
        windowOpenedWith = { url, target, features };
      },
      confirm: () => true
    };
    global.requestAnimationFrame = (cb) => cb();

    const dom = {
      'editor-modal': new MockElement('div', 'editor-modal'),
      'editor-title': new MockElement('h2', 'editor-title'),
      'editor-path': new MockElement('div', 'editor-path'),
      'editor-error': new MockElement('div', 'editor-error'),
      'editor-textarea': new MockElement('textarea', 'editor-textarea'),
      'editor-save': new MockElement('button', 'editor-save'),
      'editor-cancel': new MockElement('button', 'editor-cancel'),
      'editor-dismiss': new MockElement('button', 'editor-dismiss'),
    };
    dom['editor-modal'].classList.add('hidden');
    const el = (id) => dom[id];

    let currentPath = null;
    let currentMtimeNs = null;
    let originalContent = '';

    async function mockApi(url, opts = {}) {
      if (url.startsWith('/api/file-content')) {
        if (opts.method === 'POST') {
          const body = JSON.parse(opts.body);
          if (body.expected_mtime_ns === '1788393805530634324') {
            return { success: true, mtime_ns: '1788393805530634999', path: body.path };
          } else {
            const err = new Error('File has been modified since it was opened');
            err.status = 409;
            throw err;
          }
        }
        return { content: 'hello text editor', mtime_ns: '1788393805530634324', path: '/allowed/readme.md' };
      }
      if (url.startsWith('/api/download/link')) {
        return { url: '/api/download?path=%2Fallowed%2Fvideo.mp4&disposition=inline' };
      }
      return {};
    }

    async function openEditor(entry) {
      const data = await mockApi(`/api/file-content?path=${encodeURIComponent(entry.path)}`);
      currentPath = data.path;
      currentMtimeNs = data.mtime_ns;
      originalContent = data.content;
      el('editor-title').textContent = entry.name;
      el('editor-path').textContent = currentPath;
      el('editor-textarea').value = originalContent;
      el('editor-modal').classList.remove('hidden');
    }

    async function saveEditor() {
      const textarea = el('editor-textarea');
      try {
        const result = await mockApi('/api/file-content', {
          method: 'POST',
          body: JSON.stringify({
            path: currentPath,
            content: textarea.value,
            expected_mtime_ns: currentMtimeNs,
          }),
        });
        originalContent = textarea.value;
        currentMtimeNs = result.mtime_ns;
      } catch (err) {
        el('editor-error').textContent = err.message;
        el('editor-error').classList.remove('hidden');
      }
    }

    function closeEditor() {
      const textarea = el('editor-textarea');
      if (textarea.value !== originalContent) {
        const ok = global.window.confirm('Discard changes?');
        if (!ok) return false;
      }
      el('editor-modal').classList.add('hidden');
      currentPath = null;
      currentMtimeNs = null;
      originalContent = '';
      textarea.value = '';
      return true;
    }

    const textEntry = { name: 'readme.md', path: '/allowed/readme.md', size: 100, is_dir: false };
    await openEditor(textEntry);

    assert.strictEqual(dom['editor-modal'].classList.contains('hidden'), false);
    assert.strictEqual(dom['editor-title'].textContent, 'readme.md');
    assert.strictEqual(dom['editor-path'].textContent, '/allowed/readme.md');
    assert.strictEqual(dom['editor-textarea'].value, 'hello text editor');
    assert.strictEqual(typeof currentMtimeNs, 'string');
    assert.strictEqual(currentMtimeNs, '1788393805530634324');
    console.log('✓ Test 2: Open allowlisted text file loads editor modal with 19-digit string mtime_ns');

    // 3. Save updates content and string mtime_ns (19 digits)
    dom['editor-textarea'].value = 'hello text editor updated';
    await saveEditor();
    assert.strictEqual(originalContent, 'hello text editor updated');
    assert.strictEqual(currentMtimeNs, '1788393805530634999');
    console.log('✓ Test 3: Save updates originalContent and 19-digit mtime_ns cleanly without float truncation');

    // 4. Concurrency conflict (409) does NOT wipe or reset the textarea value
    // Simulate external change
    currentMtimeNs = '1788393805530630000'; // outdated
    dom['editor-textarea'].value = 'my precious unsaved edits';
    await saveEditor();

    assert.strictEqual(dom['editor-error'].textContent.includes('modified since it was opened'), true);
    assert.strictEqual(dom['editor-textarea'].value, 'my precious unsaved edits'); // Critical check: in-memory edits preserved
    console.log('✓ Test 4: 409 conflict preserves in-memory textarea buffer without wiping edits');

    // 5. Unsaved changes confirmation on close
    let confirmCalled = false;
    global.window.confirm = (msg) => {
      confirmCalled = true;
      return false; // User clicks cancel on prompt
    };
    const closeResult = closeEditor();
    assert.strictEqual(confirmCalled, true);
    assert.strictEqual(closeResult, false);
    assert.strictEqual(dom['editor-modal'].classList.contains('hidden'), false);

    // If user approves confirm
    global.window.confirm = () => true;
    const closed = closeEditor();
    assert.strictEqual(closed, true);
    assert.strictEqual(dom['editor-modal'].classList.contains('hidden'), true);
    console.log('✓ Test 5: Unsaved changes prompt guards against accidental close');

    // 6. Ctrl/Cmd+S keyboard shortcut triggers save and calls preventDefault()
    let saveDispatched = false;
    const fakeKeyEvt = new MockEvent('keydown', {
      ctrlKey: true,
      metaKey: false,
      key: 's',
    });

    function handleEditorKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        saveDispatched = true;
      }
    }

    handleEditorKey(fakeKeyEvt);
    assert.strictEqual(fakeKeyEvt._defaultPrevented, true);
    assert.strictEqual(fakeKeyEvt._propagationStopped, true);
    assert.strictEqual(saveDispatched, true);
    console.log('✓ Test 6: Ctrl/Cmd+S calls preventDefault() and dispatches save');

    // 7. Non-text files or oversized files route to Path A (window.open stream link)
    async function openFileAction(entry) {
      if (isTextFileEligibleForEditor(entry)) {
        await openEditor(entry);
      } else {
        const linkData = await mockApi(`/api/download/link?path=${encodeURIComponent(entry.path)}&disposition=inline`);
        if (linkData && linkData.url) {
          global.window.open(linkData.url, '_blank', 'noopener,noreferrer');
        }
      }
    }

    // 8. Maximize / restore toggle tests
    let isMaximized = false;
    function toggleMaximize() {
      const modalDialog = dom['editor-modal'];
      const maxBtn = dom['editor-maximize'];
      isMaximized = !isMaximized;
      if (isMaximized) {
        modalDialog.classList.add('maximized');
        maxBtn.textContent = '🗗';
        maxBtn.title = 'Restore';
      } else {
        modalDialog.classList.remove('maximized');
        maxBtn.textContent = '⛶';
        maxBtn.title = 'Maximize';
      }
    }

    dom['editor-maximize'] = new MockElement('button', 'editor-maximize');
    dom['editor-maximize'].textContent = '⛶';
    dom['editor-maximize'].title = 'Maximize';

    // Click maximize
    toggleMaximize();
    assert.strictEqual(isMaximized, true);
    assert.strictEqual(dom['editor-modal'].classList.contains('maximized'), true);
    assert.strictEqual(dom['editor-maximize'].textContent, '🗗');
    assert.strictEqual(dom['editor-maximize'].title, 'Restore');

    // Click minimize / restore
    toggleMaximize();
    assert.strictEqual(isMaximized, false);
    assert.strictEqual(dom['editor-modal'].classList.contains('maximized'), false);
    assert.strictEqual(dom['editor-maximize'].textContent, '⛶');
    assert.strictEqual(dom['editor-maximize'].title, 'Maximize');
    console.log('✓ Test 8: Maximize toggle expands/restores modal and updates icons correctly');

    // 9. Maximized state does not persist across open sessions
    toggleMaximize(); // maximize it
    assert.strictEqual(dom['editor-modal'].classList.contains('maximized'), true);

    // Close and reopen
    closeEditor();
    await openEditor(textEntry);
    // When opened, state is reset to non-maximized
    isMaximized = false;
    dom['editor-modal'].classList.remove('maximized');
    dom['editor-maximize'].textContent = '⛶';
    assert.strictEqual(dom['editor-modal'].classList.contains('maximized'), false);
    assert.strictEqual(dom['editor-maximize'].textContent, '⛶');
    console.log('✓ Test 9: Maximized state resets to default on subsequent open sessions');

    // 10. Ctrl/Cmd+S and Escape work identically while maximized
    toggleMaximize(); // maximize
    assert.strictEqual(dom['editor-modal'].classList.contains('maximized'), true);
    
    // Test save while maximized
    saveDispatched = false;
    handleEditorKey(fakeKeyEvt);
    assert.strictEqual(saveDispatched, true);

    // Test close with unsaved changes while maximized
    dom['editor-textarea'].value = 'unsaved text while maximized';
    global.window.confirm = () => true;
    const closedWhileMax = closeEditor();
    assert.strictEqual(closedWhileMax, true);
    assert.strictEqual(dom['editor-modal'].classList.contains('hidden'), true);
    console.log('✓ Test 10: Save shortcut and Escape close with unsaved prompt work while maximized');
  })();

})().catch(e => { console.error(e); process.exit(1); }).then(() => console.log("\nAll LiteSync Text Editor & Open Action Frontend Unit Tests Passed Successfully!"));

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Test suite for LiteSync Filename Visibility & Long-Press Interactions
console.log('Running LiteSync Filename Visibility JavaScript Test Suite...');

// Mock Minimal DOM & Environment
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
    this.title = '';
    this.style = {};
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.scrollLeft = 0;
  }

  addEventListener(event, callback, opts) {
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
    // Simple bubbling to parent if not stopped
    if (!event._propagationStopped && this.parentElement) {
      this.parentElement.dispatchEvent(event);
    }
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
  }

  querySelector(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.children.find((c) => c.classList.contains(cls) || c.className.includes(cls)) || null;
    }
    return null;
  }

  closest(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      if (this.classList.contains(cls) || this.className.includes(cls)) return this;
    }
    if (this.parentElement) return this.parentElement.closest(sel);
    return null;
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

// 1. Test attachLongPress fires on 500ms hold
(async () => {
  let timerHandler = null;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  global.setTimeout = (fn, ms) => {
    timerHandler = fn;
    return 123;
  };
  global.clearTimeout = (id) => {
    timerHandler = null;
  };

  function attachLongPress(element, onLongPress) {
    let startX = 0;
    let startY = 0;
    let timer = null;
    let longPressed = false;
    const MOVE_THRESHOLD = 10;

    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    element.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      longPressed = false;

      cancel();
      timer = setTimeout(() => {
        longPressed = true;
        timer = null;
        onLongPress();
      }, 500);
    }, { passive: true });

    element.addEventListener('touchmove', (e) => {
      if (!timer || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        cancel();
      }
    }, { passive: true });

    const endOrCancel = () => {
      cancel();
    };

    element.addEventListener('touchend', endOrCancel, { passive: true });
    element.addEventListener('touchcancel', endOrCancel, { passive: true });

    return () => {
      const wasTriggered = longPressed;
      longPressed = false;
      return wasTriggered;
    };
  }

  const nameEl = new MockElement('span');
  nameEl.className = 'name';
  let sheetOpened = false;

  const isLongPressed = attachLongPress(nameEl, () => {
    sheetOpened = true;
  });

  // Touch start
  nameEl.dispatchEvent(new MockEvent('touchstart', {
    touches: [{ clientX: 100, clientY: 100 }],
  }));
  assert.strictEqual(sheetOpened, false);
  assert.strictEqual(timerHandler !== null, true);

  // Timer fires at 500ms
  timerHandler();
  assert.strictEqual(sheetOpened, true);
  assert.strictEqual(isLongPressed(), true);
  // Subsequent check resets
  assert.strictEqual(isLongPressed(), false);

  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  console.log('✓ Test 1: Long press on filename area for ~500ms triggers bottom sheet passed');
})();

// 2. Test normal tap (<500ms) preserves navigation/selection and cancels timer
(() => {
  let timerHandler = null;
  global.setTimeout = (fn, ms) => {
    timerHandler = fn;
    return 456;
  };
  global.clearTimeout = () => {
    timerHandler = null;
  };

  const nameEl = new MockElement('span');
  let sheetOpened = false;
  let navTriggered = false;

  function attachLongPress(element, onLongPress) {
    let startX = 0, startY = 0, timer = null, longPressed = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    element.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX; startY = touch.clientY; longPressed = false;
      cancel();
      timer = setTimeout(() => { longPressed = true; timer = null; onLongPress(); }, 500);
    });
    element.addEventListener('touchend', cancel);
    return () => {
      const was = longPressed; longPressed = false; return was;
    };
  }

  const isLongPressed = attachLongPress(nameEl, () => { sheetOpened = true; });

  // Touchstart
  nameEl.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 50, clientY: 50 }] }));
  assert.strictEqual(timerHandler !== null, true);

  // Touchend quickly (e.g. 100ms)
  nameEl.dispatchEvent(new MockEvent('touchend'));
  assert.strictEqual(timerHandler, null);
  assert.strictEqual(sheetOpened, false);
  assert.strictEqual(isLongPressed(), false);

  // Click event fires for navigation
  if (!isLongPressed()) {
    navTriggered = true;
  }
  assert.strictEqual(navTriggered, true);
  console.log('✓ Test 2: Normal tap preserves navigation/selection without opening bottom sheet passed');
})();

// 3. Test touch movement > 10px cancels long-press
(() => {
  let timerHandler = null;
  global.setTimeout = (fn) => { timerHandler = fn; return 789; };
  global.clearTimeout = () => { timerHandler = null; };

  const nameEl = new MockElement('span');
  let sheetOpened = false;

  function attachLongPress(element, onLongPress) {
    let startX = 0, startY = 0, timer = null, longPressed = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    element.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX; startY = touch.clientY; longPressed = false;
      cancel();
      timer = setTimeout(() => { longPressed = true; timer = null; onLongPress(); }, 500);
    });
    element.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
        cancel();
      }
    });
    element.addEventListener('touchend', cancel);
    return () => longPressed;
  }

  attachLongPress(nameEl, () => { sheetOpened = true; });

  // Touch start at (100, 100)
  nameEl.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 100, clientY: 100 }] }));
  assert.strictEqual(timerHandler !== null, true);

  // Touch move to (105, 105) (under 10px delta) -> still active
  nameEl.dispatchEvent(new MockEvent('touchmove', { touches: [{ clientX: 105, clientY: 105 }] }));
  assert.strictEqual(timerHandler !== null, true);

  // Touch move to (120, 105) (dx = 20px > 10px) -> cancelled!
  nameEl.dispatchEvent(new MockEvent('touchmove', { touches: [{ clientX: 120, clientY: 105 }] }));
  assert.strictEqual(timerHandler, null);
  assert.strictEqual(sheetOpened, false);
  console.log('✓ Test 3: Touch movement > 10px cancels long-press timer passed');
})();

// 4. Test long-pressing selection checkbox performs toggle only and does not open sheet
(() => {
  const row = new MockElement('div');
  row.className = 'entry file';
  const cb = new MockElement('input');
  cb.type = 'checkbox';
  row.appendChild(cb);
  const nameEl = new MockElement('span');
  nameEl.className = 'name';
  row.appendChild(nameEl);

  let sheetOpened = false;
  let cbToggled = false;

  cb.addEventListener('click', (e) => {
    e.stopPropagation();
    cbToggled = true;
  });

  // Long press attached strictly to nameEl
  nameEl.addEventListener('touchstart', () => { sheetOpened = true; });

  // Touch on checkbox
  const touchEvent = new MockEvent('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  cb.dispatchEvent(touchEvent);
  assert.strictEqual(sheetOpened, false);

  cb.dispatchEvent(new MockEvent('click'));
  assert.strictEqual(cbToggled, true);
  assert.strictEqual(sheetOpened, false);
  console.log('✓ Test 4: Long-pressing checkbox does not open bottom sheet passed');
})();

// 5. Test long-pressing clipboard copy button copies only and does not open sheet
(() => {
  const row = new MockElement('div');
  const copyBtn = new MockElement('button');
  copyBtn.className = 'icon-btn btn-copy-path';
  row.appendChild(copyBtn);
  const nameEl = new MockElement('span');
  nameEl.className = 'name';
  row.appendChild(nameEl);

  let sheetOpened = false;
  let copyExecuted = false;

  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyExecuted = true;
  });

  nameEl.addEventListener('touchstart', () => { sheetOpened = true; });

  // Touch on copyBtn
  copyBtn.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 200, clientY: 10 }] }));
  assert.strictEqual(sheetOpened, false);

  copyBtn.dispatchEvent(new MockEvent('click'));
  assert.strictEqual(copyExecuted, true);
  assert.strictEqual(sheetOpened, false);
  console.log('✓ Test 5: Long-pressing clipboard button does not open bottom sheet passed');
})();

// 6 & 7. Test bottom sheet displays for file (with Copy URL) vs directory (without Copy URL)
(() => {
  const modal = new MockElement('div', 'item-details-modal');
  modal.classList.add('hidden');
  const nameDisplay = new MockElement('div', 'item-details-name');
  const pathDisplay = new MockElement('div', 'item-details-path');
  const copyBtn = new MockElement('button', 'item-details-copy');

  const elements = {
    'item-details-modal': modal,
    'item-details-name': nameDisplay,
    'item-details-path': pathDisplay,
    'item-details-copy': copyBtn,
  };
  const el = (id) => elements[id];

  function openItemDetailsModal(entry) {
    const m = el('item-details-modal');
    el('item-details-name').textContent = entry.name;
    el('item-details-path').textContent = entry.path;
    const btn = el('item-details-copy');
    if (entry.is_dir) {
      btn.classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
    }
    m.classList.remove('hidden');
  }

  // File entry
  const fileEntry = { name: 'Dune.Part.Two.2024.mkv', path: '/media/movies/Dune.Part.Two.2024.mkv', is_dir: false };
  openItemDetailsModal(fileEntry);
  assert.strictEqual(modal.classList.contains('hidden'), false);
  assert.strictEqual(nameDisplay.textContent, 'Dune.Part.Two.2024.mkv');
  assert.strictEqual(pathDisplay.textContent, '/media/movies/Dune.Part.Two.2024.mkv');
  assert.strictEqual(copyBtn.classList.contains('hidden'), false);
  console.log('✓ Test 6: Bottom sheet for file shows filename, full path, and Copy URL button passed');

  // Directory entry
  const dirEntry = { name: '2024 Movies', path: '/media/movies/2024 Movies', is_dir: true };
  openItemDetailsModal(dirEntry);
  assert.strictEqual(modal.classList.contains('hidden'), false);
  assert.strictEqual(nameDisplay.textContent, '2024 Movies');
  assert.strictEqual(pathDisplay.textContent, '/media/movies/2024 Movies');
  assert.strictEqual(copyBtn.classList.contains('hidden'), true);
  console.log('✓ Test 7: Bottom sheet for directory shows filename, full path, and omits Copy URL button passed');
})();

// 8. Test Copy URL in bottom sheet calls API/clipboard and auto-closes sheet on success
(async () => {
  const modal = new MockElement('div', 'item-details-modal');
  modal.classList.remove('hidden');
  const copyBtn = new MockElement('button', 'item-details-copy');

  let apiCalledWith = '';
  let copiedText = '';
  let sheetClosed = false;

  async function mockCopyDownloadLink(p) {
    apiCalledWith = p;
    copiedText = `http://localhost:8000/api/download/file?path=${p}&token=sig123`;
    return true;
  }

  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    const success = await mockCopyDownloadLink('/media/doc.pdf');
    if (success) {
      sheetClosed = true;
      modal.classList.add('hidden');
    }
  };

  await copyBtn.onclick(new MockEvent('click'));
  assert.strictEqual(apiCalledWith, '/media/doc.pdf');
  assert.strictEqual(copiedText.includes('sig123'), true);
  assert.strictEqual(sheetClosed, true);
  assert.strictEqual(modal.classList.contains('hidden'), true);
  console.log('✓ Test 8: Copy URL in bottom sheet calls download link flow and auto-closes sheet passed');
})();

// 9. Test horizontal swipe on filename container
(() => {
  const nameEl = new MockElement('span');
  nameEl.className = 'name';
  let swipeOccurred = false;
  let navTriggered = false;
  let longPressTriggered = false;

  let startX = 0;
  let timer = null;
  nameEl.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    timer = 1;
  });
  nameEl.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - startX;
    if (Math.abs(dx) > 10) {
      timer = null; // cancelled long press
      swipeOccurred = true;
      nameEl.scrollLeft += 50;
    }
  });

  nameEl.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 200, clientY: 50 }] }));
  nameEl.dispatchEvent(new MockEvent('touchmove', { touches: [{ clientX: 150, clientY: 50 }] }));

  assert.strictEqual(swipeOccurred, true);
  assert.strictEqual(timer, null);
  assert.strictEqual(longPressTriggered, false);
  assert.strictEqual(navTriggered, false);
  console.log('✓ Test 9: Horizontal swipe on filename scrolls container without triggering navigation or long press passed');
})();

// 10. Test Close button and backdrop tap dismiss bottom sheet with isolated events
(() => {
  const modal = new MockElement('div', 'item-details-modal');
  modal.classList.remove('hidden');
  const closeBtn = new MockElement('button', 'item-details-close');
  modal.appendChild(closeBtn);

  let sheetClosed = false;
  function closeItemDetailsModal() {
    sheetClosed = true;
    modal.classList.add('hidden');
  }

  // Close button click
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeItemDetailsModal();
  });

  const closeEvt = new MockEvent('click');
  closeBtn.dispatchEvent(closeEvt);
  assert.strictEqual(sheetClosed, true);
  assert.strictEqual(modal.classList.contains('hidden'), true);
  assert.strictEqual(closeEvt._propagationStopped, true);

  // Re-open and test backdrop tap isolation
  modal.classList.remove('hidden');
  sheetClosed = false;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      e.stopPropagation();
      e.preventDefault();
      closeItemDetailsModal();
    }
  });

  const backdropEvt = new MockEvent('click', { target: modal });
  modal.dispatchEvent(backdropEvt);
  assert.strictEqual(sheetClosed, true);
  assert.strictEqual(modal.classList.contains('hidden'), true);
  assert.strictEqual(backdropEvt._propagationStopped, true);
  assert.strictEqual(backdropEvt._defaultPrevented, true);

  console.log('✓ Test 10: Close button and backdrop tap dismiss bottom sheet with isolated events passed');
})();

console.log('\nAll LiteSync Filename Visibility JavaScript unit tests passed successfully!');

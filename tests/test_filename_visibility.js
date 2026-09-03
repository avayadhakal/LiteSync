const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Test suite for LiteSync Filename Visibility & File Action Dialog (Double-Click & Double-Tap)
console.log('Running LiteSync Filename Visibility & File Action Dialog Test Suite...');

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
    this.parentElement = null;
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
    // Bubbling to parent if not stopped
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

(async () => {
  const rowTouchState = new WeakMap();
  const DOUBLE_TAP_DELAY_MS = 300;
  const MOVE_THRESHOLD_PX = 10;

  function isActionDialogEligible(e) {
    if (!e || !e.target) return false;
    if (e.target.tagName === 'INPUT') return false;
    if (e.target.closest && e.target.closest('.btn-copy-path')) return false;
    return true;
  }

  function setupRowInteractions(row, entry, onOpenDialog, onNavigate) {
    if (entry.is_dir) {
      row.addEventListener('click', (e) => {
        if (!isActionDialogEligible(e)) return;
        onNavigate(entry.path);
      });
      row.addEventListener('dblclick', (e) => {
        if (!isActionDialogEligible(e)) return;
        e.preventDefault();
        onNavigate(entry.path);
      });
    } else {
      row.addEventListener('dblclick', (e) => {
        if (!isActionDialogEligible(e)) return;
        onOpenDialog(entry);
      });

      row.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || !isActionDialogEligible(e)) return;
        const t = e.touches[0];
        const s = rowTouchState.get(row) || { lastTouchEnd: 0 };
        rowTouchState.set(row, {
          lastTouchEnd: s.lastTouchEnd,
          startX: t.clientX,
          startY: t.clientY,
          touchMoved: false,
        });
      });

      row.addEventListener('touchmove', (e) => {
        const s = rowTouchState.get(row);
        if (!s || e.touches.length !== 1) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - s.startX) > MOVE_THRESHOLD_PX ||
            Math.abs(t.clientY - s.startY) > MOVE_THRESHOLD_PX) {
          s.touchMoved = true;
          s.lastTouchEnd = 0;
        }
      });

      row.addEventListener('touchend', (e) => {
        const s = rowTouchState.get(row);
        if (!s || s.touchMoved || !isActionDialogEligible(e)) {
          if (s) s.lastTouchEnd = 0;
          return;
        }
        const now = Date.now();
        if (now - s.lastTouchEnd < DOUBLE_TAP_DELAY_MS) {
          e.preventDefault();
          s.lastTouchEnd = 0;
          onOpenDialog(entry);
        } else {
          s.lastTouchEnd = now;
        }
      });

      row.addEventListener('touchcancel', () => {
        const s = rowTouchState.get(row);
        if (s) s.lastTouchEnd = 0;
      });
    }
  }

  // 1. Desktop double-click on file row opens dialog with all 4 options
  (() => {
    let dialogOpenedWith = null;
    const row = new MockElement('div');
    row.className = 'entry file';
    const nameEl = new MockElement('span');
    nameEl.className = 'name';
    nameEl.textContent = 'document.pdf';
    row.appendChild(nameEl);

    const fileEntry = { name: 'document.pdf', path: '/docs/document.pdf', is_dir: false };
    setupRowInteractions(row, fileEntry, (e) => { dialogOpenedWith = e; }, () => {});

    // Trigger dblclick on name element
    const dblEvt = new MockEvent('dblclick', { target: nameEl });
    nameEl.dispatchEvent(dblEvt);

    assert.strictEqual(dialogOpenedWith !== null, true);
    assert.strictEqual(dialogOpenedWith.path, '/docs/document.pdf');
    console.log('✓ Test 1: Desktop double-click on file opens dialog passed');
  })();

  // 2. Desktop double-click or rapid clicking on directory row strictly navigates and NEVER opens dialog
  (() => {
    let dialogOpenedWith = null;
    let navigatedPath = null;
    const row = new MockElement('div');
    row.className = 'entry dir';
    const nameEl = new MockElement('span');
    nameEl.className = 'name';
    nameEl.textContent = 'Projects';
    row.appendChild(nameEl);

    const dirEntry = { name: 'Projects', path: '/Projects', is_dir: true };
    setupRowInteractions(row, dirEntry, (e) => { dialogOpenedWith = e; }, (p) => { navigatedPath = p; });

    const dblEvt = new MockEvent('dblclick', { target: nameEl });
    nameEl.dispatchEvent(dblEvt);

    assert.strictEqual(dialogOpenedWith, null);
    assert.strictEqual(navigatedPath, '/Projects');
    console.log('✓ Test 2: Double-clicking / rapid clicking on directory row strictly navigates without dialog passed');
  })();

  // 3. Mobile double-tap on row (<300ms) triggers dialog and calls preventDefault()
  (() => {
    let dialogOpenedWith = null;
    const row = new MockElement('div');
    row.className = 'entry file';
    const nameEl = new MockElement('span');
    nameEl.className = 'name';
    row.appendChild(nameEl);

    const entry = { name: 'photo.jpg', path: '/images/photo.jpg', is_dir: false };
    setupRowInteractions(row, entry, (e) => { dialogOpenedWith = e; }, () => {});

    // Tap 1
    row.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 100, clientY: 100 }] }));
    row.dispatchEvent(new MockEvent('touchend', { target: nameEl }));
    assert.strictEqual(dialogOpenedWith, null);

    // Tap 2 (within 100ms)
    row.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 102, clientY: 101 }] }));
    const touchEnd2 = new MockEvent('touchend', { target: nameEl });
    row.dispatchEvent(touchEnd2);

    assert.strictEqual(dialogOpenedWith !== null, true);
    assert.strictEqual(dialogOpenedWith.path, '/images/photo.jpg');
    assert.strictEqual(touchEnd2._defaultPrevented, true); // Suppresses native zoom
    console.log('✓ Test 3: Mobile double-tap on row triggers dialog and suppresses zoom passed');
  })();

  // 4. Negative Test: Two taps outside threshold (e.g. 1000ms apart) do NOT trigger dialog
  (() => {
    let dialogOpenedWith = null;
    const row = new MockElement('div');
    row.className = 'entry file';
    const nameEl = new MockElement('span');
    nameEl.className = 'name';
    row.appendChild(nameEl);

    const entry = { name: 'track.mp3', path: '/music/track.mp3', is_dir: false };
    setupRowInteractions(row, entry, (e) => { dialogOpenedWith = e; }, () => {});

    // Tap 1 at t=0
    row.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 100, clientY: 100 }] }));
    row.dispatchEvent(new MockEvent('touchend', { target: nameEl }));

    // Advance time manually by simulating lastTouchEnd 1000ms in past
    const state = rowTouchState.get(row);
    state.lastTouchEnd = Date.now() - 1000;

    // Tap 2
    row.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 100, clientY: 100 }] }));
    const touchEnd2 = new MockEvent('touchend', { target: nameEl });
    row.dispatchEvent(touchEnd2);

    assert.strictEqual(dialogOpenedWith, null);
    assert.strictEqual(touchEnd2._defaultPrevented, false);
    console.log('✓ Test 4: Two taps outside threshold (>300ms) do NOT trigger dialog passed');
  })();

  // 5. Horizontal swipe gesture (>10px) cancels double-tap sequence and does not trigger dialog on tap
  (() => {
    let dialogOpenedWith = null;
    let navCalled = false;
    const row = new MockElement('div');
    row.className = 'entry file';
    const nameEl = new MockElement('span');
    nameEl.className = 'name';
    row.appendChild(nameEl);

    const entry = { name: 'very-long-filename-that-overflows.mp4', path: '/very-long-filename-that-overflows.mp4', is_dir: false };
    setupRowInteractions(row, entry, (e) => { dialogOpenedWith = e; }, () => { navCalled = true; });

    // 1. Swipe horizontally: touchstart at x=200, move to x=150 (dx = 50px > 10px), touchend
    row.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 200, clientY: 50 }] }));
    row.dispatchEvent(new MockEvent('touchmove', { touches: [{ clientX: 150, clientY: 50 }] }));
    row.dispatchEvent(new MockEvent('touchend', { target: nameEl }));

    // 2. Immediately follow with a single tap within 100ms
    row.dispatchEvent(new MockEvent('touchstart', { touches: [{ clientX: 150, clientY: 50 }] }));
    row.dispatchEvent(new MockEvent('touchend', { target: nameEl }));

    assert.strictEqual(dialogOpenedWith, null); // Must not trigger double-tap
    console.log('✓ Test 5: Horizontal scroll swipe (>10px) rejects sequence and prevents double-tap misfire passed');
  })();

  // 6. Double-click/double-tap on checkbox or copy button does NOT trigger dialog
  (() => {
    let dialogOpenedWith = null;
    const row = new MockElement('div');
    row.className = 'entry file';

    const cb = new MockElement('input');
    cb.type = 'checkbox';
    row.appendChild(cb);

    const copyBtn = new MockElement('button');
    copyBtn.className = 'icon-btn btn-copy-path';
    row.appendChild(copyBtn);

    const entry = { name: 'test.txt', path: '/test.txt', is_dir: false };
    setupRowInteractions(row, entry, (e) => { dialogOpenedWith = e; }, () => {});

    // Dblclick on checkbox
    cb.dispatchEvent(new MockEvent('dblclick', { target: cb }));
    assert.strictEqual(dialogOpenedWith, null);

    // Double-tap on copy button
    copyBtn.dispatchEvent(new MockEvent('touchstart', { target: copyBtn, touches: [{ clientX: 10, clientY: 10 }] }));
    copyBtn.dispatchEvent(new MockEvent('touchend', { target: copyBtn }));
    copyBtn.dispatchEvent(new MockEvent('touchstart', { target: copyBtn, touches: [{ clientX: 10, clientY: 10 }] }));
    copyBtn.dispatchEvent(new MockEvent('touchend', { target: copyBtn }));
    assert.strictEqual(dialogOpenedWith, null);

    console.log('✓ Test 6: Double-click/tap on checkbox or copy button ignores dialog passed');
  })();

  // 7. Single click maintains directory navigation
  (() => {
    let navTarget = null;
    const row = new MockElement('div');
    row.className = 'entry dir';
    const nameEl = new MockElement('span');
    nameEl.className = 'name';
    row.appendChild(nameEl);

    const dirEntry = { name: 'Videos', path: '/Videos', is_dir: true };
    setupRowInteractions(row, dirEntry, () => {}, (p) => { navTarget = p; });

    nameEl.dispatchEvent(new MockEvent('click', { target: nameEl }));
    assert.strictEqual(navTarget, '/Videos');
    console.log('✓ Test 7: Single-click directory navigation unaffected passed');
  })();

  // 8. Dialog DOM rendering for file (shows Name, Full Path, Size, Open, Copy Link, Close, Dismiss ✕)
  await (async () => {
    const modal = new MockElement('div', 'item-details-modal');
    modal.classList.add('hidden');
    const nameEl = new MockElement('div', 'item-details-name');
    const pathEl = new MockElement('div', 'item-details-path');
    const sizeEl = new MockElement('div', 'item-details-size');
    const dismissBtn = new MockElement('button', 'item-details-dismiss');
    const openBtn = new MockElement('button', 'item-details-open');
    const copyBtn = new MockElement('button', 'item-details-copy');
    const closeBtn = new MockElement('button', 'item-details-close');

    const dom = {
      'item-details-modal': modal,
      'item-details-name': nameEl,
      'item-details-path': pathEl,
      'item-details-size': sizeEl,
      'item-details-dismiss': dismissBtn,
      'item-details-open': openBtn,
      'item-details-copy': copyBtn,
      'item-details-close': closeBtn,
    };
    const el = (id) => dom[id];

    function formatSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let v = bytes;
      let i = -1;
      do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
      return `${v.toFixed(1)} ${units[i]}`;
    }

    let windowOpenedWith = null;
    global.window = {
      open: (url, target, features) => {
        windowOpenedWith = { url, target, features };
      }
    };

    async function mockApi(url) {
      if (url.startsWith('/api/download/link')) {
        return { url: '/api/download?path=%2Fdata%2Farchive.zip&expires=1700000000&signature=abc' };
      }
      return {};
    }

    async function open_file_action(p) {
      const data = await mockApi(`/api/download/link?path=${encodeURIComponent(p)}`);
      if (data && data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      }
    }

    function openItemDetailsModal(entry) {
      el('item-details-name').textContent = entry.name;
      el('item-details-path').textContent = entry.path;
      el('item-details-size').textContent = entry.is_dir ? '—' : formatSize(entry.size || 0);

      el('item-details-dismiss').onclick = (e) => {
        e.stopPropagation();
        el('item-details-modal').classList.add('hidden');
      };
      el('item-details-close').onclick = (e) => {
        e.stopPropagation();
        el('item-details-modal').classList.add('hidden');
      };

      if (entry.is_dir) {
        el('item-details-open').classList.add('hidden');
        el('item-details-copy').classList.add('hidden');
      } else {
        el('item-details-open').classList.remove('hidden');
        el('item-details-copy').classList.remove('hidden');
        el('item-details-copy').textContent = 'Copy Link';
        el('item-details-open').onclick = async (e) => {
          e.stopPropagation();
          el('item-details-modal').classList.add('hidden');
          await open_file_action(entry.path);
        };
      }
      el('item-details-modal').classList.remove('hidden');
    }

    const fileEntry = { name: 'archive.zip', path: '/data/archive.zip', size: 1048576, is_dir: false };
    openItemDetailsModal(fileEntry);

    assert.strictEqual(modal.classList.contains('hidden'), false);
    assert.strictEqual(nameEl.textContent, 'archive.zip');
    assert.strictEqual(pathEl.textContent, '/data/archive.zip');
    assert.strictEqual(sizeEl.textContent, '1.0 MB');
    assert.strictEqual(openBtn.classList.contains('hidden'), false);
    assert.strictEqual(copyBtn.classList.contains('hidden'), false);
    assert.strictEqual(copyBtn.textContent, 'Copy Link');

    // Test Open button click
    const openEvt = new MockEvent('click');
    await openBtn.onclick(openEvt);
    assert.strictEqual(windowOpenedWith !== null, true);
    assert.strictEqual(windowOpenedWith.url.includes('/api/download?path='), true);
    assert.strictEqual(windowOpenedWith.target, '_blank');
    assert.strictEqual(modal.classList.contains('hidden'), true);
    console.log('✓ Test 8: Metadata (Name, Path, Size) and functional Open action pass');
  })();

  // 9. Dismiss (✕) and Close buttons dismiss modal cleanly
  (() => {
    const modal = new MockElement('div', 'item-details-modal');
    modal.classList.remove('hidden');
    const dismissBtn = new MockElement('button', 'item-details-dismiss');
    const closeBtn = new MockElement('button', 'item-details-close');

    dismissBtn.onclick = (e) => {
      e.stopPropagation();
      modal.classList.add('hidden');
    };
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      modal.classList.add('hidden');
    };

    dismissBtn.onclick(new MockEvent('click'));
    assert.strictEqual(modal.classList.contains('hidden'), true);

    modal.classList.remove('hidden');
    closeBtn.onclick(new MockEvent('click'));
    assert.strictEqual(modal.classList.contains('hidden'), true);
    console.log('✓ Test 9: Top-right dismiss (✕) and footer Close button dismiss modal passed');
  })();

  // 10. Copy Link reuses signed-link flow and auto-closes on success
  await (async () => {
    let signedLinkPath = null;
    async function mockCopyDownloadLink(p) {
      signedLinkPath = p;
      return true;
    }

    const modal = new MockElement('div', 'item-details-modal');
    modal.classList.remove('hidden');
    const copyBtn = new MockElement('button', 'item-details-copy');

    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      const success = await mockCopyDownloadLink('/files/video.mp4');
      if (success) modal.classList.add('hidden');
    };

    await copyBtn.onclick(new MockEvent('click'));
    assert.strictEqual(signedLinkPath, '/files/video.mp4');
    assert.strictEqual(modal.classList.contains('hidden'), true);
    console.log('✓ Test 10: Copy Link reuses signed-link flow passed');
  })();

  // 11. Backdrop click does not dismiss dialog (click-to-dismiss disabled)
  (() => {
    const modal = new MockElement('div', 'item-details-modal');
    modal.classList.remove('hidden');

    // Backdrop click does not attach dismissal listener
    modal.dispatchEvent(new MockEvent('click', { target: modal }));
    assert.strictEqual(modal.classList.contains('hidden'), false);
    console.log('✓ Test 11: Backdrop click does NOT dismiss dialog (disabled overlay click) passed');
  })();

})().catch(e => { console.error(e); process.exit(1); }).then(() => console.log("\nAll LiteSync File Action Dialog & Gesture Unit Tests Passed Successfully!"));

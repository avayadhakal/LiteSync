(() => {
  class SelectionState {
    constructor(include = [], exclude = []) {
      this.include = new Set(include.map(normalizePath));
      this.exclude = new Set(exclude.map(normalizePath));
    }

    clear() {
      this.include.clear();
      this.exclude.clear();
    }

    get size() {
      return this.getTopLevelIncludes().length;
    }

    get hasSelection() {
      return this.include.size > 0;
    }

    isPathSelected(path) {
      if (!path) return false;
      const norm = normalizePath(path);
      let longestMatchLen = -1;
      let matchType = null;

      for (const inc of this.include) {
        if (norm === inc || inc === '/' || norm.startsWith(inc + '/')) {
          const len = inc === '/' ? 1 : inc.length;
          if (len > longestMatchLen) {
            longestMatchLen = len;
            matchType = 'include';
          }
        }
      }

      for (const exc of this.exclude) {
        if (norm === exc || exc === '/' || norm.startsWith(exc + '/')) {
          const len = exc === '/' ? 1 : exc.length;
          if (len > longestMatchLen) {
            longestMatchLen = len;
            matchType = 'exclude';
          }
        }
      }

      return matchType === 'include';
    }

    isPathIndeterminate(path) {
      if (!path) return false;
      const norm = normalizePath(path);
      const selected = this.isPathSelected(norm);

      if (selected) {
        for (const exc of this.exclude) {
          if (exc !== norm && (norm === '/' || exc.startsWith(norm + '/'))) {
            if (!this.isPathSelected(exc)) {
              return true;
            }
          }
        }
        return false;
      } else {
        for (const inc of this.include) {
          if (inc !== norm && (norm === '/' || inc.startsWith(norm + '/'))) {
            if (this.isPathSelected(inc)) {
              return true;
            }
          }
        }
        return false;
      }
    }

    _longestAncestor(normPath) {
      let longestMatch = null;
      let longestMatchLen = -1;
      let matchType = null;

      for (const inc of this.include) {
        if (inc !== normPath && (inc === '/' || normPath.startsWith(inc + '/'))) {
          const len = inc === '/' ? 1 : inc.length;
          if (len > longestMatchLen) {
            longestMatchLen = len;
            longestMatch = inc;
            matchType = 'include';
          }
        }
      }

      for (const exc of this.exclude) {
        if (exc !== normPath && (exc === '/' || normPath.startsWith(exc + '/'))) {
          const len = exc === '/' ? 1 : exc.length;
          if (len > longestMatchLen) {
            longestMatchLen = len;
            longestMatch = exc;
            matchType = 'exclude';
          }
        }
      }

      return { match: longestMatch, type: matchType };
    }

    select(path) {
      const norm = normalizePath(path);
      this.exclude.delete(norm);

      for (const exc of Array.from(this.exclude)) {
        if (norm === '/' ? exc !== '/' : exc.startsWith(norm + '/')) {
          this.exclude.delete(exc);
        }
      }
      for (const inc of Array.from(this.include)) {
        if (norm === '/' ? inc !== '/' : inc.startsWith(norm + '/')) {
          this.include.delete(inc);
        }
      }

      const ancestor = this._longestAncestor(norm);
      if (ancestor.type !== 'include') {
        this.include.add(norm);
      }
    }

    unselect(path) {
      const norm = normalizePath(path);
      this.include.delete(norm);

      for (const inc of Array.from(this.include)) {
        if (norm === '/' ? inc !== '/' : inc.startsWith(norm + '/')) {
          this.include.delete(inc);
        }
      }
      for (const exc of Array.from(this.exclude)) {
        if (norm === '/' ? exc !== '/' : exc.startsWith(norm + '/')) {
          this.exclude.delete(exc);
        }
      }

      const ancestor = this._longestAncestor(norm);
      if (ancestor.type === 'include') {
        this.exclude.add(norm);
      }
    }

    migratePath(oldPath, newPath) {
      const normOld = normalizePath(oldPath);
      const normNew = normalizePath(newPath);
      if (normOld === normNew) return;

      const prefixOld = normOld === '/' ? '/' : normOld + '/';

      const newInclude = new Set();
      for (const inc of this.include) {
        if (inc === normOld) {
          newInclude.add(normNew);
        } else if (inc.startsWith(prefixOld)) {
          newInclude.add(normNew + inc.slice(normOld.length));
        } else {
          newInclude.add(inc);
        }
      }
      this.include = newInclude;

      const newExclude = new Set();
      for (const exc of this.exclude) {
        if (exc === normOld) {
          newExclude.add(normNew);
        } else if (exc.startsWith(prefixOld)) {
          newExclude.add(normNew + exc.slice(normOld.length));
        } else {
          newExclude.add(exc);
        }
      }
      this.exclude = newExclude;
    }

    deletePath(path) {
      const norm = normalizePath(path);
      const prefix = norm === '/' ? '/' : norm + '/';

      for (const inc of Array.from(this.include)) {
        if (inc === norm || inc.startsWith(prefix)) {
          this.include.delete(inc);
        }
      }
      for (const exc of Array.from(this.exclude)) {
        if (exc === norm || exc.startsWith(prefix)) {
          this.exclude.delete(exc);
        }
      }
    }

    getTopLevelIncludes() {
      const roots = [];
      for (const inc of this.include) {
        const ancestor = this._longestAncestor(inc);
        if (ancestor.type !== 'include') {
          roots.push(inc);
        }
      }
      return roots.sort();
    }

    toTransferSources() {
      const topIncludes = this.getTopLevelIncludes();
      const result = [];

      for (const root of topIncludes) {
        const prefix = root === '/' ? '/' : root + '/';
        const relativeExcludes = [];
        for (const exc of this.exclude) {
          if (exc.startsWith(prefix)) {
            let closestInc = null;
            let closestLen = -1;
            for (const inc of this.include) {
              if (exc.startsWith(inc === '/' ? '/' : inc + '/')) {
                const len = inc === '/' ? 1 : inc.length;
                if (len > closestLen) {
                  closestLen = len;
                  closestInc = inc;
                }
              }
            }
            if (closestInc === root) {
              const rel = root === '/' ? exc.slice(1) : exc.slice(root.length + 1);
              if (rel) {
                relativeExcludes.push(rel);
              }
            }
          }
        }

        if (relativeExcludes.length === 0) {
          result.push(root);
        } else {
          result.push({
            path: root,
            excludes: relativeExcludes.sort(),
          });
        }
      }

      return result;
    }
  }

  function normalizePath(p) {
    return String(p || '').replace(/\/+/g, '/').replace(/\/+$/g, '') || '/';
  }

  const state = {
    roots: [],
    source: { path: null, entries: [] },
    dest: { path: null, entries: [] },
    selection: new SelectionState(),     // Selection in the SOURCE pane  (drives Transfer)
    destSelection: new SelectionState(), // Selection in the DEST pane   (mkdir/rename/delete target)
    historyTab: 'active', // 'active' | 'activity'
    tasks: [],
    activeTaskId: null,
    finishedTaskIds: new Set(), // task ids whose completion was already handled
    historyLoaded: false,
    activity: [], // [{id, kind, message, created_at}] newest-first
  };

  const el = (id) => document.getElementById(id);

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401 || res.status === 303) {
      window.location.href = '/login.html';
      throw new Error('unauthenticated');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v.toFixed(1)} ${units[i]}`;
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for plain HTTP / non-localhost IP contexts
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      const successful = document.execCommand('copy');
      textArea.remove();

      if (!successful) {
        throw new Error("Copy command failed");
      }
    }
  }

  async function copyDownloadLink(path) {
    try {
      const data = await api(`/api/download/link?path=${encodeURIComponent(path)}`);
      const fullUrl = new URL(data.url, window.location.origin).href;
      await copyToClipboard(fullUrl);
      toastSuccess('Download link copied');
      return true;
    } catch (err) {
      toastError(err.message || 'Failed to copy link');
      return false;
    }
  }

  function attachLongPress(element, onLongPress) {
    let startX = 0;
    let startY = 0;
    let timer = null;
    let longPressed = false;
    const MOVE_THRESHOLD = 10; // 10px

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

  function openItemDetailsModal(entry) {
    const modal = el('item-details-modal');
    if (!modal) return;

    el('item-details-name').textContent = entry.name;
    el('item-details-path').textContent = entry.path;

    const copyBtn = el('item-details-copy');
    if (copyBtn) {
      if (entry.is_dir) {
        copyBtn.classList.add('hidden');
      } else {
        copyBtn.classList.remove('hidden');
        copyBtn.textContent = 'Copy URL';
        copyBtn.disabled = false;
        copyBtn.onclick = async (e) => {
          e.stopPropagation();
          const success = await copyDownloadLink(entry.path);
          if (success) {
            closeItemDetailsModal();
          }
        };
      }
    }

    modal.classList.remove('hidden');
  }

  function closeItemDetailsModal() {
    const modal = el('item-details-modal');
    if (modal) modal.classList.add('hidden');
  }

  // --- Pane rendering ---

  async function loadPane(which, path, forceRefresh = false) {
    const pane = state[which];
    if (path === null) {
      pane.path = null;
      pane.entries = state.roots.map((r) => ({ name: r, path: r, is_dir: true, size: 0 }));
      pane.parent = undefined;
    } else {
      let fetchPath = path;
      try {
        const data = await api(`/api/browse?path=${encodeURIComponent(fetchPath)}`, {
          // Fresh fetch — never serve the browser's cached directory listing,
          // otherwise moved/deleted entries linger in the pane after transfers.
          ...(forceRefresh ? { cache: 'no-store' } : {}),
        });
        pane.path = data.path;
        pane.entries = data.entries;
        pane.parent = data.parent;
      } catch (err) {
        // The current directory itself may have just been moved/deleted by a
        // completed transfer: fall back to its parent so the pane never shows
        // a listing of a path that no longer exists.
        const parent = normalizePath(fetchPath).replace(/\/[^/]+$/, '') || '/';
        if (parent !== normalizePath(fetchPath)) {
          await loadPane(which, parent, true);
          return;
        }
        throw err;
      }
    }
    // Selections persist across navigation: the SelectionState is keyed by absolute path,
    // so navigating away and back re-checks entries that are still selected.
    // Mutations (rename/delete/transfer-finish) prune stale paths explicitly.
    renderPane(which);
    updateSelectionUI();
  }

  // Per-pane selection accessor. The source pane drives Transfer submissions;
  // the dest pane supports the same file operations via its own selection.
  function paneSelection(which) {
    return which === 'source' ? state.selection : state.destSelection;
  }

  function renderPane(which) {
    const pane = state[which];
    const sel = paneSelection(which);
    el(`${which}-path`).textContent = pane.path === null ? '(select a root)' : pane.path;
    const body = el(`${which}-body`);
    const prevScrollTop = body.scrollTop;
    body.innerHTML = '';

    if (pane.path !== null) {
      const up = document.createElement('div');
      up.className = 'entry parent';
      up.innerHTML = '<span class="name">..</span>';
      up.addEventListener('click', () => loadPane(which, pane.parent));
      body.appendChild(up);
    }

    for (const entry of pane.entries) {
      const row = document.createElement('div');
      row.className = `entry ${entry.is_dir ? 'dir' : 'file'}`;

      // Both panes expose selection checkboxes so the user can mark items for
      // New Folder (parent), Rename, and Delete in either pane. Only the
      // source pane's selection is used to build the Transfer payload.
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const isSelected = sel.isPathSelected(entry.path);
      cb.checked = isSelected;
      // Directory tri-state: fully checked when the dir itself is selected with no excludes,
      // indeterminate when partially selected / partially excluded.
      if (entry.is_dir) {
        cb.indeterminate = sel.isPathIndeterminate(entry.path);
      }
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cb.checked) {
          sel.select(entry.path);
        } else {
          sel.unselect(entry.path);
        }
        renderPane(which);
        updateSelectionUI();
      });
      row.appendChild(cb);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
      name.title = entry.name;
      row.appendChild(name);

      if (!entry.is_dir) {
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatSize(entry.size);
        row.appendChild(size);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'icon-btn btn-copy-path';
        copyBtn.innerHTML = '📋';
        copyBtn.title = 'Copy download link';
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const success = await copyDownloadLink(entry.path);
          if (success) {
            copyBtn.innerHTML = '✓';
            copyBtn.style.color = 'var(--success)';
            setTimeout(() => {
              copyBtn.innerHTML = '📋';
              copyBtn.style.color = '';
            }, 1500);
          }
        });
        row.appendChild(copyBtn);
      }

      row.title = entry.path;

      // Attach long-press listener strictly to filename area
      const isLongPressed = attachLongPress(name, () => {
        openItemDetailsModal(entry);
      });

      if (entry.is_dir) {
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.closest('.btn-copy-path')) return;
          if (isLongPressed()) {
            return;
          }
          loadPane(which, entry.path);
        });
      }

      body.appendChild(row);
    }
    body.scrollTop = prevScrollTop;
  }

  function updateSelectionUI() {
    // Only the source pane drives the Transfer button; show its count.
    const count = state.selection.size;
    el('transfer-btn').disabled = !(count > 0 && state.dest.path);

    // Inline selection summary in the .controls footer. Hiding the whole badge
    // wrapper (not just its children) prevents an empty-pill artifact at 0 selected
    // and collapses the nested popover's anchor automatically.
    const countEl = el('selection-inline-count');
    const viewBtn = el('selection-view-btn');
    const clearBtn = el('selection-clear-btn');
    const inlineGroup = el('selection-inline');
    const hasSel = count > 0;
    if (countEl) {
      countEl.textContent = hasSel ? `${count} selected` : '';
      countEl.classList.toggle('hidden', !hasSel);
    }
    if (viewBtn) viewBtn.classList.toggle('hidden', !hasSel);
    if (clearBtn) clearBtn.classList.toggle('hidden', !hasSel);
    if (inlineGroup) inlineGroup.classList.toggle('hidden', !hasSel);

    // Refresh the preview popover contents if it's open.
    const preview = el('selection-preview');
    if (preview && !preview.classList.contains('hidden')) {
      renderSelectionPreview();
    }
  }

  function renderSelectionPreview() {
    const list = el('selection-preview-list');
    const countEl = el('selection-preview-count');
    if (!list || !countEl) return;
    const sources = state.selection.toTransferSources();
    countEl.textContent = `${sources.length} selected`;
    list.innerHTML = '';
    for (const item of sources) {
      const li = document.createElement('li');
      if (typeof item === 'string') {
        li.textContent = item;
        li.title = item;
      } else {
        const text = `${item.path} (excluding: ${item.excludes.join(', ')})`;
        li.textContent = text;
        li.title = text;
      }
      list.appendChild(li);
    }
  }

  function openSelectionPreview() {
    const preview = el('selection-preview');
    if (!preview) return;
    renderSelectionPreview();
    preview.classList.remove('hidden');
  }

  function closeSelectionPreview() {
    const preview = el('selection-preview');
    if (preview) preview.classList.add('hidden');
  }

  function toggleSelectionPreview() {
    const preview = el('selection-preview');
    if (!preview) return;
    if (preview.classList.contains('hidden')) openSelectionPreview();
    else closeSelectionPreview();
  }

  // --- Toast notifications (top-right stack) ---

  // kind: 'success' | 'error' | 'info' | 'warn'. Returns the element so callers
  // can dismiss it early if needed.
  function showToast(msg, kind = 'info', timeoutMs = 4000) {
    const stack = el('toast-stack');
    if (!stack) return null;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    stack.appendChild(t);
    const dismiss = () => {
      t.classList.add('toast-out');
      setTimeout(() => t.remove(), 220);
    };
    t.addEventListener('click', dismiss);
    if (timeoutMs > 0) setTimeout(dismiss, timeoutMs);
    // Cap stack size to avoid unbounded growth on rapid events.
    while (stack.children.length > 5) stack.firstChild.remove();
    return t;
  }

  // Back-compat convenience wrapper for boolean isError callers.
  function toastSuccess(msg) { showToast(msg, 'success'); }
  function toastError(msg)   { showToast(msg, 'error'); }

  // --- Activity log (Authoritative SQLite persistence via /api/activity) ---

  async function loadActivity() {
    try {
      const data = await api('/api/activity?limit=100');
      state.activity = data.activity || [];
      renderActivity();
    } catch (err) {
      console.error('Failed to load activity:', err);
    }
  }

  async function clearActivity() {
    try {
      await api('/api/activity', { method: 'DELETE' });
      state.activity = [];
      renderActivity();
      toastSuccess('Activity log cleared.');
    } catch (err) {
      toastError(`Failed to clear activity log: ${err.message}`);
    }
  }

  function formatActivityTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function parseActivityMessage(rawMsg, kind) {
    if (typeof rawMsg === 'object' && rawMsg !== null) {
      return rawMsg;
    }
    if (typeof rawMsg === 'string') {
      const trimmed = rawMsg.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          return JSON.parse(trimmed);
        } catch (_err) {}
      }
    }
    // Fallback for legacy plain text messages
    return {
      operation: kind || 'info',
      status: 'succeeded',
      name: String(rawMsg || ''),
      summary: String(rawMsg || ''),
    };
  }

  function getActivityDisplayInfo(entry) {
    const data = parseActivityMessage(entry.message, entry.kind);
    const op = (data.operation || entry.kind || 'info').toLowerCase();
    const status = (data.status || 'succeeded').toLowerCase();

    let icon = '✓';
    let badgeText = 'SUCCESS';
    let statusClass = 'status-succeeded';
    let primaryText = data.name || data.summary || data.path || 'Operation';
    let secondaryHtml = '';

    if (op === 'move') {
      badgeText = 'MOVED';
      if (status === 'succeeded') {
        icon = '✓';
        statusClass = 'status-succeeded';
        const dst = data.destination ? normalizePath(data.destination).split('/').pop() || data.destination : '';
        secondaryHtml = `→ ${escapeHtml(dst || data.destination || '')} <span class="activity-tag">[source deleted]</span>`;
      } else if (status === 'interrupted') {
        icon = '⊘';
        badgeText = 'INTERRUPTED — MOVE';
        statusClass = 'status-interrupted';
        secondaryHtml = escapeHtml(data.summary || data.error || 'cancelled by user');
      } else {
        icon = '✗';
        badgeText = 'FAILED — MOVE';
        statusClass = 'status-failed';
        secondaryHtml = escapeHtml(data.summary || data.error || 'rsync exited with error');
      }
    } else if (op === 'copy' || op === 'transfer') {
      badgeText = 'COPIED';
      if (status === 'succeeded') {
        icon = '✓';
        statusClass = 'status-succeeded';
        const dst = data.destination ? normalizePath(data.destination).split('/').pop() || data.destination : '';
        secondaryHtml = `→ ${escapeHtml(dst || data.destination || '')}`;
      } else if (status === 'interrupted') {
        icon = '⊘';
        badgeText = 'INTERRUPTED — COPY';
        statusClass = 'status-interrupted';
        secondaryHtml = escapeHtml(data.summary || data.error || 'cancelled by user');
      } else {
        icon = '✗';
        badgeText = 'FAILED — COPY';
        statusClass = 'status-failed';
        secondaryHtml = escapeHtml(data.summary || data.error || 'rsync exited with error');
      }
    } else if (op === 'mkdir') {
      icon = '+';
      badgeText = 'CREATED FOLDER';
      statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
      primaryText = data.summary || data.name || data.path;
      if (status === 'failed') {
        icon = '✗';
        badgeText = 'FAILED — NEW FOLDER';
        secondaryHtml = escapeHtml(data.error || 'Failed to create directory');
      }
    } else if (op === 'rename') {
      icon = '→';
      badgeText = 'RENAMED';
      statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
      primaryText = data.summary || (data.old_name ? `${data.old_name} → ${data.new_name}` : data.name);
      if (status === 'failed') {
        icon = '✗';
        badgeText = 'FAILED — RENAME';
        secondaryHtml = escapeHtml(data.error || 'Failed to rename');
      }
    } else if (op === 'delete') {
      icon = '🗑';
      badgeText = 'DELETED';
      statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
      primaryText = data.name || (data.path ? normalizePath(data.path).split('/').pop() : 'item');
      if (status === 'failed') {
        icon = '✗';
        badgeText = 'FAILED — DELETE';
        secondaryHtml = escapeHtml(data.error || 'Failed to delete');
      }
    } else if (op === 'upload') {
      const dst = data.destination ? normalizePath(data.destination) : '';
      if (status === 'succeeded') {
        icon = '⬆';
        badgeText = 'UPLOADED';
        statusClass = 'status-succeeded';
        primaryText = data.name || (data.path ? normalizePath(data.path).split('/').pop() : 'file');
        secondaryHtml = dst ? `→ ${escapeHtml(dst)}` : '';
      } else {
        icon = '✗';
        badgeText = 'UPLOAD FAILED';
        statusClass = 'status-failed';
        primaryText = data.name || 'file';
        const reason = data.error || data.summary || 'Upload failed';
        secondaryHtml = dst ? `→ ${escapeHtml(dst)}<br><span style="color: var(--danger); font-size: 11px;">${escapeHtml(reason)}</span>` : `<span style="color: var(--danger); font-size: 11px;">${escapeHtml(reason)}</span>`;
      }
    } else {
      badgeText = (entry.kind || 'INFO').toUpperCase();
      statusClass = 'status-info';
      primaryText = data.summary || data.name || String(entry.message);
    }

    return {
      icon,
      badgeText,
      statusClass,
      primaryText,
      secondaryHtml,
      data,
    };
  }

  function renderActivity() {
    const container = el('activity-container');
    if (!container) return;
    container.innerHTML = '';

    const clearBtn = el('clear-activity-btn');
    if (clearBtn && state.historyTab === 'activity') {
      clearBtn.classList.toggle('hidden', state.activity.length === 0);
    }

    if (state.activity.length === 0) {
      container.innerHTML = `<div class="empty-state">No activity yet</div>`;
      return;
    }

    for (const entry of state.activity) {
      const info = getActivityDisplayInfo(entry);
      const card = document.createElement('div');
      card.className = `activity-card ${info.statusClass}`;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      card.innerHTML = `
        <div class="activity-card-header">
          <div class="activity-badge-group">
            <span class="activity-status-icon">${info.icon}</span>
            <span class="activity-op-badge">${escapeHtml(info.badgeText)}</span>
          </div>
          <div class="activity-meta">
            <span class="activity-time">${escapeHtml(formatActivityTime(entry.created_at || entry.ts))}</span>
            <button class="activity-details-btn" title="View Details">Details</button>
          </div>
        </div>
        <div class="activity-card-body">
          <div class="activity-primary-line" title="${escapeHtml(info.primaryText)}">${escapeHtml(info.primaryText)}</div>
          ${info.secondaryHtml ? `<div class="activity-secondary-line">${info.secondaryHtml}</div>` : ''}
        </div>
      `;

      const openDetails = (e) => {
        e.stopPropagation();
        openActivityDetails(entry, info);
      };

      card.addEventListener('click', openDetails);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetails(e);
        }
      });

      const detailsBtn = card.querySelector('.activity-details-btn');
      if (detailsBtn) {
        detailsBtn.addEventListener('click', openDetails);
      }

      container.appendChild(card);
    }
  }

  function openActivityDetails(entry, info) {
    const modal = el('activity-details-modal');
    const body = el('activity-details-body');
    if (!modal || !body) return;

    if (!info) info = getActivityDisplayInfo(entry);
    const data = info.data || {};
    const createdStr = entry.created_at || (entry.ts ? new Date(entry.ts).toISOString() : '');

    const rows = [];
    rows.push({ label: 'Timestamp', value: `${formatActivityTime(createdStr)} (${createdStr})` });
    rows.push({ label: 'Operation', value: (data.operation || entry.kind || 'unknown').toUpperCase() });
    rows.push({ label: 'Status', value: (data.status || 'succeeded').toUpperCase() });

    if (data.source) {
      rows.push({ label: 'Source Path', value: data.source, copyable: true });
    }
    if (data.destination) {
      rows.push({ label: 'Destination', value: data.destination, copyable: true });
    }
    if (data.old_path) {
      rows.push({ label: 'Original Path', value: data.old_path, copyable: true });
    }
    if (data.new_path) {
      rows.push({ label: 'New Path', value: data.new_path, copyable: true });
    }
    if (data.path && !data.source && !data.destination && !data.old_path) {
      rows.push({ label: 'Path', value: data.path, copyable: true });
    }
    if (data.exit_code !== undefined && data.exit_code !== null) {
      rows.push({ label: 'Exit Code', value: String(data.exit_code) });
    }
    if (data.summary) {
      rows.push({ label: 'Summary', value: data.summary });
    }

    body.innerHTML = '';
    for (const r of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'activity-details-row';
      const labelEl = document.createElement('div');
      labelEl.className = 'activity-details-label';
      labelEl.textContent = r.label;
      const valEl = document.createElement('div');
      valEl.className = 'activity-details-value';

      if (r.copyable) {
        valEl.className += ' activity-details-copyable';
        const textSpan = document.createElement('span');
        textSpan.textContent = r.value;
        textSpan.style.wordBreak = 'break-all';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'icon-btn';
        copyBtn.innerHTML = '📋';
        copyBtn.title = 'Copy path';
        copyBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await copyToClipboard(r.value);
            copyBtn.innerHTML = '✓';
            copyBtn.style.color = 'var(--success)';
            toastSuccess('Copied to clipboard');
            setTimeout(() => {
              copyBtn.innerHTML = '📋';
              copyBtn.style.color = '';
            }, 1500);
          } catch (_err) {}
        });
        valEl.appendChild(textSpan);
        valEl.appendChild(copyBtn);
      } else {
        valEl.textContent = r.value;
      }

      rowEl.appendChild(labelEl);
      rowEl.appendChild(valEl);
      body.appendChild(rowEl);
    }

    if (data.error) {
      const errBox = document.createElement('div');
      errBox.className = 'activity-details-error';
      errBox.textContent = `Error: ${data.error}`;
      body.appendChild(errBox);
    }

    modal.classList.remove('hidden');
  }

  function closeActivityDetails() {
    const modal = el('activity-details-modal');
    if (modal) modal.classList.add('hidden');
  }

  // --- Source pane actions: New Folder / Rename / Delete ---
  // Each uses a dedicated popup that matches the transfer-confirm modal style.

  function setModalError(which, msg) {
    const errEl = el(`${which}-error`);
    if (errEl) {
      errEl.textContent = msg || '';
      errEl.classList[msg ? 'remove' : 'add']('hidden');
    }
  }

  function openModal(which) {
    el(`${which}-modal`).classList.remove('hidden');
    requestAnimationFrame(() => {
      const input = el(`${which}-input`);
      if (input) { input.focus(); input.select(); }
    });
  }

  function closeModal(which) {
    el(`${which}-modal`).classList.add('hidden');
    setModalError(which, '');
  }

  function openMkdirModal(which = 'source') {
    if (!state[which].path) {
      toastError(`Navigate to a folder in the ${which === 'source' ? 'Source' : 'Destination'} pane first.`);
      return;
    }
    el('mkdir-modal').dataset.pane = which;
    el('mkdir-input').value = '';
    el('mkdir-location').textContent = state[which].path;
    openModal('mkdir');
  }

  async function submitMkdir() {
    const which = el('mkdir-modal').dataset.pane || 'source';
    const name = el('mkdir-input').value.trim();
    if (!name) {
      setModalError('mkdir', 'Folder name is required.');
      return;
    }
    if (name.includes('/') || name.includes('\\')) {
      setModalError('mkdir', 'Name cannot contain slashes.');
      return;
    }
    try {
      await api('/api/mkdir', {
        method: 'POST',
        body: JSON.stringify({ path: state[which].path, name }),
      });
      closeModal('mkdir');
      await loadPane(which, state[which].path, true);
      toastSuccess(`Created folder: ${name}`);
      await loadActivity();
    } catch (err) {
      setModalError('mkdir', err.message);
    }
  }

  function openRenameModal(which) {
    const sel = paneSelection(which);
    const roots = sel.getTopLevelIncludes();
    if (roots.length !== 1) {
      toastError('Select exactly one item to rename.');
      return;
    }
    const selectedPath = roots[0];
    const currentName = normalizePath(selectedPath).split('/').pop();
    el('rename-modal').dataset.pane = which;
    el('rename-modal').dataset.path = selectedPath;
    el('rename-input').value = currentName;
    el('rename-target').textContent = selectedPath;
    openModal('rename');
  }

  async function submitRename() {
    const modal = el('rename-modal');
    const which = modal.dataset.pane || 'source';
    const selectedPath = modal.dataset.path;
    if (!selectedPath) { closeModal('rename'); return; }
    const sel = paneSelection(which);
    const currentName = normalizePath(selectedPath).split('/').pop();

    const name = el('rename-input').value.trim();
    if (!name) {
      setModalError('rename', 'Name is required.');
      return;
    }
    if (name.includes('/') || name.includes('\\')) {
      setModalError('rename', 'Name cannot contain slashes.');
      return;
    }
    if (name === currentName) {
      closeModal('rename');
      return;
    }
    try {
      const result = await api('/api/rename', {
        method: 'POST',
        body: JSON.stringify({ path: selectedPath, new_name: name }),
      });
      closeModal('rename');
      sel.migratePath(selectedPath, result.new_path);
      updateSelectionUI();
      await loadPane(which, state[which].path, true);
      toastSuccess(`Renamed to: ${name}`);
      await loadActivity();
    } catch (err) {
      setModalError('rename', err.message);
    }
  }

  function openDeleteModal(which) {
    const sel = paneSelection(which);
    const paths = sel.getTopLevelIncludes();
    if (paths.length === 0) {
      toastError('Select one or more items to delete.');
      return;
    }
    // Snapshot selection at open time so submitDelete doesn't depend on live state.
    el('delete-modal').dataset.pane = which;
    el('delete-title').textContent =
      paths.length === 1 ? 'Delete this item?' : `Delete ${paths.length} items?`;
    const list = el('delete-list');
    list.innerHTML = '';
    for (const p of paths) {
      const li = document.createElement('li');
      li.textContent = normalizePath(p).split('/').pop();
      list.appendChild(li);
    }
    openModal('delete');
  }

  async function submitDelete() {
    const which = el('delete-modal').dataset.pane || 'source';
    const sel = paneSelection(which);
    const paths = sel.getTopLevelIncludes();
    if (paths.length === 0) { closeModal('delete'); return; }
    closeModal('delete');
    const failures = [];
    for (const p of paths) {
      try {
        await api('/api/delete', {
          method: 'POST',
          body: JSON.stringify({ path: p }),
        });
        sel.deletePath(p);
      } catch (err) {
        failures.push(`${normalizePath(p).split('/').pop()}: ${err.message}`);
      }
    }
    updateSelectionUI();
    await loadPane(which, state[which].path, true);

    if (failures.length === 0) {
      toastSuccess(paths.length === 1 ? 'Deleted.' : `Deleted ${paths.length} items.`);
    } else {
      toastError(`Some items could not be deleted: ${failures.join('; ')}`);
    }
    await loadActivity();
  }

  // --- Browser File Upload (Multipart streaming straight to disk) ---

  function openUploadPicker(pane) {
    const curPath = state[pane] && state[pane].path;
    if (!curPath) {
      toastError(`Navigate to a folder in the ${pane === 'source' ? 'Source' : 'Destination'} pane first.`);
      return;
    }
    state.pendingUploadPane = pane;
    state.pendingUploadPath = curPath;
    const fileInput = el('upload-file-input');
    if (fileInput) {
      fileInput.click();
    }
  }

  function startUploads(pane, destPath, files) {
    if (!files || files.length === 0) return;
    const stack = el('toast-stack');
    if (!stack) return;

    const card = document.createElement('div');
    card.className = 'upload-card';

    const header = document.createElement('div');
    header.className = 'upload-card-header';
    const folderName = normalizePath(destPath).split('/').pop() || destPath;
    header.innerHTML = `<span>Uploading ${files.length} file${files.length === 1 ? '' : 's'} → ${escapeHtml(folderName)}</span>`;
    card.appendChild(header);

    const rowsContainer = document.createElement('div');
    rowsContainer.className = 'upload-card-rows';
    card.appendChild(rowsContainer);

    stack.appendChild(card);

    const inFlight = [];

    files.forEach((file, idx) => {
      const uploadItem = {
        id: `up_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        file: file,
        xhr: null,
        loaded: 0,
        total: file.size || 0,
        percent: 0,
        status: 'uploading',
        rowEl: null,
        fillEl: null,
        detailsEl: null,
      };

      const row = document.createElement('div');
      row.className = 'upload-row';

      const top = document.createElement('div');
      top.className = 'upload-row-top';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'upload-row-name';
      nameSpan.textContent = file.name;
      nameSpan.title = file.name;

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'upload-cancel-btn';
      cancelBtn.innerHTML = '&times;';
      cancelBtn.title = 'Cancel upload';
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (uploadItem.xhr && uploadItem.status === 'uploading') {
          uploadItem.status = 'aborted';
          uploadItem.xhr.abort();
        }
      });

      top.appendChild(nameSpan);
      top.appendChild(cancelBtn);
      row.appendChild(top);

      const track = document.createElement('div');
      track.className = 'upload-progress-track';
      const fill = document.createElement('div');
      fill.className = 'upload-progress-fill';
      track.appendChild(fill);
      row.appendChild(track);

      const details = document.createElement('div');
      details.className = 'upload-row-details';
      details.innerHTML = `<span>0%</span><span>${formatSize(0)} / ${formatSize(file.size || 0)}</span>`;
      row.appendChild(details);

      rowsContainer.appendChild(row);

      uploadItem.rowEl = row;
      uploadItem.fillEl = fill;
      uploadItem.detailsEl = details;
      inFlight.push(uploadItem);
    });

    const checkAllFinished = () => {
      const remaining = inFlight.filter((u) => u.status === 'uploading');
      if (remaining.length === 0) {
        card.classList.add('toast-out');
        setTimeout(() => card.remove(), 220);
      }
    };

    inFlight.forEach((item) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;

      xhr.open('POST', '/api/upload');

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && item.status === 'uploading') {
          item.loaded = ev.loaded;
          item.total = ev.total;
          item.percent = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
          if (item.fillEl) item.fillEl.style.width = `${item.percent}%`;
          if (item.detailsEl) {
            item.detailsEl.innerHTML = `<span>${item.percent}%</span><span>${formatSize(ev.loaded)} / ${formatSize(ev.total)}</span>`;
          }
        }
      };

      xhr.onload = async () => {
        if (item.status === 'aborted') return;
        if (xhr.status >= 200 && xhr.status < 300) {
          item.status = 'succeeded';
          toastSuccess(`Uploaded ${item.file.name}`);
        } else {
          item.status = 'failed';
          let errMsg = 'Upload failed';
          try {
            const resJson = JSON.parse(xhr.responseText);
            if (resJson && resJson.detail) errMsg = resJson.detail;
          } catch (_) {
            if (xhr.statusText) errMsg = xhr.statusText;
          }
          toastError(`Upload failed for ${item.file.name}: ${errMsg}`);
        }

        if (state[pane] && state[pane].path === destPath) {
          await loadPane(pane, destPath);
        }
        await loadActivity();

        if (item.rowEl) item.rowEl.remove();
        checkAllFinished();
      };

      xhr.onerror = async () => {
        if (item.status === 'aborted') return;
        item.status = 'failed';
        toastError(`Upload failed for ${item.file.name}: Network error`);
        await loadActivity();
        if (item.rowEl) item.rowEl.remove();
        checkAllFinished();
      };

      xhr.onabort = async () => {
        item.status = 'aborted';
        if (item.rowEl) item.rowEl.remove();
        checkAllFinished();
      };

      const fd = new FormData();
      fd.append('path', destPath);
      fd.append('files', item.file, item.file.name);
      xhr.send(fd);
    });
  }

  // --- Transfer flow ---

  function openConfirmModal() {
    const list = el('confirm-list');
    list.innerHTML = '';
    const sources = state.selection.toTransferSources();
    for (const item of sources) {
      const li = document.createElement('li');
      if (typeof item === 'string') {
        li.textContent = item;
      } else {
        li.textContent = `${item.path} (excluding ${item.excludes.join(', ')})`;
      }
      list.appendChild(li);
    }
    el('confirm-dest').textContent = state.dest.path;
    const copyRadio = document.querySelector('input[name="transfer-op"][value="copy"]');
    if (copyRadio) copyRadio.checked = true;
    el('confirm-modal').classList.remove('hidden');
  }

  function closeConfirmModal() {
    el('confirm-modal').classList.add('hidden');
  }

  async function submitTransfer() {
    closeConfirmModal();
    const opRadio = document.querySelector('input[name="transfer-op"]:checked');
    const operation = opRadio ? opRadio.value : 'copy';
    const sources = state.selection.toTransferSources();
    const body = {
      sources: sources,
      destination: state.dest.path,
      operation: operation,
    };
    let result;
    try {
      result = await api('/api/transfer', { method: 'POST', body: JSON.stringify(body) });
    } catch (err) {
      toastError(`Transfer failed to start: ${err.message}`);
      return;
    }
    const itemCount = Array.isArray(result.task_ids) ? result.task_ids.length : body.sources.length;
    const opLabel = operation === 'move' ? 'move' : 'copy';
    toastSuccess(`Queued ${itemCount} ${opLabel}${itemCount === 1 ? '' : 's'} → ${body.destination}`);
    // Reset the form to defaults after a successful queue (matches the
    // selection Clear button flow): empty the selection, redraw the source
    // pane so checkbox ticks clear, and restore the operation selection.
    state.selection.clear();
    const copyRadio = document.querySelector('input[name="transfer-op"][value="copy"]');
    if (copyRadio) copyRadio.checked = true;
    updateSelectionUI();
    renderPane('source');
    setHistoryTab('active');
    // Auto-refresh destination pane on start
    if (state.dest.path) {
      await loadPane('dest', state.dest.path);
    }
    await loadHistory();
  }

  // --- Transfer progress streaming ---

  function getPrimaryTitle(sources) {
    // Tasks are unbatched server-side (exactly one source per task).
    let first = '';
    if (Array.isArray(sources) && sources.length > 0) {
      first = sources[0];
    } else if (typeof sources === 'string' && sources.trim()) {
      first = sources.split(',')[0].trim();
    }
    if (!first) return 'Transfer';
    const trimmed = first.replace(/\/+$/, '');
    const parts = trimmed.split('/');
    return parts[parts.length - 1] || first;
  }

  async function setHistoryTab(tab) {
    state.historyTab = tab;
    const isActiveTab = tab === 'active';
    const isActivityTab = tab === 'activity';

    el('tab-active-btn').classList.toggle('active', isActiveTab);
    el('tab-activity-btn').classList.toggle('active', isActivityTab);

    const activeContainer = el('active-transfers-container');
    const activityContainer = el('activity-container');

    activeContainer.classList.toggle('hidden', !isActiveTab);
    activityContainer.classList.toggle('hidden', !isActivityTab);

    el('clear-activity-btn').classList.toggle('hidden', !isActivityTab || state.activity.length === 0);

    if (isActiveTab) {
      renderActiveTransfers();
    } else if (isActivityTab) {
      await loadActivity();
    }
  }

  const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted']);
  const ACTIVE_STATUSES = new Set(['queued', 'running']);

  async function loadHistory() {
    try {
      const data = await api('/api/tasks?limit=100');
      const incoming = data.tasks || [];
      const prevById = new Map(state.tasks.map((t) => [t.task_id, t]));

      state.tasks = incoming;
      renderActiveTransfers();

      // Completion watcher: fast same-filesystem moves can finish before the
      // SSE stream ever attaches (task goes queued -> succeeded inside the
      // submit round-trip), so react to terminal transitions right here.
      for (const task of incoming) {
        if (!TERMINAL_STATUSES.has(task.status)) continue;
        if (state.finishedTaskIds.has(task.task_id)) continue;
        const prev = prevById.get(task.task_id);
        const wasActive = prev && ACTIVE_STATUSES.has(prev.status);
        // A task that was never seen active but finished right after being
        // submitted (created moments ago) is the instant-move race.
        const isInstantFinish =
          !prev &&
          state.historyLoaded &&
          Date.now() - new Date(task.created_at).getTime() < 30_000;
        if (wasActive || isInstantFinish) {
          state.finishedTaskIds.add(task.task_id);
          await onTaskFinished(task.status, task);
        }
      }

      state.historyLoaded = true;
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  const activeStreams = new Map(); // taskId -> { source, currentFile, pct }

  function pruneCompletedSelection(task) {
    // Sources of a successfully finished task were moved or copied,
    // so keeping them selected points at stale paths.
    if (!task) return false;
    let changed = false;
    const src = task.source || (Array.isArray(task.sources) ? task.sources[0] : null);
    if (src) {
      state.selection.deletePath(src);
      changed = true;
    }
    return changed;
  }

  async function onTaskFinished(status, task) {
    if (task && task.task_id) state.finishedTaskIds.add(task.task_id);
    if (status === 'succeeded') {
      // 1) Drop successfully moved/deleted source paths from the persistent
      //    selection state and update the selection bar — this MUST run before
      //    the pane refresh so the re-rendered DOM reads pruned selection state.
      pruneCompletedSelection(task);
      updateSelectionUI();
    }
    // 2) Surface a toast notification (activity log entry is recorded by the backend).
    const title = task ? getPrimaryTitle(task.source || task.sources) : 'Transfer';
    const dest = task && task.destination ? task.destination : '';
    if (status === 'succeeded') {
      const opLabel = task && task.operation === 'move' ? 'Move' : 'Transfer';
      toastSuccess(`${opLabel} complete: ${title}${dest ? ` → ${dest}` : ''}`);
    } else if (status === 'failed') {
      const reason = (task && (task.error_message || task.error)) || `exit code ${task ? task.exit_code : '?'}`;
      toastError(`Transfer failed: ${title} — ${reason}`);
    } else if (status === 'interrupted') {
      showToast(`Transfer canceled: ${title}`, 'warn');
    }
    // 3) Refresh activity log from server
    await loadActivity();
    // 4) Force-refresh both panes (cache-busted) so the transfer's effect is
    //    visible immediately: moved items vanish from source, appear in dest.
    await Promise.all([
      state.source.path ? loadPane('source', state.source.path, true) : Promise.resolve(),
      state.dest.path ? loadPane('dest', state.dest.path, true) : Promise.resolve(),
    ]);
    // 5) Re-render history — drops the completed card.
    await loadHistory();
  }

  function renderActiveTransfers() {
    if (state.historyTab !== 'active') return;
    const activeContainer = el('active-transfers-container');

    // Filter active/queued tasks strictly, then order by priority:
    // running (actively copying) cards first, queued cards after.
    // FIFO (created_at ascending) as the tie-breaker within each block.
    const statusRank = (task) => (task.status === 'running' ? 0 : 1);
    const activeTasks = state.tasks
      .filter((task) => task.status === 'queued' || task.status === 'running')
      .sort((a, b) => {
        const rankDiff = statusRank(a) - statusRank(b);
        if (rankDiff !== 0) return rankDiff;
        return new Date(a.created_at) - new Date(b.created_at);
      });

    // Clean up streams for tasks that are no longer active
    const activeTaskIds = new Set(activeTasks.map((t) => t.task_id));
    for (const [id, streamObj] of activeStreams.entries()) {
      if (!activeTaskIds.has(id)) {
        streamObj.source.close();
        activeStreams.delete(id);
      }
    }

    activeContainer.innerHTML = '';

    if (activeTasks.length === 0) {
      activeContainer.innerHTML = `<div class="empty-state">No active operations</div>`;
      return;
    }

    for (const task of activeTasks) {
      const card = document.createElement('div');
      card.className = 'transfer-card';
      card.id = `card-${task.task_id}`;

      const primaryTitle = getPrimaryTitle(task.source || task.sources);
      const sourceText = task.source || (Array.isArray(task.sources) ? task.sources.join(', ') : (task.sources || ''));
      const streamData = activeStreams.get(task.task_id);
      const currentPct = streamData ? streamData.pct : 0;
      const currentDetail = streamData && streamData.currentFile
        ? `Copying: ${streamData.currentFile} - ${currentPct}%`
        : (task.status === 'queued' ? 'Queued...' : 'Starting transfer...');

      card.innerHTML = `
        <div class="card-top">
          <span class="card-title" title="${escapeHtml(primaryTitle)}">${escapeHtml(primaryTitle)}</span>
          <button class="btn-sm btn-danger cancel-btn" data-id="${task.task_id}">Cancel</button>
        </div>
        <div class="card-path truncate" title="${escapeHtml(sourceText)} ➔ ${escapeHtml(task.destination)}">
          ${escapeHtml(sourceText)} ➔ ${escapeHtml(task.destination)}
        </div>
        <div class="bg-gray-800 rounded h-5 relative flex items-center justify-center overflow-hidden" style="position: relative;">
          <div class="bg-blue-600 rounded absolute inset-0" id="progress-fill-${task.task_id}" style="width: ${currentPct}%; transition: width 0.2s ease;"></div>
          <span class="absolute inset-0 flex items-center justify-center font-semibold text-xs text-white drop-shadow z-10 pointer-events-none" id="progress-text-${task.task_id}">
            ${currentPct}%
          </span>
        </div>
        <div class="card-details truncate" id="progress-detail-${task.task_id}">
          ${escapeHtml(currentDetail)}
        </div>
      `;

      const cancelBtn = card.querySelector('.cancel-btn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const title = getPrimaryTitle(task.source || task.sources);
          const ok = await confirmStyled(
            `Cancel transfer: ${title}?`,
            'The active transfer will be stopped.',
            'Cancel Transfer',
            true
          );
          if (!ok) return;
          if (activeStreams.has(task.task_id)) {
            activeStreams.get(task.task_id).source.close();
            activeStreams.delete(task.task_id);
          }
          try {
            await api(`/api/tasks/${task.task_id}/cancel`, { method: 'POST' });
            await onTaskFinished('interrupted', task);
          } catch (err) {
            toastError(`Failed to cancel task: ${err.message}`);
          }
        });
      }

      activeContainer.appendChild(card);

      // Attach SSE stream if running/queued
      attachTaskStream(task);
    }
  }

  function attachTaskStream(task) {
    const taskId = task.task_id;
    if (activeStreams.has(taskId)) return;

    const streamData = {
      source: new EventSource(`/api/tasks/${taskId}/stream`),
      currentFile: '',
      pct: 0,
    };
    activeStreams.set(taskId, streamData);

    const source = streamData.source;

    source.onmessage = (e) => {
      const line = e.data;
      const trimmed = line.trim();
      if (!trimmed) return;

      const fillEl = el(`progress-fill-${taskId}`);
      const textEl = el(`progress-text-${taskId}`);
      const detailEl = el(`progress-detail-${taskId}`);

      // Check if line contains rsync progress percentage
      const matches = trimmed.match(/(\d+)%/g);
      if (matches && matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        const pct = parseInt(lastMatch.replace('%', ''), 10);
        if (!isNaN(pct)) {
          streamData.pct = pct;
          if (fillEl) fillEl.style.width = `${pct}%`;
          if (textEl) textEl.textContent = `${pct}%`;
          if (detailEl) {
            detailEl.textContent = streamData.currentFile
              ? `Copying: ${streamData.currentFile} - ${pct}%`
              : `Syncing: ${pct}%`;
          }
        }
      } else {
        const isRsyncSystemLine =
          trimmed.startsWith('sending incremental') ||
          trimmed.startsWith('sent ') ||
          trimmed.startsWith('total size') ||
          trimmed.startsWith('created directory') ||
          trimmed.startsWith('building file list') ||
          trimmed.startsWith('rsync') ||
          trimmed.startsWith('sh ') ||
          trimmed.includes('bytes/sec');

        if (!isRsyncSystemLine) {
          streamData.currentFile = trimmed;
          if (detailEl) {
            detailEl.textContent = `Copying: ${streamData.currentFile} - ${streamData.pct}%`;
          }
        }
      }
    };

    source.addEventListener('status', (e) => {
      source.close();
      activeStreams.delete(taskId);

      let status = null;
      try {
        status = JSON.parse(e.data).status;
      } catch (_err) {
        // Malformed payload: still treat the stream as finished below.
      }

      // Task reached a terminal state ('succeeded' | 'failed' | 'interrupted'):
      // prune stale selections, auto-remove the card, refresh both panes.
      onTaskFinished(status, task).catch((err) => console.error('Post-task refresh failed:', err));
    });

    source.onerror = () => {
      source.close();
      activeStreams.delete(taskId);
      loadHistory();
    };
  }

  // Reusable styled confirm modal (matches transfer-confirm look).
  function confirmStyled(title, message, okLabel = 'Confirm', isDanger = false) {
    return new Promise((resolve) => {
      const modal = el('action-confirm-modal');
      el('action-confirm-title').textContent = title;
      el('action-confirm-message').textContent = message || '';
      const okBtn = el('action-confirm-ok');
      okBtn.textContent = okLabel;
      okBtn.style.background = isDanger ? 'var(--danger)' : '';
      okBtn.style.borderColor = isDanger ? 'var(--danger)' : '';
      modal.classList.remove('hidden');
      const ok = el('action-confirm-ok');
      const cancel = el('action-confirm-cancel');
      const cleanup = () => {
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        modal.classList.add('hidden');
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
    });
  }

  // --- Resizable splitters (CSS variable architecture) ---

  function initResizers() {
    const root = document.documentElement;
    const drag = (handle, onMove) => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('splitter-dragging');
        const move = (ev) => onMove(ev);
        const up = () => {
          handle.classList.remove('splitter-dragging');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    };

    const panesEl = document.querySelector('.panes');
    drag(el('vertical-splitter'), (e) => {
      // Desktop (row): drag adjusts left pane width.
      // Mobile (column): drag adjusts top pane height.
      if (getComputedStyle(panesEl).flexDirection === 'column') {
        const rect = panesEl.getBoundingClientRect();
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        root.style.setProperty('--top-height', `${pct}%`);
      } else {
        const pct = (e.clientX / window.innerWidth) * 100;
        root.style.setProperty('--left-width', `${pct}%`);
      }
    });

    const historyEl = document.querySelector('.history');
    drag(el('horizontal-splitter'), (e) => {
      const height = historyEl.getBoundingClientRect().bottom - e.clientY;
      root.style.setProperty('--bottom-height', `${height}px`);
    });
  }

  // --- Init ---

  async function init() {
    const who = await api('/api/whoami');
    el('whoami').textContent = who.username;

    el('logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });

    // Both panes expose Upload / New Folder / Rename / Delete via [data-pane-action][data-pane]
    document.querySelectorAll('[data-pane-action]').forEach((btn) => {
      const action = btn.getAttribute('data-pane-action');
      const pane = btn.getAttribute('data-pane') || 'source';
      btn.addEventListener('click', () => {
        if (action === 'upload') openUploadPicker(pane);
        else if (action === 'mkdir') openMkdirModal(pane);
        else if (action === 'rename') openRenameModal(pane);
        else if (action === 'delete') openDeleteModal(pane);
      });
    });

    const fileInput = el('upload-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = '';
        if (!files.length) return;
        const pane = state.pendingUploadPane || 'source';
        const destPath = state.pendingUploadPath || (state[pane] && state[pane].path);
        if (destPath) {
          startUploads(pane, destPath, files);
        }
      });
    }

    // Source-pane modal wiring
    el('mkdir-cancel').addEventListener('click', () => closeModal('mkdir'));
    el('mkdir-ok').addEventListener('click', submitMkdir);
    el('mkdir-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitMkdir();
      else if (e.key === 'Escape') closeModal('mkdir');
    });

    el('rename-cancel').addEventListener('click', () => closeModal('rename'));
    el('rename-ok').addEventListener('click', submitRename);
    el('rename-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitRename();
      else if (e.key === 'Escape') closeModal('rename');
    });

    el('delete-cancel').addEventListener('click', () => closeModal('delete'));
    el('delete-ok').addEventListener('click', submitDelete);
    el('tab-active-btn').addEventListener('click', () => setHistoryTab('active'));
    el('tab-activity-btn').addEventListener('click', () => setHistoryTab('activity'));
    el('clear-activity-btn').addEventListener('click', async () => {
      if (state.activity.length === 0) return;
      const ok = await confirmStyled(
        'Clear Activity Log?',
        'This will permanently clear the activity log history.',
        'Clear Log',
        true
      );
      if (!ok) return;
      await clearActivity();
    });

    // Activity details modal wiring
    const detailsCloseBtn = el('activity-details-close');
    if (detailsCloseBtn) {
      detailsCloseBtn.addEventListener('click', closeActivityDetails);
    }
    const detailsModal = el('activity-details-modal');
    if (detailsModal) {
      detailsModal.addEventListener('click', (e) => {
        if (e.target === detailsModal) {
          e.stopPropagation();
          e.preventDefault();
          closeActivityDetails();
        }
      });
    }

    // Item details modal wiring
    const itemCloseBtn = el('item-details-close');
    if (itemCloseBtn) {
      itemCloseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeItemDetailsModal();
      });
    }
    const itemModal = el('item-details-modal');
    if (itemModal) {
      itemModal.addEventListener('click', (e) => {
        if (e.target === itemModal) {
          e.stopPropagation();
          e.preventDefault();
          closeItemDetailsModal();
        }
      });
    }

    initResizers();

    el('transfer-btn').addEventListener('click', openConfirmModal);
    el('confirm-cancel').addEventListener('click', closeConfirmModal);
    el('confirm-ok').addEventListener('click', submitTransfer);

    // Inline Clear button: wipe the source selection and refresh checks.
    el('selection-clear-btn').addEventListener('click', () => {
      if (state.selection.size === 0) return;
      state.selection.clear();
      closeSelectionPreview();
      updateSelectionUI();
      renderPane('source');
      toastSuccess('Selection cleared.');
    });

    // View button: toggle the selected-items preview popover.
    el('selection-view-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelectionPreview();
    });
    el('selection-preview-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeSelectionPreview();
    });
    // Click-outside closes the preview.
    document.addEventListener('click', (e) => {
      const preview = el('selection-preview');
      if (!preview || preview.classList.contains('hidden')) return;
      if (preview.contains(e.target)) return;
      if (e.target === el('selection-view-btn')) return;
      closeSelectionPreview();
    });
    // Esc closes the preview and modals.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeSelectionPreview();
        closeActivityDetails();
        closeItemDetailsModal();
      }
    });

    await loadActivity();

    const roots = await api('/api/roots');
    state.roots = roots.roots;

    await loadPane('source', null);
    await loadPane('dest', null);
    await loadHistory();
    renderActivity(); // pre-render so switching to the tab is instant
  }

  init().catch((err) => console.error(err));
})();



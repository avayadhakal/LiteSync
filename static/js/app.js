(() => {
  const state = {
    roots: [],
    source: { path: null, entries: [] },
    dest: { path: null, entries: [] },
    selection: new Set(),     // absolute paths selected in the SOURCE pane  (drives Transfer)
    destSelection: new Set(), // absolute paths selected in the DEST pane   (mkdir/rename/delete target)
    historyTab: 'active', // 'active' | 'activity'
    tasks: [],
    activeTaskId: null,
    finishedTaskIds: new Set(), // task ids whose completion was already handled
    historyLoaded: false,
    activity: [], // [{ts, kind, message, source}] newest-first
  };

  const ACTIVITY_STORAGE_KEY = 'litesync_activity_log';
  const ACTIVITY_MAX_ENTRIES = 200;

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

  // --- Pane rendering ---

  function normalizePath(p) {
    return String(p || '').replace(/\/+/g, '/').replace(/\/+$/g, '') || '/';
  }

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
    // Selections persist across navigation: the Set is keyed by absolute path,
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

  // Returns true if path is directly in selSet or if any ancestor directory is in selSet.
  function isPathSelected(path, selSet) {
    if (!path || !selSet || selSet.size === 0) return false;
    const norm = normalizePath(path);
    for (const selPath of selSet) {
      if (typeof selPath !== 'string') continue;
      const normSel = normalizePath(selPath);
      if (norm === normSel) return true;
      if (normSel === '/') {
        if (norm !== '/') return true;
      } else if (norm.startsWith(normSel + '/')) {
        return true;
      }
    }
    return false;
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
      cb.checked = isPathSelected(entry.path, sel);
      // Directory tri-state: fully checked when the dir itself (or ancestor) is selected,
      // indeterminate when only some descendant path is selected.
      if (entry.is_dir && !cb.checked) {
        cb.indeterminate = hasSelectedDescendant(entry.path, sel);
      }
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        const normEntry = normalizePath(entry.path);
        if (cb.checked) {
          sel.add(entry.path);
          // When checking a directory, remove explicit descendant selections
          // since the parent directory covers all descendants hierarchically.
          if (entry.is_dir) {
            const prefix = normEntry + '/';
            for (const p of Array.from(sel)) {
              if (normalizePath(p).startsWith(prefix)) {
                sel.delete(p);
              }
            }
          }
        } else {
          // Remove direct match from selection set
          for (const p of Array.from(sel)) {
            if (normalizePath(p) === normEntry) {
              sel.delete(p);
            }
          }

          // Check if item was checked via ancestor inheritance
          const ancestorsToRemove = [];
          for (const selPath of sel) {
            const normSel = normalizePath(selPath);
            if (normSel === '/' && normEntry !== '/') {
              ancestorsToRemove.push(selPath);
            } else if (normSel !== '/' && normEntry.startsWith(normSel + '/')) {
              ancestorsToRemove.push(selPath);
            }
          }

          // If checked via parent inheritance: remove parent from selection set
          // and explicitly add all other sibling items in that folder.
          if (ancestorsToRemove.length > 0) {
            for (const a of ancestorsToRemove) {
              sel.delete(a);
            }
            for (const sibling of pane.entries) {
              if (normalizePath(sibling.path) !== normEntry) {
                sel.add(sibling.path);
              }
            }
          }

          // If unchecking a directory, also remove any descendant paths
          if (entry.is_dir) {
            const prefix = normEntry + '/';
            for (const p of Array.from(sel)) {
              if (normalizePath(p).startsWith(prefix)) {
                sel.delete(p);
              }
            }
          }
        }
        renderPane(which);
        updateSelectionUI();
      });
      row.appendChild(cb);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
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
          try {
            const data = await api(`/api/download/link?path=${encodeURIComponent(entry.path)}`);
            const fullUrl = new URL(data.url, window.location.origin).href;
            await copyToClipboard(fullUrl);
            copyBtn.innerHTML = '✓';
            copyBtn.style.color = 'var(--success)';
            toastSuccess('Download link copied');
            setTimeout(() => {
              copyBtn.innerHTML = '📋';
              copyBtn.style.color = '';
            }, 1500);
          } catch (err) {
            toastError(err.message || 'Failed to copy link');
          }
        });
        row.appendChild(copyBtn);
      }

      row.title = entry.path;

      if (window.matchMedia('(hover: none)').matches) {
        let touchTimer = null;
        row.addEventListener('touchstart', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.closest('.btn-copy-path')) return;
          touchTimer = setTimeout(() => {
            showToast(entry.path, 'info');
          }, 500);
        }, { passive: true });
        const clearTouch = () => { if (touchTimer) clearTimeout(touchTimer); };
        row.addEventListener('touchend', clearTouch, { passive: true });
        row.addEventListener('touchmove', clearTouch, { passive: true });
        row.addEventListener('touchcancel', clearTouch, { passive: true });
      }

      if (entry.is_dir) {
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.closest('.btn-copy-path')) return;
          loadPane(which, entry.path);
        });
      }

      body.appendChild(row);
    }
    body.scrollTop = prevScrollTop;
  }

  function selectionSummary(selSet) {
    return Array.from(selSet).map((p) => normalizePath(p).split('/').pop() || p);
  }

  // True when any selected path is a descendant of dirPath (but not dirPath itself).
  function hasSelectedDescendant(dirPath, selSet) {
    if (!dirPath || !selSet || selSet.size === 0) return false;
    const prefix = normalizePath(dirPath) + '/';
    for (const p of selSet) {
      if (typeof p === 'string' && normalizePath(p).startsWith(prefix)) return true;
    }
    return false;
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
    // Full paths (normalized) so identically-named items from different
    // locations are distinguishable; basename fallback guards odd inputs.
    const paths = Array.from(state.selection).map((p) => {
      const norm = normalizePath(p);
      return typeof norm === 'string' && norm ? norm : String(p);
    });
    countEl.textContent = `${paths.length} selected`;
    list.innerHTML = '';
    for (const path of paths) {
      const li = document.createElement('li');
      li.textContent = path;
      li.title = path; // full path on hover when the row is ellipsized
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

  // --- Activity log (file mutations + transfer lifecycle) ---

  function loadActivity() {
    try {
      const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY);
      state.activity = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.activity)) state.activity = [];
    } catch (_err) {
      state.activity = [];
    }
  }

  function saveActivity() {
    try {
      localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(state.activity));
    } catch (_err) { /* quota or private mode — ignore */ }
  }

  // kind: 'mkdir' | 'rename' | 'delete' | 'transfer' | ...
  // source: optional path(s) context
  function logActivity(kind, message, level = 'info') {
    state.activity.unshift({
      ts: Date.now(),
      kind,
      level, // 'success' | 'error' | 'info'
      message: String(message),
    });
    if (state.activity.length > ACTIVITY_MAX_ENTRIES) {
      state.activity.length = ACTIVITY_MAX_ENTRIES;
    }
    saveActivity();
    if (state.historyTab === 'activity') renderActivity();
    // Update clear-activity button visibility regardless of current tab.
    const clearBtn = el('clear-activity-btn');
    if (clearBtn && state.historyTab === 'activity') {
      clearBtn.classList.toggle('hidden', state.activity.length === 0);
    }
  }

  function clearActivity() {
    state.activity = [];
    saveActivity();
    renderActivity();
  }

  function formatActivityTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function renderActivity() {
    const container = el('activity-container');
    if (!container) return;
    container.innerHTML = '';
    if (state.activity.length === 0) {
      container.innerHTML = `<div class="empty-state">No activity yet</div>`;
      return;
    }
    for (const entry of state.activity) {
      const item = document.createElement('div');
      item.className = `activity-item activity-${entry.level}`;
      const time = document.createElement('span');
      time.className = 'activity-time';
      time.textContent = formatActivityTime(entry.ts);
      const msg = document.createElement('span');
      msg.className = 'activity-message';
      msg.textContent = `[${entry.kind}] ${entry.message}`;
      item.appendChild(time);
      item.appendChild(msg);
      container.appendChild(item);
    }
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
      logActivity('mkdir', `Created folder ${name} in ${state[which].path}`, 'success');
    } catch (err) {
      setModalError('mkdir', err.message);
    }
  }

  function openRenameModal(which) {
    const sel = paneSelection(which);
    if (sel.size !== 1) {
      toastError('Select exactly one item to rename.');
      return;
    }
    const selectedPath = Array.from(sel)[0];
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
      sel.delete(selectedPath);
      sel.add(result.new_path);
      updateSelectionUI();
      await loadPane(which, state[which].path, true);
      toastSuccess(`Renamed to: ${name}`);
      logActivity('rename', `Renamed ${selectedPath} → ${result.new_path}`, 'success');
    } catch (err) {
      setModalError('rename', err.message);
      logActivity('rename', `Failed to rename ${selectedPath}: ${err.message}`, 'error');
    }
  }

  function openDeleteModal(which) {
    const sel = paneSelection(which);
    if (sel.size === 0) {
      toastError('Select one or more items to delete.');
      return;
    }
    // Snapshot selection at open time so submitDelete doesn't depend on live state.
    el('delete-modal').dataset.pane = which;
    const paths = Array.from(sel);
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
    const paths = Array.from(sel);
    if (paths.length === 0) { closeModal('delete'); return; }
    closeModal('delete');
    const failures = [];
    for (const p of paths) {
      try {
        await api('/api/delete', {
          method: 'POST',
          body: JSON.stringify({ path: p }),
        });
        sel.delete(p);
      } catch (err) {
        failures.push(`${normalizePath(p).split('/').pop()}: ${err.message}`);
      }
    }
    updateSelectionUI();
    await loadPane(which, state[which].path, true);

    if (failures.length === 0) {
      toastSuccess(paths.length === 1 ? 'Deleted.' : `Deleted ${paths.length} items.`);
      logActivity(
        'delete',
        paths.length === 1
          ? `Deleted ${paths[0]}`
          : `Deleted ${paths.length} items (${paths.map((p) => normalizePath(p).split('/').pop()).join(', ')})`,
        'success'
      );
    } else {
      toastError(`Some items could not be deleted: ${failures.join('; ')}`);
      logActivity('delete', `Delete failures: ${failures.join('; ')}`, 'error');
    }
  }

  // --- Transfer flow ---

  function openConfirmModal() {
    const list = el('confirm-list');
    list.innerHTML = '';
    for (const path of state.selection) {
      const li = document.createElement('li');
      li.textContent = path;
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
    const body = {
      sources: Array.from(state.selection),
      destination: state.dest.path,
      operation: operation,
    };
    let result;
    try {
      result = await api('/api/transfer', { method: 'POST', body: JSON.stringify(body) });
    } catch (err) {
      toastError(`Transfer failed to start: ${err.message}`);
      logActivity('transfer', `Failed to start transfer: ${err.message}`, 'error');
      return;
    }
    const itemCount = Array.isArray(result.task_ids) ? result.task_ids.length : body.sources.length;
    const opLabel = operation === 'move' ? 'move' : 'copy';
    toastSuccess(`Queued ${itemCount} ${opLabel}${itemCount === 1 ? '' : 's'} → ${body.destination}`);
    logActivity(
      'transfer',
      `Queued ${itemCount} ${opLabel}${itemCount === 1 ? '' : 's'} (${body.sources.map((p) => normalizePath(p).split('/').pop()).join(', ')}) → ${body.destination}`,
      'info'
    );
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

  function setHistoryTab(tab) {
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
      renderActivity();
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
    // Normalize both sides (task sources may carry trailing slashes that
    // pane-entry paths never have) before comparing against selection keys.
    if (!task || !Array.isArray(task.sources)) return false;
    let changed = false;
    for (const src of task.sources) {
      const normalized = normalizePath(src);
      for (const key of state.selection) {
        if (normalizePath(key) === normalized) {
          state.selection.delete(key);
          changed = true;
        }
      }
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
    // 2) Surface a toast + activity log entry mirroring mkdir/rename/delete.
    const title = task ? getPrimaryTitle(task.sources) : 'Transfer';
    const dest = task && task.destination ? task.destination : '';
    if (status === 'succeeded') {
      const opLabel = task && task.operation === 'move' ? 'Move' : 'Transfer';
      toastSuccess(`${opLabel} complete: ${title}${dest ? ` → ${dest}` : ''}`);
      logActivity(
        'transfer',
        `Transfer succeeded: ${(task && task.sources ? [].concat(task.sources).join(', ') : title)}${dest ? ` → ${dest}` : ''}`,
        'success'
      );
    } else if (status === 'failed') {
      const reason = (task && (task.error_message || task.error)) || `exit code ${task ? task.exit_code : '?'}`;
      toastError(`Transfer failed: ${title} — ${reason}`);
      logActivity('transfer', `Transfer failed: ${title} — ${reason}`, 'error');
    } else if (status === 'interrupted') {
      showToast(`Transfer canceled: ${title}`, 'warn');
      logActivity('transfer', `Transfer canceled: ${title}${dest ? ` → ${dest}` : ''}`, 'info');
    }
    // 3) Force-refresh both panes (cache-busted) so the transfer's effect is
    //    visible immediately: moved items vanish from source, appear in dest.
    await Promise.all([
      state.source.path ? loadPane('source', state.source.path, true) : Promise.resolve(),
      state.dest.path ? loadPane('dest', state.dest.path, true) : Promise.resolve(),
    ]);
    // 4) Re-render history — drops the completed card.
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

      const primaryTitle = getPrimaryTitle(task.sources);
      const sourcesText = Array.isArray(task.sources) ? task.sources.join(', ') : task.sources;
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
        <div class="card-path truncate" title="${escapeHtml(sourcesText)} ➔ ${escapeHtml(task.destination)}">
          ${escapeHtml(sourcesText)} ➔ ${escapeHtml(task.destination)}
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
          const title = getPrimaryTitle(task.sources);
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

    // Both panes expose New Folder / Rename / Delete via [data-pane-action][data-pane]
    document.querySelectorAll('[data-pane-action]').forEach((btn) => {
      const action = btn.getAttribute('data-pane-action');
      const pane = btn.getAttribute('data-pane') || 'source';
      btn.addEventListener('click', () => {
        if (action === 'mkdir') openMkdirModal(pane);
        else if (action === 'rename') openRenameModal(pane);
        else if (action === 'delete') openDeleteModal(pane);
      });
    });

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
    el('clear-activity-btn').addEventListener('click', () => {
      if (state.activity.length === 0) return;
      clearActivity();
      toastSuccess('Activity log cleared.');
    });

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
    // Esc closes the preview.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSelectionPreview();
    });

    loadActivity();

    const roots = await api('/api/roots');
    state.roots = roots.roots;

    await loadPane('source', null);
    await loadPane('dest', null);
    await loadHistory();
    renderActivity(); // pre-render so switching to the tab is instant
  }

  init().catch((err) => console.error(err));
})();



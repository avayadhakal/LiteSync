(() => {
  const state = {
    roots: [],
    source: { path: null, entries: [] },
    dest: { path: null, entries: [] },
    selection: new Set(), // absolute paths selected in the source pane
    historyTab: 'active', // 'active' | 'history'
    tasks: [],
    activeTaskId: null,
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

  // --- Pane rendering ---

  async function loadPane(which, path) {
    const pane = state[which];
    if (path === null) {
      pane.path = null;
      pane.entries = state.roots.map((r) => ({ name: r, path: r, is_dir: true, size: 0 }));
      pane.parent = undefined;
    } else {
      const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
      pane.path = data.path;
      pane.entries = data.entries;
      pane.parent = data.parent;
    }
    if (which === 'source') {
      state.selection.clear();
    }
    renderPane(which);
    updateSelectionUI();
  }

  function renderPane(which) {
    const pane = state[which];
    el(`${which}-path`).textContent = pane.path === null ? '(select a root)' : pane.path;
    const body = el(`${which}-body`);
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

      if (which === 'source') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.selection.has(entry.path);
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          if (cb.checked) state.selection.add(entry.path);
          else state.selection.delete(entry.path);
          updateSelectionUI();
        });
        row.appendChild(cb);
      }

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
      row.appendChild(name);

      if (!entry.is_dir) {
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = formatSize(entry.size);
        row.appendChild(size);
      }

      if (entry.is_dir) {
        row.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          loadPane(which, entry.path);
        });
      }

      body.appendChild(row);
    }
  }

  function updateSelectionUI() {
    const count = state.selection.size;
    el('selection-count').textContent = count > 0 ? `${count} selected` : '';
    el('transfer-btn').disabled = !(count > 0 && state.dest.path);
  }

  async function handleNewFolder() {
    if (!state.dest.path) {
      alert('Please select a destination folder first.');
      return;
    }
    const folderName = prompt('Enter new folder name:');
    if (!folderName || !folderName.trim()) return;

    try {
      await api('/api/mkdir', {
        method: 'POST',
        body: JSON.stringify({
          path: state.dest.path,
          name: folderName.trim(),
        }),
      });
      await loadPane('dest', state.dest.path);
    } catch (err) {
      alert(`Failed to create folder: ${err.message}`);
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
    el('confirm-modal').classList.remove('hidden');
  }

  function closeConfirmModal() {
    el('confirm-modal').classList.add('hidden');
  }

  async function submitTransfer() {
    closeConfirmModal();
    const body = {
      sources: Array.from(state.selection),
      destination: state.dest.path,
      delete_source: el('delete-checkbox').checked,
    };
    let result;
    try {
      result = await api('/api/transfer', { method: 'POST', body: JSON.stringify(body) });
    } catch (err) {
      alert(`Transfer failed to start: ${err.message}`);
      return;
    }
    state.selection.clear();
    updateSelectionUI();
    setHistoryTab('active');
    // Auto-refresh destination pane on start
    if (state.dest.path) {
      await loadPane('dest', state.dest.path);
    }
    await loadHistory();
  }

  // --- History / log streaming ---

  function statusBadge(status) {
    return `<span class="badge ${status}">${status}</span>`;
  }

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
    if (tab === 'active') {
      el('tab-active-btn').classList.add('active');
      el('tab-history-btn').classList.remove('active');
      el('clear-history-btn').classList.add('hidden');
    } else {
      el('tab-history-btn').classList.add('active');
      el('tab-active-btn').classList.remove('active');
    }
    renderHistoryTable();
  }

  async function loadHistory() {
    try {
      const data = await api('/api/tasks?limit=100');
      state.tasks = data.tasks || [];
      renderHistoryTable();
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  const activeStreams = new Map(); // taskId -> { source, currentFile, pct }

  function renderHistoryTable() {
    const isHistoryTab = state.historyTab === 'history';
    const activeContainer = el('active-transfers-container');
    const historyTable = el('history-table');

    if (isHistoryTab) {
      activeContainer.classList.add('hidden');
      historyTable.classList.remove('hidden');

      // Filter completed/historical tasks strictly
      const historyTasks = state.tasks.filter(
        (task) => task.status === 'succeeded' || task.status === 'failed' || task.status === 'interrupted'
      );

      if (historyTasks.length > 0) {
        el('clear-history-btn').classList.remove('hidden');
      } else {
        el('clear-history-btn').classList.add('hidden');
      }

      const body = el('history-body');
      body.innerHTML = '';

      if (historyTasks.length === 0) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `<td colspan="5" style="color: var(--text-dim); text-align: center; padding: 12px;">No historical transfers</td>`;
        body.appendChild(emptyRow);
        return;
      }

      for (const task of historyTasks) {
        const row = document.createElement('tr');
        row.className = 'task-row';
        const sourcesText = escapeHtml(
          Array.isArray(task.sources) ? task.sources.join(', ') : task.sources
        );
        const timeStr = task.started_at
          ? new Date(task.started_at).toLocaleString()
          : task.created_at
          ? new Date(task.created_at).toLocaleString()
          : '-';

        row.innerHTML = `
          <td>${timeStr}</td>
          <td title="${sourcesText}">${sourcesText}</td>
          <td>${escapeHtml(task.destination)}</td>
          <td>${statusBadge(task.status)}</td>
          <td style="text-align: right;">
            <button class="icon-btn danger delete-btn" title="Delete record" data-id="${task.task_id}">🗑️</button>
          </td>
        `;

        const deleteBtn = row.querySelector('.delete-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await api(`/api/tasks/${task.task_id}`, { method: 'DELETE' });
              await loadHistory();
            } catch (err) {
              alert(`Failed to delete task: ${err.message}`);
            }
          });
        }

        body.appendChild(row);
      }
    } else {
      // Active transfers tab
      historyTable.classList.add('hidden');
      activeContainer.classList.remove('hidden');
      el('clear-history-btn').classList.add('hidden');

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
        activeContainer.innerHTML = `<div style="color: var(--text-dim); text-align: center; padding: 16px;">No active transfers</div>`;
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
            if (!confirm('Are you sure you want to cancel this transfer? Incomplete files will be deleted.')) {
              return;
            }
            if (activeStreams.has(task.task_id)) {
              activeStreams.get(task.task_id).source.close();
              activeStreams.delete(task.task_id);
            }
            try {
              await api(`/api/tasks/${task.task_id}/cancel`, { method: 'POST' });
              await loadHistory();
              if (state.source.path) await loadPane('source', state.source.path);
              if (state.dest.path) await loadPane('dest', state.dest.path);
            } catch (err) {
              alert(`Failed to cancel task: ${err.message}`);
            }
          });
        }

        activeContainer.appendChild(card);

        // Attach SSE stream if running/queued
        attachTaskStream(task.task_id);
      }
    }
  }

  function attachTaskStream(taskId) {
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

      // Auto-remove card, auto-refresh panes, and refresh history
      if (state.source.path) {
        loadPane('source', state.source.path);
      }
      if (state.dest.path) {
        loadPane('dest', state.dest.path);
      }
      loadHistory();
    });

    source.onerror = () => {
      source.close();
      activeStreams.delete(taskId);
      loadHistory();
    };
  }

  async function handleClearAllHistory() {
    if (!confirm('Are you sure you want to delete all transfer history?')) return;
    try {
      await api('/api/tasks', { method: 'DELETE' });
      await loadHistory();
    } catch (err) {
      alert(`Failed to clear history: ${err.message}`);
    }
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
        root.style.setProperty('--top-height', `${Math.min(80, Math.max(20, pct))}%`);
      } else {
        const pct = (e.clientX / window.innerWidth) * 100;
        root.style.setProperty('--left-width', `${Math.min(80, Math.max(20, pct))}%`);
      }
    });

    const historyEl = document.querySelector('.history');
    drag(el('horizontal-splitter'), (e) => {
      const height = historyEl.getBoundingClientRect().bottom - e.clientY;
      const max = window.innerHeight * 0.7;
      root.style.setProperty('--bottom-height', `${Math.min(max, Math.max(120, height))}px`);
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

    el('new-folder-btn').addEventListener('click', handleNewFolder);
    el('tab-active-btn').addEventListener('click', () => setHistoryTab('active'));
    el('tab-history-btn').addEventListener('click', () => setHistoryTab('history'));
    el('clear-history-btn').addEventListener('click', handleClearAllHistory);

    initResizers();

    el('transfer-btn').addEventListener('click', openConfirmModal);
    el('confirm-cancel').addEventListener('click', closeConfirmModal);
    el('confirm-ok').addEventListener('click', submitTransfer);

    const roots = await api('/api/roots');
    state.roots = roots.roots;

    await loadPane('source', null);
    await loadPane('dest', null);
    await loadHistory();
  }

  init().catch((err) => console.error(err));
})();



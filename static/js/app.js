(() => {
  const state = {
    roots: [],
    source: { path: null, entries: [] },
    dest: { path: null, entries: [] },
    selection: new Set(), // absolute paths selected in the source pane
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
    // Also escapes quotes, since callers interpolate this into attribute
    // values (e.g. title="...") as well as text content.
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
    await loadHistory();
    streamTask(result.task_id);
  }

  // --- History / log streaming ---

  function statusBadge(status) {
    return `<span class="badge ${status}">${status}</span>`;
  }

  async function loadHistory() {
    const data = await api('/api/tasks?limit=50');
    const body = el('history-body');
    body.innerHTML = '';
    for (const task of data.tasks) {
      const row = document.createElement('tr');
      row.className = 'task-row';
      const sourcesText = escapeHtml(
        Array.isArray(task.sources) ? task.sources.join(', ') : task.sources
      );
      row.innerHTML = `
        <td>${task.started_at ? new Date(task.started_at).toLocaleString() : '-'}</td>
        <td title="${sourcesText}">${sourcesText}</td>
        <td>${escapeHtml(task.destination)}</td>
        <td>${statusBadge(task.status)}</td>
      `;
      row.addEventListener('click', () => streamTask(task.task_id));
      body.appendChild(row);
    }
  }

  let activeSource = null;

  function streamTask(taskId) {
    if (activeSource) activeSource.close();
    const logView = el('log-view');
    logView.classList.remove('hidden');
    logView.textContent = '';

    const source = new EventSource(`/api/tasks/${taskId}/stream`);
    activeSource = source;
    source.onmessage = (e) => {
      logView.textContent += e.data + '\n';
      logView.scrollTop = logView.scrollHeight;
    };
    source.addEventListener('status', () => {
      source.close();
      if (activeSource === source) activeSource = null;
      loadHistory();
    });
    source.onerror = () => {
      source.close();
      if (activeSource === source) activeSource = null;
    };
  }

  // --- Init ---

  async function init() {
    const who = await api('/api/whoami');
    el('whoami').textContent = who.username;

    el('logout-btn').addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });

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

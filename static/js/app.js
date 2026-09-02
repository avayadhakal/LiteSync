import { el, normalizePath } from './utils.js';
import { api, toastSuccess, toastError, showToast } from './api.js';
import { state } from './state.js';
import { loadPane, renderPane, paneSelection, updateSelectionUI, closeSelectionPreview, toggleSelectionPreview } from './panes.js';
import { loadActivity, clearActivity, filterActivity, closeActivityDetails, renderActivity } from './activity.js';
import { renderActiveTransfers, TERMINAL_STATUSES, ACTIVE_STATUSES, pruneCompletedSelection } from './tasks-ui.js';
import { openMkdirModal, openRenameModal, openDeleteModal, setModalError } from './modals/mkdir-rename-delete.js';
import { openUploadPicker, startUploads } from './uploads.js';
import { updateTransferMethodUI, getPrimaryTitle, closeConfirmModal, showConflictModal } from './modals/transfer.js';
import { closeItemDetailsModal } from './modals/item-details.js';













// --- Pane rendering ---


// Per-pane selection accessor. The source pane drives Transfer submissions;
// the dest pane supports the same file operations via its own selection.







// --- Toast notifications (top-right stack) ---

// kind: 'success' | 'error' | 'info' | 'warn'. Returns the element so callers
// can dismiss it early if needed.

// Back-compat convenience wrapper for boolean isError callers.

// --- Activity log (Authoritative SQLite persistence via /api/activity) ---










// --- Source pane actions: New Folder / Rename / Delete ---
// Each uses a dedicated popup that matches the transfer-confirm modal style.


export   function openModal(which) {
  el(`${which}-modal`).classList.remove('hidden');
  requestAnimationFrame(() => {
    const input = el(`${which}-input`);
    if (input) { input.focus(); input.select(); }
  });
}

export   function closeModal(which) {
  el(`${which}-modal`).classList.add('hidden');
  setModalError(which, '');
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
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
    await loadPane(which, state[which].path, true);
    toastSuccess(`Renamed to: ${name}`);
    await loadActivity();
  } catch (err) {
    setModalError('rename', err.message);
  }
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
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
  await loadPane(which, state[which].path, true);

  if (failures.length === 0) {
    toastSuccess(paths.length === 1 ? 'Deleted.' : `Deleted ${paths.length} items.`);
  } else {
    toastError(`Some items could not be deleted: ${failures.join('; ')}`);
  }
  await loadActivity();
}

// --- Browser File Upload (Multipart streaming straight to disk) ---



// --- Transfer flow ---

export async function openConfirmModal() {
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
  
  if (state.singlePane) {
    el('transfer-static-dest-view').classList.add('hidden');
    el('transfer-picker-container').classList.remove('hidden');
    el('transfer-options-field').classList.remove('hidden');
    
    let targetPath = localStorage.getItem('litesync-last-destination');
    if (!targetPath) targetPath = null;
    await loadPane('pickerDest', targetPath, false, false);
    el('confirm-ok').disabled = state.pickerDest.path === null;
  } else {
    el('transfer-static-dest-view').classList.remove('hidden');
    el('transfer-picker-container').classList.add('hidden');
    el('transfer-options-field').classList.remove('hidden');
    el('transfer-change-dest-btn').classList.add('hidden');
    const confirmDest = el('confirm-dest');
    confirmDest.textContent = state.dest.path || '(select a destination)';
    confirmDest.title = state.dest.path || '';
    el('confirm-ok').disabled = state.dest.path === null;
  }


  const copyRadio = document.querySelector('input[name="transfer-op"][value="copy"]');
  if (copyRadio) copyRadio.checked = true;
  
  el('transfer-rsync-toggle').checked = true;
  updateTransferMethodUI();

  el('confirm-modal').classList.remove('hidden');
  const btnSingle = el('btn-single-pane');
  const btnDual = el('btn-dual-pane');
  if (btnSingle) btnSingle.disabled = true;
  if (btnDual) btnDual.disabled = true;
}






async function submitTransfer(resolvedConflictChoice = null) {
  if (resolvedConflictChoice === null && arguments.length === 0) {
    resolvedConflictChoice = null; // explicit
  } else if (resolvedConflictChoice instanceof Event) {
    resolvedConflictChoice = null; // event object from click
  }
  closeConfirmModal();
  const opRadio = document.querySelector('input[name="transfer-op"]:checked');
  const operation = opRadio ? opRadio.value : 'copy';
  
  if (state.singlePane && state.pickerDest.path) {
    state.dest.path = state.pickerDest.path;
    localStorage.setItem('litesync-last-destination', state.dest.path);
  }
  
  const sources = state.selection.toTransferSources();

  if (!resolvedConflictChoice) {
    try {
      const targetPath = state.dest.path;
      if (targetPath) {
        const data = await api(`/api/browse?path=${encodeURIComponent(targetPath)}`);
        const existingNames = new Set(data.entries.map(e => e.name));
        const sourceNames = sources.map(item => {
          const p = typeof item === 'string' ? item : item.path;
          return p.replace(/\/+$/, '').split('/').pop();
        });
        
        const conflicts = sourceNames.filter(name => existingNames.has(name));
        if (conflicts.length > 0) {
          showConflictModal(conflicts, (choice) => {
            if (choice) {
              submitTransfer(choice);
            }
          });
          return;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  const toggle = el('transfer-rsync-toggle');
  const use_rsync = toggle ? toggle.checked : false;

  const body = {
    sources: sources,
    destination: state.dest.path,
    operation: operation,
    use_rsync: use_rsync,
    on_conflict: resolvedConflictChoice || 'skip'
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
  
  el('transfer-rsync-toggle').checked = true;
  updateTransferMethodUI();

  updateSelectionUI();
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
  renderPane('source');
  setHistoryTab('active');
  // Auto-refresh destination pane on start
  if (state.dest.path) {
    await loadPane('dest', state.dest.path);
  }
  await loadHistory();
}

// --- Transfer progress streaming ---


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

  const utils = el('activity-utils');
  if (utils) {
    utils.classList.toggle('hidden', !isActivityTab);
  }

  if (isActiveTab) {
    renderActiveTransfers();
  } else if (isActivityTab) {
    await loadActivity();
  }
}


export async function loadHistory() {
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


export async function onTaskFinished(status, task) {
  if (task && task.task_id) state.finishedTaskIds.add(task.task_id);
  if (status === 'succeeded') {
    // 1) Drop successfully moved/deleted source paths from the persistent
    //    selection state and update the selection bar — this MUST run before
    //    the pane refresh so the re-rendered DOM reads pruned selection state.
    pruneCompletedSelection(task);
    updateSelectionUI();
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
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



// Reusable styled confirm modal (matches transfer-confirm look).
export   function confirmStyled(title, message, okLabel = 'Confirm', isDanger = false) {
  return new Promise((resolve) => {
    const modal = el('action-confirm-modal');
    const titleEl = el('action-confirm-title');
    titleEl.textContent = title;
    titleEl.title = title;
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

export   function initResizers() {
  const root = document.documentElement;
  const clamp = (val, min, max) => Math.min(Math.max(val, min), max);

  // Initialize from LocalStorage or Defaults
  try {
    const dualRatio = parseFloat(localStorage.getItem('litesync_dual_pane_ratio')) || 50;
    const bottomRatio = parseFloat(localStorage.getItem('litesync_bottom_pane_ratio')) || 30;
    
    const clampedDual = clamp(dualRatio, 15, 85);
    const clampedBottom = clamp(bottomRatio, 15, 85);

    root.style.setProperty('--left-width', `${clampedDual}%`);
    root.style.setProperty('--top-height', `${clampedDual}%`);
    root.style.setProperty('--bottom-height', `${clampedBottom}vh`);
  } catch (e) {
    // Ignore localStorage errors and fallback to CSS defaults if needed
  }

  const drag = (handle, onMove, onEnd) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.target.setPointerCapture(e.pointerId);
      handle.classList.add('splitter-dragging');
      const move = (ev) => onMove(ev);
      const up = (ev) => {
        handle.classList.remove('splitter-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (e.target.hasPointerCapture(e.pointerId)) {
          e.target.releasePointerCapture(e.pointerId);
        }
        if (onEnd) onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  };

  const panesEl = document.querySelector('.panes');
  let lastDualPct = null;
  drag(el('vertical-splitter'), (e) => {
    // Desktop (row): drag adjusts left pane width.
    // Mobile (column): drag adjusts top pane height.
    if (getComputedStyle(panesEl).flexDirection === 'column') {
      const rect = panesEl.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      lastDualPct = clamp(pct, 15, 85);
      root.style.setProperty('--top-height', `${lastDualPct}%`);
    } else {
      const pct = (e.clientX / window.innerWidth) * 100;
      lastDualPct = clamp(pct, 15, 85);
      root.style.setProperty('--left-width', `${lastDualPct}%`);
    }
  }, () => {
    if (lastDualPct !== null) {
      localStorage.setItem('litesync_dual_pane_ratio', lastDualPct);
    }
  });

  const historyEl = document.querySelector('.history');
  let lastBottomPct = null;
  drag(el('horizontal-splitter'), (e) => {
    const height = historyEl.getBoundingClientRect().bottom - e.clientY;
    const pct = (height / window.innerHeight) * 100;
    lastBottomPct = clamp(pct, 15, 85);
    root.style.setProperty('--bottom-height', `${lastBottomPct}vh`);
  }, () => {
    if (lastBottomPct !== null) {
      localStorage.setItem('litesync_bottom_pane_ratio', lastBottomPct);
    }
  });
}

// --- Init ---

async function init() {
  // Determine layout state and update UI immediately before any async yielding
  const btnSingle = el('btn-single-pane');
  const btnDual = el('btn-dual-pane');

  const updateLayoutUI = () => {
    if (state.singlePane) {
      document.body.classList.add('single-pane');
      btnSingle.classList.add('active');
      btnDual.classList.remove('active');
      localStorage.removeItem('litesync-dual-pane');
    } else {
      document.body.classList.remove('single-pane');
      btnDual.classList.add('active');
      btnSingle.classList.remove('active');
      localStorage.setItem('litesync-dual-pane', 'true');
    }
    
    // Update destination picker visibility if the modal is currently open
    const confirmModal = el('confirm-modal');
    if (confirmModal && !confirmModal.classList.contains('hidden')) {
      if (state.singlePane) {
        el('transfer-static-dest-view').classList.add('hidden');
        el('transfer-picker-container').classList.remove('hidden');
        el('transfer-options-field').classList.remove('hidden');
      } else {
        el('transfer-static-dest-view').classList.remove('hidden');
        el('transfer-picker-container').classList.add('hidden');
        // Hide operation radio buttons if moving is invalid across filesystems,
        // though typically dual pane transfer defaults to copy unless we compute it.
        // For simplicity, we just unhide the options field and let selection logic handle it.
        el('transfer-options-field').classList.remove('hidden'); 
      }
    }
    updateSelectionUI(); // re-evaluates transfer button state since singlePane changes it
    if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
      updateTransferMethodUI();
    }
  };
  
  updateLayoutUI();

  btnSingle.addEventListener('click', () => {
    if (!state.singlePane) {
      state.singlePane = true;
      updateLayoutUI();
    }
  });

  btnDual.addEventListener('click', () => {
    if (state.singlePane) {
      state.singlePane = false;
      updateLayoutUI();
    }
  });

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

  document.querySelectorAll('.pane-master-cb').forEach(cb => {
    cb.addEventListener('click', (e) => {
      const pane = e.target.getAttribute('data-pane');
      const sel = paneSelection(pane);
      const isChecked = e.target.checked;
      const paneState = state[pane];
      
      if (!paneState || !paneState.entries) return;

      if (isChecked) {
        paneState.entries.forEach(entry => sel.select(entry.path));
      } else {
        paneState.entries.forEach(entry => sel.unselect(entry.path));
      }
      
      renderPane(pane);
      updateSelectionUI();
      if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
        updateTransferMethodUI();
      }
    });
  });

  document.querySelectorAll('.pane-column-header button.sortable').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const pane = e.currentTarget.getAttribute('data-pane');
      const col = e.currentTarget.getAttribute('data-sort');
      const sortState = state.sort[pane];
      if (sortState.col === col) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.col = col;
        sortState.dir = 'asc';
      }
      renderPane(pane);
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

  const searchInput = el('activity-search');
  if (searchInput) {
    searchInput.addEventListener('input', filterActivity);
  }

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
  const itemDismissBtn = el('item-details-dismiss');
  if (itemDismissBtn) {
    itemDismissBtn.addEventListener('click', (e) => {
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
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
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



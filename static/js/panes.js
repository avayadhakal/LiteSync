import { api, copyDownloadLink, attachLongPress } from './api.js';
import { el, formatSize, formatMtime, escapeHtml, normalizePath } from './utils.js';
import { state } from './state.js';
import { openItemDetailsModal } from './modals/item-details.js';

export async function loadPane(which, path, forceRefresh = false, fallbackToParent = true) {
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
      if (fallbackToParent) {
        // The current directory itself may have just been moved/deleted by a
        // completed transfer: fall back to its parent so the pane never shows
        // a listing of a path that no longer exists.
        const parent = normalizePath(fetchPath).replace(/\/[^/]+$/, '') || '/';
        if (parent !== normalizePath(fetchPath)) {
          try {
            await loadPane(which, parent, true, true);
            return;
          } catch (e) {
            // Let it fall through if the parent also doesn't exist
          }
        }
      }
      
      if (which === 'pickerDest') {
        localStorage.removeItem('litesync-last-destination');
        await loadPane(which, null, false, false);
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
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
}

export function sortPaneEntries(which) {
  const pane = state[which];
  const sortState = state.sort[which];
  if (!pane.entries || !sortState) return;

  pane.entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) {
      return a.is_dir ? -1 : 1; // Folders always on top
    }
    
    let cmp = 0;
    if (sortState.col === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (sortState.col === 'mtime') {
      cmp = (a.mtime || 0) - (b.mtime || 0);
    } else if (sortState.col === 'size') {
      cmp = (a.size || 0) - (b.size || 0);
    }
    return sortState.dir === 'asc' ? cmp : -cmp;
  });
}

export function renderPane(which) {
  const pane = state[which];
  const sel = paneSelection(which);
  const pathElId = which === 'pickerDest' ? 'transfer-picker-path' : `${which}-path`;
  const bodyElId = which === 'pickerDest' ? 'transfer-picker-body' : `${which}-body`;
  const pathEl = el(pathElId);
  pathEl.textContent = pane.path === null ? '(select a root)' : pane.path;
  pathEl.title = pane.path === null ? '' : pane.path;
  requestAnimationFrame(() => {
    pathEl.scrollLeft = pathEl.scrollWidth;
  });
  const body = el(bodyElId);
  if (!body) return;
  const prevScrollTop = body.scrollTop;
  body.innerHTML = '';

  sortPaneEntries(which);

  // Update sort icons
  const sortState = state.sort[which];
  if (sortState) {
    document.querySelectorAll(`.pane-column-header button[data-pane="${which}"]`).forEach(btn => {
      const icon = btn.querySelector('.sort-icon');
      if (!icon) return;
      if (btn.getAttribute('data-sort') === sortState.col) {
        icon.textContent = sortState.dir === 'asc' ? '▲' : '▼';
      } else {
        icon.textContent = '';
      }
    });
  }

  if (which === 'pickerDest') {
    const okBtn = el('confirm-ok');
    if (okBtn) okBtn.disabled = pane.path === null;
  }

  const masterCb = el(`${which}-master-cb`);
  if (masterCb && pane.entries) {
    const total = pane.entries.length;
    let selectedCount = 0;
    let indeterminateCount = 0;

    for (const entry of pane.entries) {
      if (sel.isPathSelected(entry.path)) {
        selectedCount++;
      } else if (sel.isPathIndeterminate(entry.path)) {
        indeterminateCount++;
      }
    }

    if (total === 0) {
      masterCb.checked = false;
      masterCb.indeterminate = false;
      masterCb.disabled = true;
    } else {
      masterCb.disabled = false;
      if (selectedCount === total) {
        masterCb.checked = true;
        masterCb.indeterminate = false;
      } else if (selectedCount > 0 || indeterminateCount > 0) {
        masterCb.checked = false;
        masterCb.indeterminate = true;
      } else {
        masterCb.checked = false;
        masterCb.indeterminate = false;
      }
    }
  }

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
  if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
    updateTransferMethodUI();
  }
    });
    row.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    name.title = entry.name;
    row.appendChild(name);

    const mtime = document.createElement('span');
    mtime.className = 'mtime';
    mtime.textContent = formatMtime(entry.mtime);
    row.appendChild(mtime);

    const size = document.createElement('span');
    size.className = 'size';
    if (!entry.is_dir) {
      size.textContent = formatSize(entry.size);
    }
    row.appendChild(size);

    if (!entry.is_dir) {
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
    } else {
      const copyBtnSpacer = document.createElement('span');
      copyBtnSpacer.className = 'icon-btn btn-copy-path invisible-spacer';
      copyBtnSpacer.style.visibility = 'hidden';
      row.appendChild(copyBtnSpacer);
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

export function paneSelection(which) {
  if (which === 'pickerDest') return state.pickerDestSelection;
  return which === 'source' ? state.selection : state.destSelection;
}

export function updateSelectionUI() {
  // Only the source pane drives the Transfer button; show its count.
  const count = state.selection.size;
  el('transfer-btn').disabled = !(count > 0 && (state.dest.path || state.singlePane));

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

export function renderSelectionPreview() {
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

export function openSelectionPreview() {
  const preview = el('selection-preview');
  if (!preview) return;
  renderSelectionPreview();
  preview.classList.remove('hidden');
}

export function closeSelectionPreview() {
  const preview = el('selection-preview');
  if (preview) preview.classList.add('hidden');
}

export function toggleSelectionPreview() {
  const preview = el('selection-preview');
  if (!preview) return;
  if (preview.classList.contains('hidden')) openSelectionPreview();
  else closeSelectionPreview();
}


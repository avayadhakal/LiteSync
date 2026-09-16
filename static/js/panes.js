import { api, copyDownloadLink } from './api.js';
import { el, formatSize, formatMtime, escapeHtml, normalizePath } from './utils.js';
import { state } from './state.js';
import { openItemDetailsModal } from './modals/item-details.js';
import { I18n } from './i18n.js';

const DOUBLE_TAP_DELAY_MS = 300;
const MOVE_THRESHOLD_PX = 10;
const lastClickedIndex = new Map(); // which -> index

export function isActionDialogEligible(e) {
  if (!e || !e.target) return false;
  if (e.target.tagName === 'INPUT') return false;
  if (e.target.closest && e.target.closest('.btn-copy-path')) return false;
  return true;
}

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
  lastClickedIndex.delete(which);
  const pane = state[which];
  const sel = paneSelection(which);
  const pathElId = which === 'pickerDest' ? 'transfer-picker-path' : `${which}-path`;
  const bodyElId = which === 'pickerDest' ? 'transfer-picker-body' : `${which}-body`;
  const pathEl = el(pathElId);
  pathEl.textContent = pane.path === null ? I18n.t('panes.select_root') : pane.path;
  pathEl.title = pane.path === null ? '' : pane.path;
  requestAnimationFrame(() => {
    pathEl.scrollLeft = pathEl.scrollWidth;
  });
  
  if (which === 'pickerDest') {
    const okBtn = el('confirm-ok');
    if (okBtn) okBtn.disabled = pane.path === null;
  }

  const body = el(bodyElId);
  if (!body) return;
  const prevScrollTop = body.scrollTop;
  body.innerHTML = '';
  const fragment = document.createDocumentFragment();

  if (pane.path !== null) {
    const up = document.createElement('div');
    up.className = 'entry parent';
    up.innerHTML = '<span class="name">..</span>';
    up.title = I18n.t('panes.up_parent');
    up.addEventListener('click', () => loadPane(which, pane.parent));
    fragment.appendChild(up);
  }

  for (let i = 0; i < pane.entries.length; i++) {
    const entry = pane.entries[i];
    const row = document.createElement('div');
    const isSelected = sel.isPathSelected(entry.path);
    row.className = `entry ${entry.is_dir ? 'dir' : 'file'}${isSelected && !entry.is_dir ? ' selected' : ''}`;
    row.setAttribute('data-path', entry.path);
    row.setAttribute('data-index', i);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isSelected;
    if (entry.is_dir) {
      cb.indeterminate = sel.isPathIndeterminate(entry.path);
    }
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
      copyBtn.title = I18n.t('panes.copy_link');
      row.appendChild(copyBtn);
    } else {
      const copyBtnSpacer = document.createElement('span');
      copyBtnSpacer.className = 'icon-btn btn-copy-path invisible-spacer';
      copyBtnSpacer.style.visibility = 'hidden';
      row.appendChild(copyBtnSpacer);
    }

    row.title = entry.path;
    fragment.appendChild(row);
  }
  
  body.appendChild(fragment);
  body.scrollTop = prevScrollTop;
  updateMasterCheckboxState(which);
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
    countEl.textContent = hasSel ? I18n.t('panes.selected_count', { count }) : '';
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

export function refreshPaneCheckboxes(which) {
  const body = el(which + '-body');
  if (!body) return;
  const sel = paneSelection(which);
  const checkboxes = body.querySelectorAll('input[type="checkbox"]');
  for (const cb of checkboxes) {
    const row = cb.closest('.entry');
    if (!row) continue;
    const path = row.getAttribute('data-path');
    if (!path) continue;
    const isDir = row.classList.contains('dir');
    const isSelected = sel.isPathSelected(path);
    if (cb.checked !== isSelected) cb.checked = isSelected;
    if (!isDir && isSelected !== row.classList.contains('selected')) {
      row.classList.toggle('selected', isSelected);
    }
    if (isDir) {
      const ind = sel.isPathIndeterminate(path);
      if (cb.indeterminate !== ind) cb.indeterminate = ind;
    }
  }
  updateMasterCheckboxState(which);
}

export function updateMasterCheckboxState(which) {
  const masterCb = document.querySelector(`.pane-master-cb[data-pane="${which}"]`);
  if (!masterCb) return;
  const paneKey = which === 'pickerDest' ? 'pickerDest' : which;
  const paneState = state[paneKey];
  const sel = paneSelection(which);
  if (paneState && paneState.entries && paneState.entries.length > 0) {
    let allSelected = true;
    let someSelected = false;
    for (const entry of paneState.entries) {
      if (sel.isPathSelected(entry.path)) {
        someSelected = true;
      } else {
        allSelected = false;
      }
    }
    masterCb.checked = allSelected;
    masterCb.indeterminate = someSelected && !allSelected;
  } else {
    masterCb.checked = false;
    masterCb.indeterminate = false;
  }
}

function applySingleRowCheckbox(row, cb, which) {
  const path = row.getAttribute('data-path');
  const sel = paneSelection(which);
  const isDir = row.classList.contains('dir');
  const isSelected = sel.isPathSelected(path);

  if (cb.checked !== isSelected) cb.checked = isSelected;
  if (!isDir && isSelected !== row.classList.contains('selected')) {
    row.classList.toggle('selected', isSelected);
  }
  if (isDir) {
    const ind = sel.isPathIndeterminate(path);
    if (cb.indeterminate !== ind) cb.indeterminate = ind;
  }

  updateMasterCheckboxState(which);
}

export function renderSelectionPreview() {
  const list = el('selection-preview-list');
  const countEl = el('selection-preview-count');
  if (!list || !countEl) return;
  const sources = state.selection.toTransferSources();
  countEl.textContent = I18n.t('panes.selected_count', { count: sources.length });
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



const rowTouchState = new Map(); // path -> { startX, startY, lastTouchEnd, touchMoved }

export function bindPaneDelegation(paneId, which) {
  const container = el(paneId);
  if (!container) return;
  
  container.addEventListener('click', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    const btn = e.target.closest('.btn-copy-path');
    const parentRow = e.target.closest('.entry.parent');
    const row = e.target.closest('.entry[data-path]');
    
    if (cb && row) {
      e.stopPropagation();
      const path = row.getAttribute('data-path');
      const sel = paneSelection(which);
      const rowIndex = parseInt(row.getAttribute('data-index') ?? '-1', 10);
      
      if (e.shiftKey && rowIndex >= 0 && lastClickedIndex.has(which)) {
        // Shift-click: range select/deselect based on anchor's final checked state
        const anchorIndex = lastClickedIndex.get(which);
        const paneState = state[which === 'pickerDest' ? 'pickerDest' : which];
        const from = Math.min(anchorIndex, rowIndex);
        const to = Math.max(anchorIndex, rowIndex);
        // Use the current checkbox state (post-browser-toggle) to determine intent
        const doSelect = cb.checked;
        for (let i = from; i <= to; i++) {
          const entry = paneState.entries[i];
          if (!entry) continue;
          if (doSelect) sel.select(entry.path);
          else sel.unselect(entry.path);
        }
        refreshPaneCheckboxes(which);
      } else {
        // Single click
        if (cb.checked) {
          sel.select(path);
        } else {
          sel.unselect(path);
        }
        applySingleRowCheckbox(row, cb, which);
      }

      if (rowIndex >= 0) lastClickedIndex.set(which, rowIndex);
      updateSelectionUI();
      if (typeof updateTransferMethodUI === 'function' && el('confirm-modal') && !el('confirm-modal').classList.contains('hidden')) {
        updateTransferMethodUI();
      }
      return;
    }
    
    if (btn && row) {
      e.stopPropagation();
      const path = row.getAttribute('data-path');
      copyDownloadLink(path).then(success => {
        if (success) {
          btn.innerHTML = '✓';
          btn.style.color = 'var(--success)';
          setTimeout(() => {
            btn.innerHTML = '📋';
            btn.style.color = '';
          }, 1500);
        }
      });
      return;
    }
    
    if (parentRow) {
      return;
    }
    
    if (row && row.classList.contains('dir')) {
      if (!isActionDialogEligible(e)) return;
      loadPane(which, row.getAttribute('data-path'));
    }
  });

  container.addEventListener('dblclick', (e) => {
    if (!isActionDialogEligible(e)) return;
    const row = e.target.closest('.entry[data-path]');
    if (!row) return;
    const path = row.getAttribute('data-path');
    
    if (row.classList.contains('dir')) {
      e.preventDefault();
      loadPane(which, path);
    } else {
      const pane = state[which === 'pickerDest' ? 'pickerDest' : which];
      const entry = pane.entries.find(en => en.path === path);
      if (entry) openItemDetailsModal(entry, which);
    }
  });

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !isActionDialogEligible(e)) return;
    const row = e.target.closest('.entry[data-path]:not(.dir)');
    if (!row) return;
    const path = row.getAttribute('data-path');
    const t = e.touches[0];
    const s = rowTouchState.get(path) || { lastTouchEnd: 0 };
    rowTouchState.set(path, {
      lastTouchEnd: s.lastTouchEnd,
      startX: t.clientX,
      startY: t.clientY,
      touchMoved: false,
    });
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const row = e.target.closest('.entry[data-path]:not(.dir)');
    if (!row) return;
    const path = row.getAttribute('data-path');
    const s = rowTouchState.get(path);
    if (!s) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - s.startX) > 10 || Math.abs(t.clientY - s.startY) > 10) {
      s.touchMoved = true;
      s.lastTouchEnd = 0;
    }
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    const row = e.target.closest('.entry[data-path]:not(.dir)');
    if (!row || !isActionDialogEligible(e)) return;
    const path = row.getAttribute('data-path');
    const s = rowTouchState.get(path);
    if (!s || s.touchMoved) {
      if (s) s.lastTouchEnd = 0;
      return;
    }
    const now = Date.now();
    if (now - s.lastTouchEnd < 300) {
      e.preventDefault();
      s.lastTouchEnd = 0;
      const pane = state[which === 'pickerDest' ? 'pickerDest' : which];
      const entry = pane.entries.find(en => en.path === path);
      if (entry) openItemDetailsModal(entry, which);
    } else {
      s.lastTouchEnd = now;
    }
  });

  container.addEventListener('touchcancel', (e) => {
    const row = e.target.closest('.entry[data-path]:not(.dir)');
    if (!row) return;
    const path = row.getAttribute('data-path');
    const s = rowTouchState.get(path);
    if (s) s.lastTouchEnd = 0;
  }, { passive: true });
}

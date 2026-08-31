import { api, toastError } from '../api.js';
import { el, normalizePath } from '../utils.js';
import { state } from '../state.js';
import { paneSelection } from '../panes.js';

export function showConflictModal(conflicts, onResolve) {
  const modal = el('conflict-modal');
  const list = el('conflict-list');
  list.innerHTML = '';
  for (const c of conflicts) {
    const li = document.createElement('li');
    li.textContent = c;
    list.appendChild(li);
  }
  
  const cleanup = () => {
    modal.classList.add('hidden');
    el('conflict-cancel').onclick = null;
    el('conflict-rename').onclick = null;
    el('conflict-overwrite').onclick = null;
  };
  
  el('conflict-cancel').onclick = () => { cleanup(); onResolve(null); };
  el('conflict-rename').onclick = () => { cleanup(); onResolve('rename'); };
  el('conflict-overwrite').onclick = () => { cleanup(); onResolve('overwrite'); };
  
  modal.classList.remove('hidden');
}

export function updateTransferMethodUI() {
  const rsyncWrapper = el('transfer-rsync-wrapper');
  if (!rsyncWrapper) return;
  
  const opRadio = document.querySelector('input[name="transfer-op"]:checked');
  const operation = opRadio ? opRadio.value : 'copy';
  
  const sources = state.selection.toTransferSources();
  const hasExclusions = sources.some(s => typeof s !== 'string' && s.excludes && s.excludes.length > 0);
  
  const toggle = el('transfer-rsync-toggle');
  const hint = el('transfer-rsync-hint');
  const label = el('transfer-rsync-label');
  
  rsyncWrapper.classList.remove('hidden');
  
  if (hasExclusions) {
    label.style.opacity = '0.7';
    label.style.cursor = 'not-allowed';
    toggle.checked = true;
    toggle.disabled = true;
    hint.textContent = 'Required for excludes.';
    return;
  }
  
  // Normal copy or move
  label.style.opacity = '1';
  label.style.cursor = 'pointer';
  toggle.disabled = false;
  if (toggle.checked) {
    hint.textContent = 'Resumes on restart.';
  } else {
    hint.textContent = 'Faster, but no resume.';
  }
}

export function closeConfirmModal() {
  el('confirm-modal').classList.add('hidden');
  const btnSingle = el('btn-single-pane');
  const btnDual = el('btn-dual-pane');
  if (btnSingle) btnSingle.disabled = false;
  if (btnDual) btnDual.disabled = false;
}

export function getPrimaryTitle(sources) {
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

export function _getMatchedRoot(pathStr) {
  if (!pathStr) return null;
  const norm = normalizePath(pathStr);
  let best = null;
  for (const r of state.roots) {
    const normR = normalizePath(r);
    if (norm === normR || norm.startsWith(normR + '/')) {
      if (!best || r.length > best.length) {
        best = r;
      }
    }
  }
  return best;
}


import { api, toastSuccess, toastError } from '../api.js';
import { el, normalizePath } from '../utils.js';
import { state } from '../state.js';
import { loadPane, paneSelection } from '../panes.js';
import { openModal } from '../app.js';

export function openMkdirModal(which = 'source') {
  if (!state[which].path) {
    toastError(`Navigate to a folder in the ${which === 'source' ? 'Source' : 'Destination'} pane first.`);
    return;
  }
  el('mkdir-modal').dataset.pane = which;
  el('mkdir-input').value = '';
  el('mkdir-location').textContent = state[which].path;
  openModal('mkdir');
}

export function openRenameModal(which) {
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

export function openDeleteModal(which) {
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

export function setModalError(which, msg) {
  const errEl = el(`${which}-error`);
  if (errEl) {
    errEl.textContent = msg || '';
    errEl.classList[msg ? 'remove' : 'add']('hidden');
  }
}


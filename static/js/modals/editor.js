import { el } from '../utils.js';
import { api, toastSuccess, toastError } from '../api.js';
import { loadActivity } from '../activity.js';
import { confirmStyled } from '../app.js';

let currentPath = null;
let currentMtimeNs = null;
let originalContent = '';
let isMaximized = false;

export function isEditorOpen() {
  const modal = el('editor-modal');
  return modal && !modal.classList.contains('hidden');
}

export function isEditorMaximized() {
  return isMaximized;
}

export function toggleEditorMaximize() {
  const modalDialog = document.querySelector('#editor-modal .modal-editor');
  const maxBtn = el('editor-maximize');
  if (!modalDialog || !maxBtn) return;

  isMaximized = !isMaximized;
  if (isMaximized) {
    modalDialog.classList.add('maximized');
    maxBtn.innerHTML = '<img src="/assets/icons/minimize.svg" class="ui-icon" alt="" />';
    maxBtn.title = 'Restore';
    maxBtn.setAttribute('aria-label', 'Restore');
  } else {
    modalDialog.classList.remove('maximized');
    maxBtn.innerHTML = '<img src="/assets/icons/maximize.svg" class="ui-icon" alt="" />';
    maxBtn.title = 'Maximize';
    maxBtn.setAttribute('aria-label', 'Maximize');
  }
}

export async function openEditorModal(entry) {
  const modal = el('editor-modal');
  const modalDialog = document.querySelector('#editor-modal .modal-editor');
  const maxBtn = el('editor-maximize');
  const textarea = el('editor-textarea');
  const titleEl = el('editor-title');
  const pathEl = el('editor-path');
  const errorEl = el('editor-error');

  if (!modal || !textarea) return;

  // Reset maximized state on new open session
  isMaximized = false;
  if (modalDialog) modalDialog.classList.remove('maximized');
  if (maxBtn) {
    maxBtn.innerHTML = '<img src="/assets/icons/maximize.svg" class="ui-icon" alt="" />';
    maxBtn.title = 'Maximize';
    maxBtn.setAttribute('aria-label', 'Maximize');
  }

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  try {
    const data = await api(`/api/file-content?path=${encodeURIComponent(entry.path)}`);
    currentPath = data.path || entry.path;
    currentMtimeNs = data.mtime_ns;
    originalContent = data.content || '';

    if (titleEl) titleEl.textContent = entry.name;
    if (pathEl) pathEl.textContent = currentPath;
    textarea.value = originalContent;

    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
      textarea.focus();
    });
  } catch (err) {
    // If backend rejects (e.g. 413 oversized or 400 non-UTF8), fall back to Path A
    toastError(err.message || 'Cannot open in editor, falling back to download stream...');
    try {
      const linkData = await api(`/api/download/link?path=${encodeURIComponent(entry.path)}&disposition=inline`);
      if (linkData && linkData.url) {
        window.open(linkData.url, '_blank', 'noopener,noreferrer');
      }
    } catch (_e) {
      // Handled by toast
    }
  }
}

export async function saveEditorContent() {
  const textarea = el('editor-textarea');
  const errorEl = el('editor-error');
  const saveBtn = el('editor-save');

  if (!currentPath || !textarea) return;

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  if (saveBtn) saveBtn.disabled = true;

  try {
    const result = await api('/api/file-content', {
      method: 'POST',
      body: JSON.stringify({
        path: currentPath,
        content: textarea.value,
        expected_mtime_ns: currentMtimeNs,
      }),
    });

    originalContent = textarea.value;
    currentMtimeNs = result.mtime_ns;
    toastSuccess('File saved successfully');
    await loadActivity();
  } catch (err) {
    // Retain user's edits in textarea buffer on error (including 409 conflict)
    const errMsg = err.message || 'Failed to save file';
    if (errorEl) {
      errorEl.textContent = errMsg;
      errorEl.classList.remove('hidden');
    }
    toastError(errMsg);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export async function closeEditorModal() {
  const modal = el('editor-modal');
  const textarea = el('editor-textarea');
  const errorEl = el('editor-error');

  if (!modal || modal.classList.contains('hidden')) return;

  if (textarea && textarea.value !== originalContent) {
    const ok = await confirmStyled(
      'Discard unsaved changes?',
      'You have unsaved changes. Are you sure you want to discard them and close?',
      'Discard',
      true
    );
    if (!ok) return;
  }

  modal.classList.add('hidden');
  const modalDialog = document.querySelector('#editor-modal .modal-editor');
  const maxBtn = el('editor-maximize');
  isMaximized = false;
  if (modalDialog) modalDialog.classList.remove('maximized');
  if (maxBtn) {
    maxBtn.innerHTML = '<img src="/assets/icons/maximize.svg" class="ui-icon" alt="" />';
    maxBtn.title = 'Maximize';
    maxBtn.setAttribute('aria-label', 'Maximize');
  }

  currentPath = null;
  currentMtimeNs = null;
  originalContent = '';
  if (textarea) textarea.value = '';
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
}

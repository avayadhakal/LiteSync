import { api, toastSuccess, toastError } from './api.js';
import { el, escapeHtml, formatSize, normalizePath } from './utils.js';
import { state } from './state.js';
import { loadPane } from './panes.js';
import { showConflictModal } from './modals/transfer.js';
import { loadActivity } from './activity.js';
import { loadHistory } from './app.js';
import { I18n } from "./i18n.js";



let currentUploadPane = 'source';
let currentUploadPath = null;
let uploadModalInitialized = false;

export function openUploadPicker(pane) {
  const curPath = state[pane] && state[pane].path;
  if (!curPath) {
    toastError(I18n.t('messages.navigate_first', { pane: pane === 'source' ? I18n.t('panes.source') : I18n.t('panes.destination') }));
    return;
  }
  currentUploadPane = pane;
  currentUploadPath = curPath;
  state.pendingUploadPane = pane;
  state.pendingUploadPath = curPath;

  initUploadModal();

  const destEl = el('upload-modal-dest');
  if (destEl) destEl.textContent = curPath;

  const urlInput = el('upload-url-input');
  if (urlInput) urlInput.value = '';
  const fnInput = el('upload-url-filename');
  if (fnInput) fnInput.value = '';
  const errEl = el('upload-url-error');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }

  // Default to From Device
  setUploadModalTab('device');

  const modal = el('upload-modal');
  if (modal) modal.classList.remove('hidden');
}

export function closeUploadModal() {
  const modal = el('upload-modal');
  if (modal) modal.classList.add('hidden');
}

function setUploadModalTab(tab) {
  const btnDevice = el('btn-upload-device');
  const btnUrl = el('btn-upload-url');
  const secDevice = el('upload-device-section');
  const secUrl = el('upload-url-section');
  const dlBtn = el('upload-url-download-btn');

  if (tab === 'device') {
    if (btnDevice) btnDevice.classList.add('active');
    if (btnUrl) btnUrl.classList.remove('active');
    if (secDevice) secDevice.classList.remove('hidden');
    if (secUrl) secUrl.classList.add('hidden');
    if (dlBtn) dlBtn.classList.add('hidden');
  } else {
    if (btnUrl) btnUrl.classList.add('active');
    if (btnDevice) btnDevice.classList.remove('active');
    if (secUrl) secUrl.classList.remove('hidden');
    if (secDevice) secDevice.classList.add('hidden');
    if (dlBtn) dlBtn.classList.remove('hidden');
    const urlInput = el('upload-url-input');
    if (urlInput) requestAnimationFrame(() => urlInput.focus());
  }
}

function initUploadModal() {
  if (uploadModalInitialized) return;
  uploadModalInitialized = true;

  const modal = el('upload-modal');
  const dismissBtn = el('upload-modal-dismiss');
  const cancelBtn = el('upload-modal-cancel');
  const btnDevice = el('btn-upload-device');
  const btnUrl = el('btn-upload-url');
  const dropzone = el('upload-dropzone');
  const fileInput = el('upload-file-input');
  const downloadBtn = el('upload-url-download-btn');
  const urlInput = el('upload-url-input');

  if (dismissBtn) dismissBtn.addEventListener('click', closeUploadModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeUploadModal);

  if (btnDevice) btnDevice.addEventListener('click', () => setUploadModalTab('device'));
  if (btnUrl) btnUrl.addEventListener('click', () => setUploadModalTab('url'));

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => {
      closeUploadModal();
      fileInput.click();
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent)';
      dropzone.style.background = 'rgba(79, 140, 255, 0.05)';
    });

    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border)';
      dropzone.style.background = '';
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border)';
      dropzone.style.background = '';
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) {
        closeUploadModal();
        startUploads(currentUploadPane, currentUploadPath, files);
      }
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', submitUrlDownload);
  }

  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitUrlDownload();
      } else if (e.key === 'Escape') {
        closeUploadModal();
      }
    });
  }
}

async function submitUrlDownload() {
  const urlInput = el('upload-url-input');
  const fnInput = el('upload-url-filename');
  const errEl = el('upload-url-error');
  const dlBtn = el('upload-url-download-btn');

  const url = urlInput ? urlInput.value.trim() : '';
  if (!url) {
    if (errEl) {
      errEl.textContent = 'URL is required.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const filename = fnInput && fnInput.value.trim() ? fnInput.value.trim() : null;
  const conflictRadio = document.querySelector('input[name="upload-url-conflict"]:checked');
  const on_conflict = conflictRadio ? conflictRadio.value : 'skip';

  if (dlBtn) dlBtn.disabled = true;
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }

  try {
    const res = await api('/api/transfer/url', {
      method: 'POST',
      body: JSON.stringify({
        url,
        destination: currentUploadPath,
        filename,
        on_conflict,
      }),
    });

    closeUploadModal();
    toastSuccess(I18n.t('messages.queued_download', { file: res.filename || 'file', dest: res.destination }));
    await loadHistory();
  } catch (err) {
    const errMsg = err.message || 'Failed to queue URL download';
    if (errEl) {
      errEl.textContent = errMsg;
      errEl.classList.remove('hidden');
    }
    toastError(I18n.t('messages.download_failed_queue', { err: errMsg }));
  } finally {
    if (dlBtn) dlBtn.disabled = false;
  }
}

export function startUploads(pane, destPath, files, resolvedConflictChoice = null) {
  if (!files || files.length === 0) return;

  if (!resolvedConflictChoice) {
    api(`/api/browse?path=${encodeURIComponent(destPath)}`).then(data => {
      const existingNames = new Set(data.entries.map(e => e.name));
      const fileNames = Array.from(files).map(f => f.name);
      
      const conflicts = fileNames.filter(name => existingNames.has(name));
      if (conflicts.length > 0) {
        showConflictModal(conflicts, (choice) => {
          if (choice) {
            startUploads(pane, destPath, files, choice);
          }
        });
        return;
      }
      startUploads(pane, destPath, files, 'skip');
    }).catch(e => {
      startUploads(pane, destPath, files, 'skip');
    });
    return;
  }

  const stack = el('toast-stack');
  if (!stack) return;

  const card = document.createElement('div');
  card.className = 'upload-card';

  const header = document.createElement('div');
  header.className = 'upload-card-header';
  const folderName = normalizePath(destPath).split('/').pop() || destPath;
  header.innerHTML = `
    <span>Uploading ${files.length} file${files.length === 1 ? '' : 's'} → ${escapeHtml(folderName)}</span>
    <button class="upload-close-btn" title="Close" style="background:none;border:none;color:inherit;cursor:pointer;font-size:16px;">&times;</button>
  `;
  const closeBtn = header.querySelector('.upload-close-btn');
  closeBtn.addEventListener('click', () => {
    card.classList.add('toast-out');
    setTimeout(() => card.remove(), 220);
  });
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
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
      if (document.body.contains(card)) {
        card.classList.add('toast-out');
        setTimeout(() => card.remove(), 220);
      }
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
        toastSuccess(I18n.t('messages.uploaded', { file: item.file.name }));
      } else {
        item.status = 'failed';
        let errMsg = 'Upload failed';
        try {
          const resJson = JSON.parse(xhr.responseText);
          if (resJson && resJson.detail) errMsg = resJson.detail;
        } catch (_) {
          if (xhr.statusText) errMsg = xhr.statusText;
        }
        toastError(I18n.t('messages.upload_failed', { file: item.file.name, err: errMsg }));
      }

      try {
        if (state[pane] && state[pane].path === destPath) {
          await loadPane(pane, destPath);
        }
        await loadActivity();
      } catch (err) {
        console.error('Failed to reload panes after upload:', err);
      } finally {
        if (item.rowEl) item.rowEl.remove();
        checkAllFinished();
      }
    };

    xhr.onerror = async () => {
      if (item.status === 'aborted') return;
      item.status = 'failed';
      toastError(I18n.t('messages.upload_failed_network', { file: item.file.name }));

      try {
        await loadActivity();
      } catch (err) {
        console.error('Failed to reload activity after error:', err);
      } finally {
        if (item.rowEl) item.rowEl.remove();
        checkAllFinished();
      }
    };

    xhr.onabort = async () => {
      item.status = 'aborted';
      if (item.rowEl) item.rowEl.remove();
      checkAllFinished();
    };

    const fd = new FormData();
    fd.append('path', destPath);
    fd.append('on_conflict', resolvedConflictChoice || 'skip');
    fd.append('files', item.file, item.file.name);
    xhr.send(fd);
  });
}

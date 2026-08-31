import { api, toastSuccess, toastError } from './api.js';
import { el, escapeHtml, formatSize, normalizePath } from './utils.js';
import { state } from './state.js';
import { loadPane } from './panes.js';
import { showConflictModal } from './modals/transfer.js';

export function openUploadPicker(pane) {
  const curPath = state[pane] && state[pane].path;
  if (!curPath) {
    toastError(`Navigate to a folder in the ${pane === 'source' ? 'Source' : 'Destination'} pane first.`);
    return;
  }
  state.pendingUploadPane = pane;
  state.pendingUploadPath = curPath;
  const fileInput = el('upload-file-input');
  if (fileInput) {
    fileInput.click();
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
  header.innerHTML = `<span>Uploading ${files.length} file${files.length === 1 ? '' : 's'} → ${escapeHtml(folderName)}</span>`;
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
      card.classList.add('toast-out');
      setTimeout(() => card.remove(), 220);
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
        toastSuccess(`Uploaded ${item.file.name}`);
      } else {
        item.status = 'failed';
        let errMsg = 'Upload failed';
        try {
          const resJson = JSON.parse(xhr.responseText);
          if (resJson && resJson.detail) errMsg = resJson.detail;
        } catch (_) {
          if (xhr.statusText) errMsg = xhr.statusText;
        }
        toastError(`Upload failed for ${item.file.name}: ${errMsg}`);
      }

      if (state[pane] && state[pane].path === destPath) {
        await loadPane(pane, destPath);
      }
      await loadActivity();

      if (item.rowEl) item.rowEl.remove();
      checkAllFinished();
    };

    xhr.onerror = async () => {
      if (item.status === 'aborted') return;
      item.status = 'failed';
      toastError(`Upload failed for ${item.file.name}: Network error`);
      await loadActivity();
      if (item.rowEl) item.rowEl.remove();
      checkAllFinished();
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


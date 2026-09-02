import { el, formatSize } from '../utils.js';
import { api, copyDownloadLink, toastError } from '../api.js';

export async function open_file_action(path) {
  try {
    const data = await api(`/api/download/link?path=${encodeURIComponent(path)}`);
    if (data && data.url) {
      window.open(data.url, '_blank', 'noopener,noreferrer');
    }
  } catch (err) {
    toastError(err.message || 'Failed to open file');
  }
}

export function openItemDetailsModal(entry, which = 'source') {
  const modal = el('item-details-modal');
  if (!modal) return;

  el('item-details-name').textContent = entry.name;
  el('item-details-path').textContent = entry.path;

  const sizeEl = el('item-details-size');
  if (sizeEl) {
    sizeEl.textContent = entry.is_dir ? '—' : formatSize(entry.size || 0);
  }

  const dismissBtn = el('item-details-dismiss');
  if (dismissBtn) {
    dismissBtn.onclick = (e) => {
      e.stopPropagation();
      closeItemDetailsModal();
    };
  }

  const closeBtn = el('item-details-close');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeItemDetailsModal();
    };
  }

  const openBtn = el('item-details-open');
  if (openBtn) {
    if (entry.is_dir) {
      openBtn.classList.add('hidden');
    } else {
      openBtn.classList.remove('hidden');
      openBtn.onclick = async (e) => {
        e.stopPropagation();
        closeItemDetailsModal();
        await open_file_action(entry.path);
      };
    }
  }

  const copyBtn = el('item-details-copy');
  if (copyBtn) {
    if (entry.is_dir) {
      copyBtn.classList.add('hidden');
    } else {
      copyBtn.classList.remove('hidden');
      copyBtn.textContent = 'Copy Link';
      copyBtn.disabled = false;
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        const success = await copyDownloadLink(entry.path);
        if (success) {
          closeItemDetailsModal();
        }
      };
    }
  }

  modal.classList.remove('hidden');
}

export function closeItemDetailsModal() {
  const modal = el('item-details-modal');
  if (modal) modal.classList.add('hidden');
}



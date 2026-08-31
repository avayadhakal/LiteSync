import { el } from '../utils.js';
import { copyDownloadLink } from '../api.js';

export function openItemDetailsModal(entry) {
  const modal = el('item-details-modal');
  if (!modal) return;

  el('item-details-name').textContent = entry.name;
  el('item-details-path').textContent = entry.path;

  const copyBtn = el('item-details-copy');
  if (copyBtn) {
    if (entry.is_dir) {
      copyBtn.classList.add('hidden');
    } else {
      copyBtn.classList.remove('hidden');
      copyBtn.textContent = 'Copy URL';
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


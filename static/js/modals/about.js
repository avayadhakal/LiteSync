import { el } from '../utils.js';
import { api } from '../api.js';

let appVersion = null;

export async function loadAboutVersion() {
  const versionEl = el('about-version');
  if (!versionEl) return;

  if (appVersion) {
    versionEl.textContent = `v${appVersion}`;
    return;
  }

  try {
    const data = await api('/api/version');
    if (data && data.version) {
      appVersion = data.version.replace(/^v/, '');
      versionEl.textContent = `v${appVersion}`;
    } else {
      versionEl.textContent = 'dev';
    }
  } catch {
    versionEl.textContent = 'dev';
  }
}

export function openAboutModal() {
  const modal = el('about-modal');
  if (!modal) return;
  loadAboutVersion();
  modal.classList.remove('hidden');
}

export function closeAboutModal() {
  const modal = el('about-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}

export function initAboutModal() {
  const menuAbout = el('menu-about');
  const aboutModal = el('about-modal');
  if (!aboutModal) return;

  if (menuAbout) {
    menuAbout.addEventListener('click', () => {
      openAboutModal();
    });
  }

  const dismissBtn = el('about-modal-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', closeAboutModal);
  }

  const closeBtn = el('about-modal-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeAboutModal);
  }

  aboutModal.addEventListener('click', (e) => {
    if (e.target === aboutModal) {
      closeAboutModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !aboutModal.classList.contains('hidden')) {
      closeAboutModal();
    }
  });
}

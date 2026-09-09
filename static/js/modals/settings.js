import { el } from '../utils.js';
import { showToast } from '../api.js';

export function initSettingsModal() {
  const settingsModal = el('settings-modal');
  const menuSettings = el('menu-settings');
  if (!settingsModal || !menuSettings) return;

  const dismissBtns = [el('settings-modal-dismiss'), el('settings-cancel')];
  
  function applyTheme(theme) {
    const isSystemLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    if (theme === 'light' || (theme === 'system' && isSystemLight)) {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  // Load existing settings
  const loadSettings = () => {
    if (el('settings-theme')) el('settings-theme').value = localStorage.getItem('litesync-theme') || 'system';
    if (el('settings-show-hidden')) el('settings-show-hidden').checked = localStorage.getItem('litesync-show-hidden') === 'true';
    if (el('settings-language')) el('settings-language').value = localStorage.getItem('litesync-language') || 'en';
  };

  menuSettings.addEventListener('click', () => {
    loadSettings();
    if (el('settings-current-password')) el('settings-current-password').value = '';
    if (el('settings-new-password')) el('settings-new-password').value = '';
    if (el('settings-confirm-password')) el('settings-confirm-password').value = '';
    settingsModal.classList.remove('hidden');
  });

  dismissBtns.forEach(btn => {
    if (btn) btn.addEventListener('click', () => settingsModal.classList.add('hidden'));
  });

  const saveBtn = el('settings-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const theme = el('settings-theme').value;
      const showHidden = el('settings-show-hidden').checked;
      const language = el('settings-language').value;
      const currPwd = el('settings-current-password').value;
      const newPwd = el('settings-new-password').value;
      const confirmPwd = el('settings-confirm-password') ? el('settings-confirm-password').value : '';

      localStorage.setItem('litesync-theme', theme);
      localStorage.setItem('litesync-show-hidden', showHidden);
      localStorage.setItem('litesync-language', language);
      
      applyTheme(theme);
      
      console.log('Settings Saved:', { theme, showHidden, language });
      if (currPwd || newPwd || confirmPwd) {
        if (newPwd !== confirmPwd) {
          showToast('New passwords do not match!', 'error');
          return;
        }
        console.log('Password change requested (UI only)');
      }
      
      settingsModal.classList.add('hidden');
      showToast('Settings saved successfully (UI only)');
    });
  }
}

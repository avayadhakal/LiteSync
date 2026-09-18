import { el } from '../utils.js';
import { I18n } from '../i18n.js';
import { renderPane } from '../panes.js';
import { state } from '../state.js';
import { api, showToast } from '../api.js';

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
    if (el('settings-language')) el('settings-language').value = I18n.currentLang;
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
    saveBtn.addEventListener('click', async () => {
      const theme = el('settings-theme').value;
      const language = el('settings-language').value;
      if (language !== I18n.currentLang) {
        await I18n.loadLanguage(language);
        if (state.source.path) renderPane('source');
        if (state.dest.path) renderPane('dest');
      }
      const currPwd = el('settings-current-password').value;
      const newPwd = el('settings-new-password').value;
      const confirmPwd = el('settings-confirm-password') ? el('settings-confirm-password').value : '';

      localStorage.setItem('litesync-theme', theme);
      
      applyTheme(theme);
      
      let passwordChanged = false;
      if (currPwd || newPwd || confirmPwd) {
        if (newPwd !== confirmPwd) {
          showToast(I18n.t('messages.passwords_mismatch') || 'Passwords do not match', 'error');
          return;
        }
        if (newPwd.length < 8) {
          showToast('New password must be at least 8 characters', 'error');
          return;
        }
        try {
          await api('/api/change-password', {
            method: 'POST',
            body: JSON.stringify({ current_password: currPwd, new_password: newPwd })
          });
          passwordChanged = true;
          if (el('settings-current-password')) el('settings-current-password').value = '';
          if (el('settings-new-password')) el('settings-new-password').value = '';
          if (el('settings-confirm-password')) el('settings-confirm-password').value = '';
        } catch (err) {
          showToast(err.message, 'error');
          return;
        }
      }
      
      settingsModal.classList.add('hidden');
      if (passwordChanged) {
        showToast('Password updated successfully. Other devices will need to log in again.');
      } else {
        showToast(I18n.t('messages.settings_saved') || 'Settings saved');
      }
    });
  }
}

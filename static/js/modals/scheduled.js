import { el, escapeHtml } from '../utils.js';
import { I18n } from '../i18n.js';
import { api, showToast, toastError } from '../api.js';
import { confirmStyled } from '../app.js';
import { getPrimaryTitle } from './transfer.js';

export function closeScheduledModal() {
  const modal = el('scheduled-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

export async function loadScheduledTransfers() {
  const container = el('scheduled-transfers-container');
  if (!container) return;

  container.innerHTML = '<div class="empty-state scheduled-empty">Loading...</div>';

  let data;
  try {
    data = await api('/api/tasks/scheduled');
  } catch (err) {
    container.innerHTML = `<div class="modal-error">${escapeHtml(err.message)}</div>`;
    return;
  }

  const tasks = data.tasks || [];
  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state scheduled-empty" data-i18n="modals.scheduled.empty">
        ${I18n.t('modals.scheduled.empty')}
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  for (const task of tasks) {
    const card = document.createElement('div');
    card.className = 'scheduled-task-row';
    card.id = `card-${task.task_id}`;

    const title = getPrimaryTitle(task.source);
    let formattedTime = task.scheduled_for;
    try {
      const d = new Date(task.scheduled_for);
      if (!isNaN(d.getTime())) {
        formattedTime = d.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
      }
    } catch (_e) {
      // fallback to raw string
    }

    const opBadge = task.operation === 'move' ? 'Move' : 'Copy';

    card.innerHTML = `
      <div class="scheduled-task-main">
        <div class="scheduled-task-title-line">
          <span class="badge" style="font-size: 11px; text-transform: uppercase;">${escapeHtml(opBadge)}</span>
          <span class="scheduled-task-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        </div>
        <div class="scheduled-task-path" title="${escapeHtml(task.source)}">
          ${escapeHtml(task.source)}
        </div>
        <div class="scheduled-task-path" title="${escapeHtml(task.destination)}">
          → ${escapeHtml(task.destination)}
        </div>
        <div class="scheduled-task-time">
          📅 ${I18n.t('modals.scheduled.scheduled_for', { time: escapeHtml(formattedTime) })}
        </div>
      </div>
      <div class="scheduled-task-actions">
        <button class="btn-sm btn-ghost-danger scheduled-cancel-btn" data-id="${task.task_id}" data-i18n="modals.scheduled.cancel">
          ${I18n.t('modals.scheduled.cancel')}
        </button>
      </div>
    `;

    const cancelBtn = card.querySelector('.scheduled-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmStyled(
          I18n.t('modals.scheduled.confirm_cancel_title'),
          I18n.t('modals.scheduled.confirm_cancel_msg'),
          I18n.t('modals.scheduled.cancel'),
          true
        );
        if (!ok) return;

        try {
          await api(`/api/tasks/${task.task_id}/cancel`, { method: 'POST' });
          showToast(I18n.t('messages.task_cancelled'));
          await loadScheduledTransfers();
        } catch (err) {
          toastError(I18n.t('messages.cancel_failed', { err: err.message }));
        }
      });
    }

    container.appendChild(card);
  }
}

export function initScheduledModal() {
  const modal = el('scheduled-modal');
  const menuBtn = el('menu-scheduled');
  if (!modal || !menuBtn) return;

  const dismissBtns = [el('scheduled-modal-dismiss'), el('scheduled-modal-close')];

  menuBtn.addEventListener('click', async () => {
    const gearMenu = el('gear-menu');
    if (gearMenu) gearMenu.classList.add('hidden');
    modal.classList.remove('hidden');
    await loadScheduledTransfers();
  });

  dismissBtns.forEach((btn) => {
    if (btn) {
      btn.addEventListener('click', () => closeScheduledModal());
    }
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeScheduledModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeScheduledModal();
    }
  });
}

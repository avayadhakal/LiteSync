import { confirmStyled, loadHistory } from './app.js';
import { getPrimaryTitle } from './modals/transfer.js';
import { onTaskFinished } from './app.js';
import { api, toastSuccess, toastError } from './api.js';
import { el, formatSize, escapeHtml } from './utils.js';
import { state } from './state.js';
import { updateSelectionUI } from './panes.js';

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'interrupted']);

export const ACTIVE_STATUSES = new Set(['queued', 'running', 'paused']);

export const activeStreams = new Map(); // taskId -> { source, currentFile, pct }


export function pruneCompletedSelection(task) {
  // Sources of a successfully finished task were moved or copied,
  // so keeping them selected points at stale paths.
  if (!task) return false;
  let changed = false;
  const src = task.source || (Array.isArray(task.sources) ? task.sources[0] : null);
  if (src) {
    state.selection.deletePath(src);
    changed = true;
  }
  return changed;
}

export function renderActiveTransfers() {
  if (state.historyTab !== 'active') return;
  const activeContainer = el('active-transfers-container');

  // Filter active/queued tasks strictly, then order by priority:
  // running (actively copying) cards first, queued cards after.
  // FIFO (created_at ascending) as the tie-breaker within each block.
  const statusRank = (task) => (task.status === 'running' ? 0 : (task.status === 'paused' ? 1 : 2));
  const activeTasks = state.tasks
    .filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'paused')
    .sort((a, b) => {
      const rankDiff = statusRank(a) - statusRank(b);
      if (rankDiff !== 0) return rankDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });

  // Clean up streams for tasks that are no longer active
  const activeTaskIds = new Set(activeTasks.map((t) => t.task_id));
  for (const [id, streamObj] of activeStreams.entries()) {
    if (!activeTaskIds.has(id)) {
      streamObj.source.close();
      activeStreams.delete(id);
    }
  }

  for (const task of activeTasks) {
    if (!activeStreams.has(task.task_id) && (task.status === 'queued' || task.status === 'running' || task.status === 'paused')) {
      attachTaskStream(task);
    }
  }

  activeContainer.innerHTML = '';

  if (activeTasks.length === 0) {
    activeContainer.innerHTML = `<div class="empty-state">No active operations</div>`;
    return;
  }

  for (const task of activeTasks) {
    const card = document.createElement('div');
    card.className = 'transfer-card';
    card.id = `card-${task.task_id}`;

    const primaryTitle = getPrimaryTitle(task.source || task.sources);
    const sourceText = task.source || (Array.isArray(task.sources) ? task.sources.join(', ') : (task.sources || ''));
    const streamData = activeStreams.get(task.task_id);
    const currentPct = streamData ? streamData.pct : 0;
    const currentDetail = task.status === 'paused' ? 'Paused' : (streamData && streamData.currentFile
      ? `Copying: ${streamData.currentFile}`
      : (task.status === 'queued' ? 'Queued...' : 'Starting transfer...'));

    card.innerHTML = `
      <div class="card-top" style="display: flex; justify-content: space-between; align-items: center;">
        <span class="card-title" title="${escapeHtml(primaryTitle)}">${escapeHtml(primaryTitle)}</span>
        <div style="display: flex; align-items: center;">
          <div id="progress-text-${task.task_id}" style="color: #94a3b8; font-size: 13px; font-weight: 600; margin-right: 12px;">
            ${currentPct}%
          </div>
          ${task.status === 'running' && task.use_rsync ? `<button class="btn-sm btn-secondary pause-btn" data-id="${task.task_id}" style="margin-right: 8px;">Pause</button>` : ''}
          ${task.status === 'paused' ? `<button class="btn-sm btn-primary resume-btn" data-id="${task.task_id}" style="margin-right: 8px;">Resume</button>` : ''}
          <button class="btn-sm btn-danger cancel-btn" data-id="${task.task_id}">Cancel</button>
        </div>
      </div>
      <div class="card-path truncate" title="${escapeHtml(sourceText)} ➔ ${escapeHtml(task.destination)}">
        ${escapeHtml(sourceText)} ➔ ${escapeHtml(task.destination)}
      </div>
      <div class="card-details truncate" id="progress-detail-${task.task_id}" style="margin-top: 4px;">
        ${escapeHtml(currentDetail)}
      </div>
      <div class="bg-gray-800 relative overflow-hidden" style="height: 8px; border-radius: 4px; margin-top: 4px;">
        <div class="absolute inset-0" id="progress-fill-${task.task_id}" style="background: var(--accent-dim); width: ${currentPct}%; transition: width 0.2s ease; border-radius: 4px;"></div>
      </div>
    `;

    const pauseBtn = card.querySelector('.pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        pauseBtn.disabled = true;
        pauseBtn.textContent = 'Pausing...';
        try {
          await api(`/api/tasks/${task.task_id}/pause`, { method: 'POST' });
          task.status = 'paused';
          renderActiveTransfers();
        } catch (err) {
          pauseBtn.disabled = false;
          pauseBtn.textContent = 'Pause';
          toastError(`Failed to pause task: ${err.message}`);
        }
      });
    }

    const resumeBtn = card.querySelector('.resume-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        resumeBtn.disabled = true;
        resumeBtn.textContent = 'Resuming...';
        try {
          await api(`/api/tasks/${task.task_id}/resume`, { method: 'POST' });
          
          // The backend puts it in 'queued' state briefly. Poll until it runs.
          let currentStatus = 'queued';
          while (currentStatus === 'queued') {
            await new Promise(r => setTimeout(r, 500));
            const fresh = await api(`/api/tasks/${task.task_id}`);
            currentStatus = fresh.status;
          }
          
          if (currentStatus === 'running') {
            task.status = 'running';
            renderActiveTransfers();
          } else {
            resumeBtn.disabled = false;
            resumeBtn.textContent = 'Resume';
          }
        } catch (err) {
          resumeBtn.disabled = false;
          resumeBtn.textContent = 'Resume';
          toastError(`Failed to resume task: ${err.message}`);
        }
      });
    }

    const cancelBtn = card.querySelector('.cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const title = getPrimaryTitle(task.source || task.sources);
        const ok = await confirmStyled(
          `Cancel transfer: ${title}?`,
          'The active transfer will be stopped.',
          'Cancel Transfer',
          true
        );
        if (!ok) return;
        if (activeStreams.has(task.task_id)) {
          activeStreams.get(task.task_id).source.close();
          activeStreams.delete(task.task_id);
        }
        try {
          await api(`/api/tasks/${task.task_id}/cancel`, { method: 'POST' });
          await onTaskFinished('interrupted', task);
        } catch (err) {
          toastError(`Failed to cancel task: ${err.message}`);
        }
      });
    }

    activeContainer.appendChild(card);

    // Attach SSE stream if running/queued
    attachTaskStream(task);
  }
}

export function attachTaskStream(task) {
  const taskId = task.task_id;
  if (activeStreams.has(taskId)) return;

  const streamData = {
    source: new EventSource(`/api/tasks/${taskId}/stream`),
    currentFile: '',
    pct: 0,
  };
  activeStreams.set(taskId, streamData);

  const source = streamData.source;

  source.onmessage = (e) => {
    const line = e.data;
    const trimmed = line.trim();
    if (!trimmed) return;

    const fillEl = el(`progress-fill-${taskId}`);
    const textEl = el(`progress-text-${taskId}`);
    const detailEl = el(`progress-detail-${taskId}`);

    // Check if line contains rsync progress percentage
    const matches = trimmed.match(/(\d+)%/g);
    if (matches && matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const pct = parseInt(lastMatch.replace('%', ''), 10);
      if (!isNaN(pct)) {
        streamData.pct = pct;
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (textEl) textEl.textContent = `${pct}%`;
        if (detailEl) {
          detailEl.textContent = streamData.currentFile
            ? `Copying: ${streamData.currentFile}`
            : `Syncing...`;
        }
      }
    } else {
      const isRsyncSystemLine =
        trimmed.startsWith('sending incremental') ||
        trimmed.startsWith('sent ') ||
        trimmed.startsWith('total size') ||
        trimmed.startsWith('created directory') ||
        trimmed.startsWith('building file list') ||
        trimmed.startsWith('rsync') ||
        trimmed.startsWith('sh ') ||
        trimmed.includes('bytes/sec');

      if (!isRsyncSystemLine) {
        streamData.currentFile = trimmed;
        if (detailEl) {
          detailEl.textContent = `Copying: ${streamData.currentFile}`;
        }
      }
    }
  };

  source.addEventListener('status', (e) => {
    source.close();
    activeStreams.delete(taskId);

    let status = null;
    try {
      status = JSON.parse(e.data).status;
    } catch (_err) {
      // Malformed payload: still treat the stream as finished below.
    }

    // Task reached a terminal state ('succeeded' | 'failed' | 'interrupted'):
    // prune stale selections, auto-remove the card, refresh both panes.
    onTaskFinished(status, task).catch((err) => console.error('Post-task refresh failed:', err));
  });

  source.onerror = () => {
    source.close();
    activeStreams.delete(taskId);
    loadHistory();
  };
}


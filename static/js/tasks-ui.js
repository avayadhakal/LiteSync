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

function renderCardControlsHtml(task) {
  const isRunning = task.status === 'running';
  const isPaused = task.status === 'paused';
  const isQueued = task.status === 'queued';
  const streamData = activeStreams.get(task.task_id);
  const currentPct = streamData ? streamData.pct : 0;

  let statusBadge = '';
  if (isQueued) {
    statusBadge = `<span id="status-badge-${task.task_id}" class="badge-status-queued" style="color: #94a3b8; font-size: 12px; font-weight: 600; margin-right: 6px;">Queued</span>`;
  } else if (isPaused) {
    statusBadge = `<span id="status-badge-${task.task_id}" class="badge-status-paused" style="color: #f59e0b; font-size: 12px; font-weight: 600; margin-right: 6px;">Paused</span>`;
  } else {
    statusBadge = `<span id="status-badge-${task.task_id}" class="badge-status-running hidden"></span>`;
  }

  let actionBtns = '';
  if (isRunning && task.use_rsync) {
    actionBtns += `<button class="btn-sm btn-secondary pause-btn" data-id="${task.task_id}" style="margin-right: 8px;">Pause</button>`;
  } else if (isPaused) {
    actionBtns += `<button class="btn-sm btn-primary resume-btn" data-id="${task.task_id}" style="margin-right: 8px;">Resume</button>`;
  }
  actionBtns += `<button class="btn-sm btn-danger cancel-btn" data-id="${task.task_id}">Cancel</button>`;

  return `
    <div id="progress-text-${task.task_id}" style="color: #94a3b8; font-size: 13px; font-weight: 600; margin-right: 12px; display: flex; align-items: center;">
      ${statusBadge}
      <span id="progress-pct-${task.task_id}">${currentPct}%</span>
    </div>
    <div id="card-actions-${task.task_id}" style="display: flex; align-items: center;">
      ${actionBtns}
    </div>
  `;
}

function bindCardEventListeners(task, card) {
  const pauseBtn = card.querySelector('.pause-btn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      pauseBtn.disabled = true;
      pauseBtn.textContent = 'Pausing...';
      try {
        await api(`/api/tasks/${task.task_id}/pause`, { method: 'POST' });
        task.status = 'paused';
        updateCardControlsInPlace(task);
        await loadHistory();
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
          await new Promise((r) => setTimeout(r, 500));
          const fresh = await api(`/api/tasks/${task.task_id}`);
          currentStatus = fresh.status;
        }

        if (currentStatus === 'running') {
          task.status = 'running';
          updateCardControlsInPlace(task);
          await loadHistory();
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
}

function parseByteValue(str) {
  if (!str) return 0;
  const s = str.replace(/,/g, '').trim();
  const m = s.match(/^([\d\.]+)\s*([KMGTPkmgtp]?)(?:[iI]?[bB])?$/);
  if (!m) {
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = { '': 1, 'K': 1024, 'M': 1024 * 1024, 'G': 1024 * 1024 * 1024, 'T': 1024 * 1024 * 1024 * 1024, 'P': 1024 * 1024 * 1024 * 1024 * 1024 };
  return val * (mult[unit] || 1);
}

export function updateCardControlsInPlace(task) {
  const card = el(`card-${task.task_id}`);
  if (!card) return;

  const topControls = el(`top-controls-${task.task_id}`);
  if (topControls) {
    topControls.innerHTML = renderCardControlsHtml(task);
    bindCardEventListeners(task, card);
  }

  const detailEl = el(`progress-detail-${task.task_id}`);
  if (detailEl) {
    const streamData = activeStreams.get(task.task_id);
    if (task.status === 'paused') {
      detailEl.textContent = 'Paused';
    } else if (task.status === 'queued') {
      detailEl.textContent = 'Queued...';
    } else if (streamData && streamData.currentFile) {
      detailEl.textContent = `Copying: ${streamData.currentFile}`;
    } else {
      detailEl.textContent = 'Starting transfer...';
    }
  }

  const speedEl = el(`progress-speed-${task.task_id}`);
  if (speedEl) {
    if (task.status === 'paused') {
      speedEl.textContent = '—';
    } else if (task.status === 'queued') {
      speedEl.textContent = '';
    }
  }
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
    const currentSize = streamData && streamData.sizeText ? streamData.sizeText : '';
    const currentSpeed = streamData && streamData.speed ? streamData.speed : (task.status === 'paused' ? '—' : '');

    card.innerHTML = `
      <div class="card-top" style="display: flex; justify-content: space-between; align-items: center;">
        <span class="card-title" title="${escapeHtml(primaryTitle)}">${escapeHtml(primaryTitle)}</span>
        <div id="top-controls-${task.task_id}" style="display: flex; align-items: center;">
          ${renderCardControlsHtml(task)}
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
      <div class="card-stats" id="progress-stats-${task.task_id}" style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-dim); margin-top: 4px; font-family: ui-monospace, monospace;">
        <span id="progress-size-${task.task_id}">${escapeHtml(currentSize)}</span>
        <span id="progress-speed-${task.task_id}" class="card-speed">${escapeHtml(currentSpeed)}</span>
      </div>
    `;

    bindCardEventListeners(task, card);

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
    speed: '',
    sizeText: '',
  };
  activeStreams.set(taskId, streamData);

  const source = streamData.source;

  source.onmessage = (e) => {
    const line = e.data;
    const trimmed = line.trim();
    if (!trimmed) return;

    const fillEl = el(`progress-fill-${taskId}`);
    const pctEl = el(`progress-pct-${taskId}`);
    const detailEl = el(`progress-detail-${taskId}`);
    const sizeEl = el(`progress-size-${taskId}`);
    const speedEl = el(`progress-speed-${taskId}`);

    const isDownload = task.operation === 'url_download';

    // 1. Extract speed if present (e.g. 12.50MB/s or 500kB/s or 24.5 MB/s)
    const speedMatch = trimmed.match(/([\d\.]+\s*(?:[KMGTPkmgtp]?[bB]\/s|bytes\/s))/i);
    if (speedMatch) {
      streamData.speed = speedMatch[1].replace(/\s+/g, '');
      if (speedEl) speedEl.textContent = streamData.speed;
    }

    // 2. Extract copied and total size if present
    // Format A: "157286400/1048576000" or "150MB/1.2GB"
    const slashMatch = trimmed.match(/([\d\.,]+[KMGTPkmgtp]?B?)\s*\/\s*([\d\.,]+[KMGTPkmgtp]?B?)/i);
    if (slashMatch) {
      const b1 = parseByteValue(slashMatch[1]);
      const b2 = parseByteValue(slashMatch[2]);
      if (b1 > 0 && b2 > 0) {
        streamData.sizeText = `${formatSize(b1)} / ${formatSize(b2)}`;
        if (sizeEl) sizeEl.textContent = streamData.sizeText;
      }
    }

    // Format B: rsync progress line "<copied_token> <pct>% <speed> <eta>"
    const rsyncProgMatch = trimmed.match(/^\s*([\d\.,]+[KMGTPkmgtp]?B?)\s+(\d+)%\s+([\d\.,]+[KMGTPkmgtp]?B?\/s)/i);
    if (rsyncProgMatch) {
      const copiedBytes = parseByteValue(rsyncProgMatch[1]);
      const pctVal = parseInt(rsyncProgMatch[2], 10);
      if (pctVal > 0 && copiedBytes > 0 && !slashMatch) {
        const totalBytes = Math.round(copiedBytes / (pctVal / 100));
        streamData.sizeText = `${formatSize(copiedBytes)} / ${formatSize(totalBytes)}`;
        if (sizeEl) sizeEl.textContent = streamData.sizeText;
      }
    }

    // Check if line contains progress percentage
    const matches = trimmed.match(/(\d+)%/g);
    if (matches && matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const pct = parseInt(lastMatch.replace('%', ''), 10);
      if (!isNaN(pct)) {
        streamData.pct = pct;
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (detailEl) {
          detailEl.textContent = isDownload
            ? (streamData.currentFile || 'Downloading...')
            : (streamData.currentFile ? `Copying: ${streamData.currentFile}` : 'Syncing...');
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
          detailEl.textContent = isDownload ? trimmed : `Copying: ${trimmed}`;
        }
      }
    }
  };

  source.addEventListener('status', (e) => {
    let status = null;
    try {
      status = JSON.parse(e.data).status;
    } catch (_err) {
      // Malformed payload
    }

    if (TERMINAL_STATUSES.has(status)) {
      source.close();
      activeStreams.delete(taskId);
      // Task reached a terminal state ('succeeded' | 'failed' | 'interrupted'):
      // prune stale selections, auto-remove the card, refresh both panes.
      onTaskFinished(status, task).catch((err) => console.error('Post-task refresh failed:', err));
    } else if (status) {
      // Non-terminal transition: queued -> running or running -> paused / queued
      task.status = status;
      updateCardControlsInPlace(task);
    }
  });

  source.onerror = () => {
    source.close();
    activeStreams.delete(taskId);
    loadHistory();
  };
}


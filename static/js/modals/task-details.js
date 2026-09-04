import { state } from '../state.js';
import { activeStreams } from '../tasks-ui.js';
import { getPrimaryTitle } from './transfer.js';

let openDetailsTaskId = null;

export function isTaskDetailsOpen() {
  return openDetailsTaskId !== null;
}

export function getOpenDetailsTaskId() {
  return openDetailsTaskId;
}

export function openTaskDetailsModal(taskId) {
  openDetailsTaskId = taskId;
  const modal = document.getElementById('task-details-modal');
  if (!modal) return;
  const task = state.tasks.find((t) => t.task_id === taskId);
  const title = task ? getPrimaryTitle(task.source || task.sources) : 'Transfer Details';
  document.getElementById('task-details-title').textContent = title;
  renderTaskDetailsModal(taskId);
  modal.classList.remove('hidden');
}

export function closeTaskDetailsModal() {
  openDetailsTaskId = null;
  const modal = document.getElementById('task-details-modal');
  if (modal) modal.classList.add('hidden');
}

// Full re-render of the file list (called on file name transitions).
export function renderTaskDetailsModal(taskId) {
  const streamData = activeStreams.get(taskId);
  const task = state.tasks.find((t) => t.task_id === taskId);
  const list = document.getElementById('task-details-file-list');
  if (!list) return;

  const frag = document.createDocumentFragment();

  if (streamData && streamData.fileLog.length > 0) {
    for (const entry of streamData.fileLog) {
      const row = document.createElement('div');
      row.className = 'task-details-file-row task-details-file-done';
      const statusSpan = document.createElement('span');
      statusSpan.className = 'task-details-file-status';
      statusSpan.textContent = '✓';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'task-details-file-name';
      nameSpan.textContent = entry.name;
      nameSpan.title = entry.name;
      row.appendChild(statusSpan);
      row.appendChild(nameSpan);
      frag.appendChild(row);
    }
  }

  // Currently-active file row
  if (streamData && streamData.currentFile && task && task.status === 'running') {
    const row = document.createElement('div');
    row.className = 'task-details-file-row task-details-file-active';
    const statusSpan = document.createElement('span');
    statusSpan.className = 'task-details-file-status task-details-pulse';
    statusSpan.textContent = '◉';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'task-details-file-name';
    nameSpan.textContent = streamData.currentFile;
    nameSpan.title = streamData.currentFile;
    row.appendChild(statusSpan);
    row.appendChild(nameSpan);
    frag.appendChild(row);
  }

  if (frag.childElementCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'task-details-empty';
    empty.textContent = task && task.status === 'queued'
      ? 'Queued — waiting to start…'
      : 'No files yet…';
    frag.appendChild(empty);
  }

  list.innerHTML = '';
  list.appendChild(frag);
  // Auto-scroll to show the latest entry (active file at bottom)
  list.scrollTop = list.scrollHeight;

  refreshTaskDetailsProgress(taskId);
}

// Lightweight stats-only update — called on every pct tick while modal is open.
// Uses transform: scaleX() to avoid layout recalculation.
export function refreshTaskDetailsProgress(taskId) {
  const streamData = activeStreams.get(taskId);
  const task = state.tasks.find((t) => t.task_id === taskId);
  if (!streamData && !task) return;

  const fill = document.getElementById('task-details-progress-fill');
  const pctEl = document.getElementById('task-details-progress-pct');
  const speedEl = document.getElementById('task-details-speed');
  const sizeEl = document.getElementById('task-details-size');
  const statusEl = document.getElementById('task-details-status-badge');

  const pct = streamData ? streamData.pct : 0;
  const speed = streamData ? streamData.speed : '';
  const sizeText = streamData ? streamData.sizeText : '';
  const statusLabel = !task ? '' :
    task.status === 'paused' ? 'Paused' :
    task.status === 'queued' ? 'Queued' : 'Transferring';

  if (fill) fill.style.transform = `scaleX(${pct / 100})`;
  if (pctEl && pctEl.textContent !== `${pct}%`) pctEl.textContent = `${pct}%`;
  if (speedEl && speedEl.textContent !== speed) speedEl.textContent = speed;
  if (sizeEl && sizeEl.textContent !== sizeText) sizeEl.textContent = sizeText;
  if (statusEl && statusEl.textContent !== statusLabel) statusEl.textContent = statusLabel;
}

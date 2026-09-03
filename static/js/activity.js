import { api, toastSuccess, toastError, copyToClipboard } from './api.js';
import { el, escapeHtml, normalizePath } from './utils.js';
import { state } from './state.js';

export async function loadActivity() {
  try {
    const data = await api('/api/activity?limit=100');
    state.activity = data.activity || [];
    renderActivity();
  } catch (err) {
    console.error('Failed to load activity:', err);
  }
}

export async function clearActivity() {
  try {
    await api('/api/activity', { method: 'DELETE' });
    state.activity = [];
    renderActivity();
    toastSuccess('Activity log cleared.');
  } catch (err) {
    toastError(`Failed to clear activity log: ${err.message}`);
  }
}

function formatActivityTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const now = new Date();
  const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function parseActivityMessage(rawMsg, kind) {
  if (typeof rawMsg === 'object' && rawMsg !== null) {
    return rawMsg;
  }
  if (typeof rawMsg === 'string') {
    const trimmed = rawMsg.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        return JSON.parse(trimmed);
      } catch (_err) {}
    }
  }
  // Fallback for legacy plain text messages
  return {
    operation: kind || 'info',
    status: 'succeeded',
    name: String(rawMsg || ''),
    summary: String(rawMsg || ''),
  };
}

function getActivityDisplayInfo(entry) {
  const data = parseActivityMessage(entry.message, entry.kind);
  const op = (data.operation || entry.kind || 'info').toLowerCase();
  const status = (data.status || 'succeeded').toLowerCase();

  let icon = '✓';
  let badgeText = 'SUCCESS';
  let statusClass = 'status-succeeded';
  let primaryText = data.name || data.summary || data.path || 'Operation';
  let secondaryHtml = '';

  if (op === 'move') {
    badgeText = 'Moved';
    if (status === 'succeeded') {
      icon = '✓';
      statusClass = 'status-succeeded';
      const dst = data.destination ? normalizePath(data.destination).split('/').pop() || data.destination : '';
      secondaryHtml = `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst || data.destination || '')}</span> <span class="activity-tag">[source deleted]</span>`;
    } else if (status === 'interrupted') {
      icon = '⊘';
      badgeText = 'Interrupted — Move';
      statusClass = 'status-interrupted';
      secondaryHtml = escapeHtml(data.summary || data.error || 'cancelled by user');
    } else {
      icon = '✗';
      badgeText = 'Failed — Move';
      statusClass = 'status-failed';
      secondaryHtml = escapeHtml(data.summary || data.error || 'rsync exited with error');
    }
  } else if (op === 'copy' || op === 'transfer') {
    badgeText = 'Copied';
    if (status === 'succeeded') {
      icon = '✓';
      statusClass = 'status-succeeded';
      const dst = data.destination ? normalizePath(data.destination).split('/').pop() || data.destination : '';
      secondaryHtml = `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst || data.destination || '')}</span>`;
    } else if (status === 'interrupted') {
      icon = '⊘';
      badgeText = 'Interrupted — Copy';
      statusClass = 'status-interrupted';
      secondaryHtml = escapeHtml(data.summary || data.error || 'cancelled by user');
    } else {
      icon = '✗';
      badgeText = 'Failed — Copy';
      statusClass = 'status-failed';
      secondaryHtml = escapeHtml(data.summary || data.error || 'rsync exited with error');
    }
  } else if (op === 'mkdir') {
    icon = '+';
    badgeText = 'Created Folder';
    statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
    primaryText = data.summary || data.name || data.path;
    if (status === 'failed') {
      icon = '✗';
      badgeText = 'Failed — New Folder';
      secondaryHtml = escapeHtml(data.error || 'Failed to create directory');
    }
  } else if (op === 'rename') {
    icon = '→';
    badgeText = 'Renamed';
    statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
    primaryText = data.summary || (data.old_name ? `<span style="font-family: ui-monospace, monospace;">${escapeHtml(data.old_name)}</span> → <span style="font-family: ui-monospace, monospace;">${escapeHtml(data.new_name)}</span>` : data.name);
    if (status === 'failed') {
      icon = '✗';
      badgeText = 'Failed — Rename';
      secondaryHtml = escapeHtml(data.error || 'Failed to rename');
    }
  } else if (op === 'delete') {
    icon = '🗑';
    badgeText = 'Deleted';
    statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
    primaryText = data.name || (data.path ? normalizePath(data.path).split('/').pop() : 'item');
    if (status === 'failed') {
      icon = '✗';
      badgeText = 'Failed — Delete';
      secondaryHtml = escapeHtml(data.error || 'Failed to delete');
    }
  } else if (op === 'url_download') {
    const dst = data.destination ? normalizePath(data.destination) : '';
    let host = '';
    if (data.source) {
      try {
        const u = new URL(data.source);
        host = u.hostname;
      } catch (_) {
        host = data.source;
      }
    }
    if (status === 'succeeded') {
      icon = '⬇';
      badgeText = 'Downloaded';
      statusClass = 'status-succeeded';
      primaryText = data.name || (data.path ? normalizePath(data.path).split('/').pop() : 'file');
      secondaryHtml = dst ? `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst)}</span> ${host ? `<span class="activity-tag">(from ${escapeHtml(host)})</span>` : ''}` : '';
    } else if (status === 'interrupted') {
      icon = '⊘';
      badgeText = 'Interrupted — Download';
      statusClass = 'status-interrupted';
      primaryText = data.name || 'file';
      secondaryHtml = escapeHtml(data.summary || data.error || 'cancelled by user');
    } else {
      icon = '✗';
      badgeText = 'Download Failed';
      statusClass = 'status-failed';
      primaryText = data.name || 'file';
      const reason = data.error || data.summary || 'Download failed';
      secondaryHtml = dst ? `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst)}</span><br><span style="color: var(--danger); font-size: 11px;">${escapeHtml(reason)}</span>` : `<span style="color: var(--danger); font-size: 11px;">${escapeHtml(reason)}</span>`;
    }
  } else if (op === 'upload') {
    const dst = data.destination ? normalizePath(data.destination) : '';
    if (status === 'succeeded') {
      icon = '⬆';
      badgeText = 'Uploaded';
      statusClass = 'status-succeeded';
      primaryText = data.name || (data.path ? normalizePath(data.path).split('/').pop() : 'file');
      secondaryHtml = dst ? `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst)}</span>` : '';
    } else {
      icon = '✗';
      badgeText = 'Upload Failed';
      statusClass = 'status-failed';
      primaryText = data.name || 'file';
      const reason = data.error || data.summary || 'Upload failed';
      secondaryHtml = dst ? `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst)}</span><br><span style="color: var(--danger); font-size: 11px;">${escapeHtml(reason)}</span>` : `<span style="color: var(--danger); font-size: 11px;">${escapeHtml(reason)}</span>`;
    }
  } else if (op === 'edit' || op === 'edited') {
    const dst = data.destination ? normalizePath(data.destination) : '';
    icon = '✎';
    badgeText = 'Edited';
    statusClass = status === 'failed' ? 'status-failed' : 'status-succeeded';
    primaryText = data.name || (data.path ? normalizePath(data.path).split('/').pop() : 'file');
    secondaryHtml = dst ? `→ <span style="font-family: ui-monospace, monospace;">${escapeHtml(dst)}</span>` : '';
    if (status === 'failed') {
      icon = '✗';
      badgeText = 'Failed — Edit';
      secondaryHtml = escapeHtml(data.error || 'Failed to edit file');
    }
  } else {
    badgeText = (entry.kind || 'Info').charAt(0).toUpperCase() + (entry.kind || 'Info').slice(1).toLowerCase();
    statusClass = 'status-info';
    primaryText = data.summary || data.name || String(entry.message);
  }

  if (op !== 'rename' && (!data.summary || data.name || data.path)) {
     // Wrap primaryText in monospace if it's likely a file/path name and not a summary sentence
     if (!data.summary || primaryText === data.name || primaryText === data.path || (primaryText !== 'Operation' && primaryText !== 'file' && primaryText !== 'item' && String(primaryText).indexOf(' ') === -1)) {
        primaryText = `<span style="font-family: ui-monospace, monospace;">${escapeHtml(primaryText)}</span>`;
     } else {
        primaryText = escapeHtml(primaryText);
     }
  } else if (op !== 'rename') {
     primaryText = escapeHtml(primaryText);
  }

  let badgeClass = 'badge-info';
  if (status === 'failed') {
    badgeClass = 'badge-danger';
  } else if (status === 'interrupted') {
    badgeClass = 'badge-warning';
  } else {
    if (op === 'delete' || op === 'removed') badgeClass = 'badge-danger';
    else if (op === 'upload' || op === 'url_download' || op === 'copy' || op === 'transfer') badgeClass = 'badge-success';
    else if (op === 'rename' || op === 'move' || op === 'edit' || op === 'edited') badgeClass = 'badge-info';
  }

  return {
    icon,
    badgeText,
    badgeClass,
    statusClass,
    primaryText,
    secondaryHtml,
    data,
  };
}

export function renderActivity() {
  const container = el('activity-container');
  if (!container) return;
  container.innerHTML = '';

  const clearBtn = el('clear-activity-btn');
  if (clearBtn && state.historyTab === 'activity') {
    clearBtn.classList.toggle('hidden', state.activity.length === 0);
  }

  if (state.activity.length === 0) {
    container.innerHTML = `<div class="empty-state">No activity yet</div>`;
    return;
  }

  for (const entry of state.activity) {
    const info = getActivityDisplayInfo(entry);
    const card = document.createElement('div');
    card.className = `activity-card ${info.statusClass}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    
    card.innerHTML = `
      <div class="log-info">
        <span class="badge ${info.badgeClass}">${escapeHtml(info.badgeText)}</span>
        <div class="log-text">
          <span class="activity-primary-line" title="Operation">${info.primaryText}</span>
          ${info.secondaryHtml ? `<span class="activity-secondary-line">${info.secondaryHtml}</span>` : ''}
        </div>
      </div>
      <div class="log-meta">
        <span class="activity-time">${escapeHtml(formatActivityTime(entry.created_at || entry.ts))}</span>
        <button class="activity-details-btn" title="View Details">Details</button>
      </div>
    `;

    const openDetails = (e) => {
      e.stopPropagation();
      openActivityDetails(entry, info);
    };

    card.addEventListener('click', openDetails);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetails(e);
      }
    });

    const detailsBtn = card.querySelector('.activity-details-btn');
    if (detailsBtn) {
      detailsBtn.addEventListener('click', openDetails);
    }

    container.appendChild(card);
  }
  filterActivity();
}

export function filterActivity() {
  const searchInput = el('activity-search');
  if (!searchInput) return;
  const query = searchInput.value.toLowerCase();
  const container = el('activity-container');
  if (!container) return;
  const cards = container.querySelectorAll('.activity-card');
  for (const card of cards) {
    if (card.textContent.toLowerCase().includes(query)) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  }
}

export function openActivityDetails(entry, info) {
  const modal = el('activity-details-modal');
  const body = el('activity-details-body');
  if (!modal || !body) return;

  if (!info) info = getActivityDisplayInfo(entry);
  const data = info.data || {};
  const createdStr = entry.created_at || (entry.ts ? new Date(entry.ts).toISOString() : '');

  const rows = [];
  rows.push({ label: 'Timestamp', value: `${formatActivityTime(createdStr)} (${createdStr})` });
  rows.push({ label: 'Operation', value: (data.operation || entry.kind || 'unknown').toUpperCase() });
  rows.push({ label: 'Status', value: (data.status || 'succeeded').toUpperCase() });

  if (data.source) {
    rows.push({ label: 'Source Path', value: data.source, copyable: true });
  }
  if (data.destination) {
    rows.push({ label: 'Destination', value: data.destination, copyable: true });
  }
  if (data.old_path) {
    rows.push({ label: 'Original Path', value: data.old_path, copyable: true });
  }
  if (data.new_path) {
    rows.push({ label: 'New Path', value: data.new_path, copyable: true });
  }
  if (data.path && !data.source && !data.destination && !data.old_path) {
    rows.push({ label: 'Path', value: data.path, copyable: true });
  }
  if (data.exit_code !== undefined && data.exit_code !== null) {
    rows.push({ label: 'Exit Code', value: String(data.exit_code) });
  }
  if (data.summary) {
    rows.push({ label: 'Summary', value: data.summary });
  }

  body.innerHTML = '';
  for (const r of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'activity-details-row';
    const labelEl = document.createElement('div');
    labelEl.className = 'activity-details-label';
    labelEl.textContent = r.label;
    const valEl = document.createElement('div');
    valEl.className = 'activity-details-value';

    if (r.copyable) {
      valEl.className += ' activity-details-copyable';
      const textSpan = document.createElement('span');
      textSpan.textContent = r.value;
      textSpan.style.wordBreak = 'break-all';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'icon-btn';
      copyBtn.innerHTML = '📋';
      copyBtn.title = 'Copy path';
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await copyToClipboard(r.value);
          copyBtn.innerHTML = '✓';
          copyBtn.style.color = 'var(--success)';
          toastSuccess('Copied to clipboard');
          setTimeout(() => {
            copyBtn.innerHTML = '📋';
            copyBtn.style.color = '';
          }, 1500);
        } catch (_err) {}
      });
      valEl.appendChild(textSpan);
      valEl.appendChild(copyBtn);
    } else {
      valEl.textContent = r.value;
    }

    rowEl.appendChild(labelEl);
    rowEl.appendChild(valEl);
    body.appendChild(rowEl);
  }

  if (data.error) {
    const errBox = document.createElement('div');
    errBox.className = 'activity-details-error';
    errBox.textContent = `Error: ${data.error}`;
    body.appendChild(errBox);
  }

  modal.classList.remove('hidden');
}

export function closeActivityDetails() {
  const modal = el('activity-details-modal');
  if (modal) modal.classList.add('hidden');
}


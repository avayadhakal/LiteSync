import { el } from './utils.js';
export async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401 || res.status === 303) {
    window.location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function showToast(msg, kind = 'info', timeoutMs = 4000) {
  const stack = el('toast-stack');
  if (!stack) return null;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  stack.appendChild(t);
  const dismiss = () => {
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 220);
  };
  t.addEventListener('click', dismiss);
  if (timeoutMs > 0) setTimeout(dismiss, timeoutMs);
  // Cap stack size to avoid unbounded growth on rapid events.
  while (stack.children.length > 5) stack.firstChild.remove();
  return t;
}

export function toastSuccess(msg) { showToast(msg, 'success'); }
export function toastError(msg)   { showToast(msg, 'error'); }


export async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    // Fallback for plain HTTP / non-localhost IP contexts
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const successful = document.execCommand('copy');
    textArea.remove();

    if (!successful) {
      throw new Error("Copy command failed");
    }
  }
}

export async function copyDownloadLink(path) {
  try {
    const data = await api(`/api/download/link?path=${encodeURIComponent(path)}`);
    const fullUrl = new URL(data.url, window.location.origin).href;
    await copyToClipboard(fullUrl);
    toastSuccess('Download link copied');
    return true;
  } catch (err) {
    toastError(err.message || 'Failed to copy link');
    return false;
  }
}

export function attachLongPress(element, onLongPress) {
  let startX = 0;
  let startY = 0;
  let timer = null;
  let longPressed = false;
  const MOVE_THRESHOLD = 10; // 10px

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  element.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    longPressed = false;

    cancel();
    timer = setTimeout(() => {
      longPressed = true;
      timer = null;
      onLongPress();
    }, 500);
  }, { passive: true });

  element.addEventListener('touchmove', (e) => {
    if (!timer || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - startX);
    const dy = Math.abs(touch.clientY - startY);
    if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
      cancel();
    }
  }, { passive: true });

  const endOrCancel = () => {
    cancel();
  };

  element.addEventListener('touchend', endOrCancel, { passive: true });
  element.addEventListener('touchcancel', endOrCancel, { passive: true });

  return () => {
    const wasTriggered = longPressed;
    longPressed = false;
    return wasTriggered;
  };
}


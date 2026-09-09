const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.detail || 'Login failed';
      return;
    }
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = 'Network error';
  }
});

(function() {
  const theme = localStorage.getItem('litesync-theme') || 'system';
  const isSystemLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  if (theme === 'light' || (theme === 'system' && isSystemLight)) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();

if (localStorage.getItem('litesync-dual-pane') !== 'true') {
  document.body.classList.add('single-pane');
}

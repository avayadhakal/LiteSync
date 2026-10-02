(function() {
  const root = document.documentElement;
  try {
    const theme = localStorage.getItem('litesync-theme') || 'system';
    const isSystemLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    if (theme === 'light' || (theme === 'system' && isSystemLight)) {
      root.setAttribute('data-theme', 'light');
    }

    if (localStorage.getItem('litesync_mobile_bookmarks_collapsed') === 'true') {
      root.classList.add('mobile-bookmarks-collapsed');
    }
    if (localStorage.getItem('litesync_mobile_operations_collapsed') === 'true' || localStorage.getItem('litesync_mobile_activity_collapsed') === 'true') {
      root.classList.add('mobile-operations-collapsed');
    }

    const mbh = localStorage.getItem('litesync_mobile_bookmarks_height');
    if (mbh) {
      root.style.setProperty('--mobile-bookmarks-height', `${mbh}px`);
    }

    const mah = localStorage.getItem('litesync_mobile_activity_height');
    if (mah) {
      root.style.setProperty('--mobile-activity-height', `${mah}px`);
    }
  } catch (e) {}
})();

if (document.body) {
  if (localStorage.getItem('litesync-dual-pane') !== 'true') {
    document.body.classList.add('single-pane');
  }

  if (localStorage.getItem('litesync_right_panel_collapsed') === 'true') {
    document.body.classList.add('right-panel-collapsed');
  }
}

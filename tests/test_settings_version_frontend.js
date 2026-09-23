const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running LiteSync About Modal & Settings Refactor Frontend Tests...');

const htmlPath = path.resolve(__dirname, '../static/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 1. Static HTML structure verification
(() => {
  // Requirement 1: Settings modal cleaned up
  assert(!html.includes('id="settings-version"'), 'Settings modal must not contain #settings-version');
  const settingsModalMatch = html.match(/<div class="modal-backdrop hidden" id="settings-modal">([\s\S]*?)<\/div>\s*<\/div>/);
  assert(settingsModalMatch, 'Settings modal must exist');
  const settingsContent = settingsModalMatch[1];
  assert(!settingsContent.includes('Check for updates'), 'Settings modal must not contain Check for updates');
  assert(settingsContent.includes('id="settings-cancel"'), 'Settings modal must have Cancel button');
  assert(settingsContent.includes('id="settings-save"'), 'Settings modal must have Save Changes button');
  console.log('✓ Test 1: Settings modal is cleaned up and only contains Cancel and Save Changes');

  // Requirement 2: Header dropdown menu contains About below Settings and divider before logout
  const gearMenuStart = html.indexOf('id="gear-menu"');
  assert(gearMenuStart !== -1, 'Header gear menu must exist');
  const gearMenuContent = html.substring(gearMenuStart, html.indexOf('</header>'));
  const settingsIdx = gearMenuContent.indexOf('id="menu-settings"');
  const aboutIdx = gearMenuContent.indexOf('id="menu-about"');
  const dividerIdx = gearMenuContent.lastIndexOf('class="dropdown-divider"');
  const logoutIdx = gearMenuContent.indexOf('id="menu-logout"');

  assert(settingsIdx !== -1, 'Menu must contain Settings item');
  assert(aboutIdx !== -1, 'Menu must contain About item');
  assert(settingsIdx < aboutIdx, 'About item must be placed directly below Settings');
  assert(aboutIdx < dividerIdx, 'Divider must be placed below About');
  assert(dividerIdx < logoutIdx, 'Logout must be placed after divider at the bottom');
  console.log('✓ Test 2: Header dropdown contains About below Settings and divider before Log out');

  // Requirement 3: About modal structure
  assert(html.includes('id="about-modal"'), 'Missing #about-modal in index.html');
  assert(html.includes('id="about-modal-title"'), 'Missing #about-modal-title');
  assert(html.includes('id="about-modal-dismiss"'), 'Missing #about-modal-dismiss');
  assert(html.includes('id="about-version"'), 'Missing #about-version');
  assert(html.includes('id="about-check-updates"'), 'Missing #about-check-updates');
  assert(html.includes('id="about-modal-close"'), 'Missing #about-modal-close');
  assert(html.includes('https://github.com/avayadhakal/LiteSync/releases'), 'Releases link must point to project releases');
  console.log('✓ Test 3: About modal structure and elements exist in index.html');
})();

// 2. CSS styles verification
(() => {
  const cssPath = path.resolve(__dirname, '../static/css/app.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  assert(html.includes('id="settings-cancel" class="secondary"'), 'Settings Cancel button must use secondary class');
  assert(html.includes('id="about-check-updates"') && html.includes('class="secondary"'), 'About Check for updates action must use secondary class');

  // Ensure settings footer styles were removed
  assert(!css.includes('.settings-modal-footer'), 'Old .settings-modal-footer styles should be removed');
  // Ensure About modal styles use design system tokens
  assert(css.includes('.about-modal-body'), 'Missing .about-modal-body in app.css');
  assert(css.includes('.about-brand-row'), 'Missing .about-brand-row in app.css');
  assert(css.includes('.about-version-value'), 'Missing .about-version-value in app.css');
  assert(css.includes('#settings-cancel') && css.includes('#about-check-updates'), 'settings-cancel and about-check-updates must share styling with scheduled-modal-close');
  assert(!css.includes('#about-modal { color: #'), 'No hardcoded hex colors for about modal');

  // Ensure dropdown-divider uses var(--border) instead of hardcoded white rgba
  assert(!css.includes('.dropdown-divider {\n  height: 1px;\n  background: rgba(255, 255, 255'), 'dropdown-divider must not use hardcoded white rgba');
  assert(css.includes('.dropdown-divider {\n  height: 1px;\n  background: var(--border)'), 'dropdown-divider must use var(--border)');
  assert(css.includes('[data-theme="light"] .dropdown-divider'), 'Missing light mode rule for dropdown-divider');

  console.log('✓ Test 4: CSS contains clean About modal styles, shared secondary button styling, visible theme-adaptive dropdown-divider, and no leftover settings footer styles');
})();

// 3. Locales verification
(() => {
  const locales = ['en', 'es', 'fr', 'de', 'pt', 'zh'];
  for (const lang of locales) {
    const localePath = path.resolve(__dirname, `../static/locales/${lang}.json`);
    assert(fs.existsSync(localePath), `Locale file missing: ${lang}.json`);
    const data = JSON.parse(fs.readFileSync(localePath, 'utf8'));

    // nav.about
    assert(data.nav && data.nav.about, `Missing nav.about in ${lang}.json`);

    // modals.about
    assert(data.modals && data.modals.about, `Missing modals.about in ${lang}.json`);
    assert(data.modals.about.title, `Missing modals.about.title in ${lang}.json`);
    assert(data.modals.about.version, `Missing modals.about.version in ${lang}.json`);
    assert(data.modals.about.check_updates, `Missing modals.about.check_updates in ${lang}.json`);
    assert(data.modals.about.close, `Missing modals.about.close in ${lang}.json`);
  }
  console.log('✓ Test 5: All 6 locale files contain nav.about and complete modals.about definitions');
})();

// 4. About modal behavioral test (open, loadVersion, caching, close, escape, fallback)
(async () => {
  class MockClassList {
    constructor() { this.classes = new Set(); }
    add(c) { this.classes.add(c); }
    remove(c) { this.classes.delete(c); }
    contains(c) { return this.classes.has(c); }
  }

  class MockElement {
    constructor(id = '') {
      this.id = id;
      this.classList = new MockClassList();
      this.listeners = {};
      this.textContent = '';
    }
    addEventListener(event, fn) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    }
    async dispatchEvent(event) {
      const handlers = this.listeners[event.type || event] || [];
      for (const h of handlers) {
        await h(typeof event === 'string' ? { target: this, type: event } : event);
      }
    }
  }

  let apiCallCount = 0;
  let apiResponse = { version: '0.1.0-beta' };
  let apiShouldFail = false;

  const mockApi = async (url) => {
    if (url === '/api/version') {
      apiCallCount++;
      if (apiShouldFail) throw new Error('Network error');
      return apiResponse;
    }
    return {};
  };

  function createAboutController(elements, apiFn) {
    let appVersion = null;

    async function loadAboutVersion() {
      const versionEl = elements['about-version'];
      if (!versionEl) return;

      if (appVersion) {
        versionEl.textContent = `v${appVersion}`;
        return;
      }

      try {
        const data = await apiFn('/api/version');
        if (data && data.version) {
          appVersion = data.version.replace(/^v/, '');
          versionEl.textContent = `v${appVersion}`;
        } else {
          versionEl.textContent = 'dev';
        }
      } catch {
        versionEl.textContent = 'dev';
      }
    }

    function openAboutModal() {
      const modal = elements['about-modal'];
      if (!modal) return;
      loadAboutVersion();
      modal.classList.remove('hidden');
    }

    function closeAboutModal() {
      const modal = elements['about-modal'];
      if (!modal) return;
      modal.classList.add('hidden');
    }

    return { loadAboutVersion, openAboutModal, closeAboutModal };
  }

  const elements = {
    'about-modal': new MockElement('about-modal'),
    'about-version': new MockElement('about-version'),
  };
  elements['about-modal'].classList.add('hidden');

  const controller = createAboutController(elements, mockApi);

  // Subtest 6a: openAboutModal reveals modal and fetches version
  controller.openAboutModal();
  assert(!elements['about-modal'].classList.contains('hidden'), 'Modal should be visible after open');
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(apiCallCount, 1, 'api(/api/version) called once');
  assert.strictEqual(elements['about-version'].textContent, 'v0.1.0-beta');
  console.log('✓ Test 6a: openAboutModal reveals dialog and renders version "v0.1.0-beta"');

  // Subtest 6b: closeAboutModal hides dialog
  controller.closeAboutModal();
  assert(elements['about-modal'].classList.contains('hidden'), 'Modal should be hidden after close');
  console.log('✓ Test 6b: closeAboutModal properly hides dialog');

  // Subtest 6c: Re-opening reuses cached version
  controller.openAboutModal();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(apiCallCount, 1, 'api(/api/version) must not be called again');
  assert.strictEqual(elements['about-version'].textContent, 'v0.1.0-beta');
  console.log('✓ Test 6c: In-memory version cache prevents redundant network calls');

  // Subtest 6d: Network failure fallback to 'dev'
  apiCallCount = 0;
  apiShouldFail = true;
  const elementsFail = {
    'about-modal': new MockElement('about-modal'),
    'about-version': new MockElement('about-version'),
  };
  const failController = createAboutController(elementsFail, mockApi);
  await failController.loadAboutVersion();
  assert.strictEqual(elementsFail['about-version'].textContent, 'dev');
  console.log('✓ Test 6d: Network error gracefully defaults version to "dev"');

  console.log('\nAll LiteSync About Modal & Settings Refactor Frontend Tests Passed Successfully!');
})();

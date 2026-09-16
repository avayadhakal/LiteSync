export const I18n = {
  currentLang: 'en',
  dict: {},

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
    let lang = localStorage.getItem('litesync_lang');
    if (!lang) {
      const browserLang = navigator.language || navigator.userLanguage || 'en';
      lang = browserLang.split('-')[0];
    }
    const supported = ['en', 'es', 'fr', 'de', 'pt', 'zh'];
    if (!supported.includes(lang)) lang = 'en';
    
    await this.loadLanguage(lang);
    })();
    return this._initPromise;
  },

  async loadLanguage(lang) {
    try {
      const res = await fetch(`/locales/${lang}.json`);
      if (!res.ok) throw new Error('Locale not found');
      this.dict = await res.json();
      this.currentLang = lang;
      localStorage.setItem('litesync_lang', lang);
      this.applyDOM();
    } catch (e) {
      console.error('Failed to load language', e);
    }
  },

  t(key, params = {}) {
    const keys = key.split('.');
    let val = this.dict;
    for (const k of keys) {
      if (val === undefined) break;
      val = val[k];
    }
    if (val === undefined || typeof val !== 'string') return key;

    return val.replace(/{(\w+)}/g, (match, p1) => {
      return params[p1] !== undefined ? params[p1] : match;
    });
  },

  applyDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const translation = this.t(el.getAttribute('data-i18n'));
      if (translation !== el.getAttribute('data-i18n')) {
        el.textContent = translation;
      }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const translation = this.t(el.getAttribute('data-i18n-title'));
      if (translation !== el.getAttribute('data-i18n-title')) {
        el.title = translation;
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const translation = this.t(el.getAttribute('data-i18n-placeholder'));
      if (translation !== el.getAttribute('data-i18n-placeholder')) {
        el.placeholder = translation;
      }
    });
  }
};

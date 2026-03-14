(() => {
  const THEME_KEY = 'grok2api_theme_preference';
  const THEME_LIGHT = 'light';
  const THEME_DARK = 'dark';
  const THEME_AUTO = 'auto';

  const metaThemeColor = document.querySelector('meta[name="theme-color"]');

  function safeGetPreference() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === THEME_LIGHT || stored === THEME_DARK || stored === THEME_AUTO) {
        return stored;
      }
    } catch (e) {
      // 忽略 localStorage 访问异常
    }
    return THEME_AUTO;
  }

  function safeSetPreference(preference) {
    try {
      localStorage.setItem(THEME_KEY, preference);
    } catch (e) {
      // 忽略 localStorage 写入异常
    }
  }

  function resolvePreference(preference) {
    if (preference === THEME_LIGHT || preference === THEME_DARK) {
      return preference;
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return THEME_DARK;
    }
    return THEME_LIGHT;
  }

  function syncThemeMeta(resolvedTheme) {
    if (!metaThemeColor) return;
    metaThemeColor.setAttribute('content', resolvedTheme === THEME_DARK ? '#0b0f14' : '#fafafa');
  }

  function syncThemeButtons(preference, resolvedTheme) {
    const buttons = document.querySelectorAll('[data-theme-toggle-btn]');
    buttons.forEach((btn) => {
      const nextLabel = resolvedTheme === THEME_DARK ? '日间模式' : '深夜模式';
      const nextTitle = resolvedTheme === THEME_DARK ? '切换到日间模式' : '切换到深夜模式';
      btn.textContent = nextLabel;
      btn.setAttribute('title', nextTitle);
      btn.classList.toggle('theme-active', resolvedTheme === THEME_DARK);
      btn.setAttribute('aria-pressed', resolvedTheme === THEME_DARK ? 'true' : 'false');
      btn.setAttribute('data-theme-preference', preference);
      btn.setAttribute('data-theme-resolved', resolvedTheme);
    });
  }

  function applyTheme(preference, persist = false) {
    const normalized = (preference === THEME_LIGHT || preference === THEME_DARK || preference === THEME_AUTO)
      ? preference
      : THEME_AUTO;
    const resolved = resolvePreference(normalized);
    const root = document.documentElement;
    root.setAttribute('data-theme-preference', normalized);
    root.setAttribute('data-theme', resolved);
    syncThemeMeta(resolved);
    syncThemeButtons(normalized, resolved);
    if (persist) {
      safeSetPreference(normalized);
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === THEME_DARK ? THEME_DARK : THEME_LIGHT;
    const next = current === THEME_DARK ? THEME_LIGHT : THEME_DARK;
    applyTheme(next, true);
  }

  function handleThemeButtonClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('[data-theme-toggle-btn]');
    if (!button) return;
    event.preventDefault();
    toggleTheme();
  }

  function init() {
    applyTheme(safeGetPreference(), false);
    document.addEventListener('click', handleThemeButtonClick);

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onSystemThemeChange = () => {
        if (safeGetPreference() === THEME_AUTO) {
          applyTheme(THEME_AUTO, false);
        }
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onSystemThemeChange);
      } else if (typeof media.addListener === 'function') {
        media.addListener(onSystemThemeChange);
      }
    }
  }

  window.themeController = {
    applyTheme,
    refreshButtons() {
      const preference = document.documentElement.getAttribute('data-theme-preference') || safeGetPreference();
      const resolved = document.documentElement.getAttribute('data-theme') || resolvePreference(preference);
      syncThemeButtons(preference, resolved);
      syncThemeMeta(resolved);
    },
    getPreference: safeGetPreference,
  };

  init();
})();

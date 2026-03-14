(() => {
  function bindFab(root) {
    if (!root || root.dataset.fabBound === '1') return;
    root.dataset.fabBound = '1';

    const toggleBtn = root.querySelector('[data-fab-toggle]');
    const proxyButtons = Array.from(root.querySelectorAll('[data-proxy-click]'));

    const setOpen = (open) => {
      const isOpen = Boolean(open);
      root.classList.toggle('open', isOpen);
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', String(isOpen));
      }
    };

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        setOpen(!root.classList.contains('open'));
      });
    }

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!root.contains(target)) {
        setOpen(false);
      }
    });

    proxyButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const selector = btn.getAttribute('data-proxy-click');
        if (!selector) return;
        const source = document.querySelector(selector);
        if (!(source instanceof HTMLElement)) return;
        source.click();
      });
    });

    const syncProxyState = () => {
      proxyButtons.forEach((btn) => {
        const selector = btn.getAttribute('data-proxy-click');
        if (!selector) return;
        const source = document.querySelector(selector);
        if (!(source instanceof HTMLElement)) {
          btn.classList.add('hidden');
          btn.disabled = true;
          return;
        }
        const logicallyHidden = Boolean(source.hidden) || source.classList.contains('hidden');
        btn.disabled = Boolean(source.disabled);
        btn.classList.toggle('hidden', logicallyHidden);
        const nextLabel = String(source.textContent || '').trim();
        if (nextLabel && btn.textContent !== nextLabel) {
          btn.textContent = nextLabel;
        }
      });
    };

    const observer = new MutationObserver(syncProxyState);
    const observedSources = new Set();
    proxyButtons.forEach((btn) => {
      const selector = btn.getAttribute('data-proxy-click');
      if (!selector) return;
      const source = document.querySelector(selector);
      if (!(source instanceof HTMLElement) || observedSources.has(source)) return;
      observedSources.add(source);
      observer.observe(source, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled'],
        childList: true,
        characterData: true,
        subtree: true,
      });
    });

    syncProxyState();
    setOpen(false);
  }

  function setupAll() {
    document.querySelectorAll('[data-mobile-fab]').forEach((root) => {
      if (root instanceof HTMLElement) {
        bindFab(root);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAll);
  } else {
    setupAll();
  }
})();

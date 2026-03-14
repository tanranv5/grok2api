async function loadPublicHeader() {
  const container = document.getElementById('app-header');
  if (!container) return;
  try {
    const res = await fetch('/static/common/html/public-header.html?v=0.3.3');
    if (!res.ok) return;
    container.innerHTML = await res.text();
    const desktopLogoutBtn = container.querySelector('#public-logout-btn');
    const mobileLogoutBtn = container.querySelector('#public-mobile-logout-btn');
    if (desktopLogoutBtn) {
      desktopLogoutBtn.classList.add('hidden');
    }
    if (mobileLogoutBtn) {
      mobileLogoutBtn.classList.add('hidden');
    }
    if (desktopLogoutBtn || mobileLogoutBtn) {
      try {
        const authHeader = (typeof window.ensurePublicKey === 'function')
          ? await window.ensurePublicKey()
          : null;
        if (authHeader !== null) {
          const verify = await fetch('/v1/public/verify', {
            method: 'GET',
            headers: (typeof window.buildAuthHeaders === 'function')
              ? window.buildAuthHeaders(authHeader)
              : {}
          });
          if (verify.ok && authHeader) {
            if (desktopLogoutBtn) {
              desktopLogoutBtn.classList.remove('hidden');
            }
            if (mobileLogoutBtn) {
              mobileLogoutBtn.classList.remove('hidden');
            }
          }
        }
      } catch (e) {
        // Ignore verification errors and keep it hidden
      }
    }
    const path = window.location.pathname;
    const links = container.querySelectorAll('a[data-nav]');
    links.forEach((link) => {
      const target = link.getAttribute('data-nav') || '';
      if (target && path.startsWith(target)) {
        link.classList.add('active');
      }
    });

    const nav = container.querySelector('nav');
    const menuToggle = container.querySelector('#public-menu-toggle');
    const mobileMenu = container.querySelector('#public-mobile-menu');
    if (menuToggle && mobileMenu) {
      const setMenuOpen = (open) => {
        const isOpen = Boolean(open);
        menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        mobileMenu.hidden = !isOpen;
        mobileMenu.classList.toggle('open', isOpen);
        if (nav) {
          nav.classList.toggle('mobile-menu-open', isOpen);
        }
        document.body.classList.toggle('mobile-menu-open', isOpen);
      };

      setMenuOpen(false);

      menuToggle.addEventListener('click', () => {
        const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
        setMenuOpen(!expanded);
      });

      mobileMenu.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('a') || target.closest('button')) {
          setMenuOpen(false);
        }
      });

      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (!container.contains(target)) {
          setMenuOpen(false);
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          setMenuOpen(false);
        }
      });

      window.addEventListener('resize', () => {
        if (window.innerWidth > 900) {
          setMenuOpen(false);
        }
      });
    }

    if (window.themeController && typeof window.themeController.refreshButtons === 'function') {
      window.themeController.refreshButtons();
    }

    if (typeof window.setupPwaInstallButtons === 'function') {
      window.setupPwaInstallButtons(container);
    }
  } catch (e) {
    // Fail silently to avoid breaking page load
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadPublicHeader);
} else {
  loadPublicHeader();
}

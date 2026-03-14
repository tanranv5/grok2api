async function loadAdminHeader() {
  const container = document.getElementById('app-header');
  if (!container) return;
  try {
    const res = await fetch('/static/common/html/header.html?v=0.3.1');
    if (!res.ok) return;
    container.innerHTML = await res.text();
    const path = window.location.pathname;
    const links = container.querySelectorAll('a[data-nav]');
    links.forEach((link) => {
      const target = link.getAttribute('data-nav') || '';
      if (target && path.startsWith(target)) {
        link.classList.add('active');
        const group = link.closest('.nav-group');
        if (group) {
          const trigger = group.querySelector('.nav-group-trigger');
          if (trigger) {
            trigger.classList.add('active');
          }
        }
      }
    });
    if (typeof updateStorageModeButton === 'function') {
      updateStorageModeButton();
    }

    const nav = container.querySelector('nav');
    const menuToggle = container.querySelector('#admin-menu-toggle');
    const mobileMenu = container.querySelector('#admin-mobile-menu');
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
  } catch (e) {
    // Fail silently to avoid breaking page load
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAdminHeader);
} else {
  loadAdminHeader();
}

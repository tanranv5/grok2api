(() => {
  if (!("serviceWorker" in navigator)) return;

  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  if (!window.isSecureContext && !isLocalhost) return;

  let deferredPrompt = null;
  let installMode = "none";

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function isIosDevice() {
    const ua = window.navigator.userAgent || "";
    return /iphone|ipad|ipod/i.test(ua);
  }

  function toast(message, type) {
    if (typeof window.showToast === "function") {
      window.showToast(message, type);
    }
  }

  function getInstallButtons(scope) {
    const root = scope instanceof Element || scope instanceof Document ? scope : document;
    return Array.from(root.querySelectorAll("[data-pwa-install-btn]"));
  }

  function refreshInstallButtons(scope) {
    const buttons = getInstallButtons(scope);
    const canShow = !isStandalone() && (installMode === "prompt" || installMode === "ios");
    buttons.forEach((btn) => {
      btn.classList.toggle("hidden", !canShow);
      btn.disabled = !canShow;
    });
  }

  async function runInstallPrompt() {
    if (isStandalone()) return;
    if (installMode === "ios") {
      toast("iOS 请点击浏览器分享按钮，再选择“添加到主屏幕”", "success");
      return;
    }
    if (!deferredPrompt) {
      toast("当前环境暂不支持安装", "warning");
      return;
    }
    try {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } finally {
      deferredPrompt = null;
      installMode = isIosDevice() ? "ios" : "none";
      refreshInstallButtons();
    }
  }

  function bindInstallButtonClick(scope) {
    const buttons = getInstallButtons(scope);
    buttons.forEach((btn) => {
      if (btn.dataset.pwaBound === "1") return;
      btn.dataset.pwaBound = "1";
      btn.addEventListener("click", () => {
        runInstallPrompt();
      });
    });
  }

  window.setupPwaInstallButtons = (scope) => {
    bindInstallButtonClick(scope);
    refreshInstallButtons(scope);
  };

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installMode = "prompt";
    refreshInstallButtons();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installMode = "none";
    refreshInstallButtons();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js?v=0.1.2").catch(() => {});
    if (isIosDevice() && !isStandalone()) {
      installMode = "ios";
    }
    window.setupPwaInstallButtons(document);
  });

  const observer = new MutationObserver(() => {
    window.setupPwaInstallButtons(document);
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
      window.setupPwaInstallButtons(document);
    });
  }
})();

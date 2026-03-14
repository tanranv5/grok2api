(() => {
  const enhanceStateMap = new WeakMap();
  const enhanceRequestMap = new WeakMap();

  function toast(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    }
  }

  function injectStyles() {
    if (document.getElementById('promptEnhancerStyle')) return;
    const style = document.createElement('style');
    style.id = 'promptEnhancerStyle';
    style.textContent = `
      .prompt-enhance-wrap {
        position: relative;
        width: 100%;
        --pe-action-width: 104px;
        --pe-action-height: 30px;
        --pe-action-radius: 8px;
        --pe-slash-size: 8px;
        --pe-lang-share: 40%;
        --pe-border-color: #5f7087;
        --pe-scrollbar-thumb: rgba(110, 132, 160, 0.82);
        --pe-scrollbar-thumb-hover: rgba(86, 112, 145, 0.95);
        --pe-scrollbar-track: rgba(148, 163, 184, 0.18);
      }
      .prompt-enhance-wrap > textarea {
        padding-bottom: 40px;
        scrollbar-width: thin;
        scrollbar-color: var(--pe-scrollbar-thumb) var(--pe-scrollbar-track);
      }
      .prompt-enhance-wrap > textarea::-webkit-scrollbar {
        width: 7px;
        height: 7px;
      }
      .prompt-enhance-wrap > textarea::-webkit-scrollbar-track {
        background: var(--pe-scrollbar-track);
        border-radius: 999px;
      }
      .prompt-enhance-wrap > textarea::-webkit-scrollbar-thumb {
        background: var(--pe-scrollbar-thumb);
        border-radius: 999px;
        border: 1px solid transparent;
        background-clip: padding-box;
      }
      .prompt-enhance-wrap > textarea:hover::-webkit-scrollbar-thumb {
        background: var(--pe-scrollbar-thumb-hover);
      }
      .prompt-enhance-wrap > textarea:focus::-webkit-scrollbar-thumb {
        background: var(--pe-scrollbar-thumb-hover);
      }
      .prompt-enhance-wrap.lightbox-mode > textarea {
        width: 100%;
        display: block;
        box-sizing: border-box;
        padding-left: 12px;
        padding-right: calc(var(--pe-action-width) + 20px);
        min-height: 84px;
      }
      .prompt-enhance-wrap.lightbox-mode {
        flex: 1;
        min-width: 0;
        width: 100%;
        position: relative;
      }
      .prompt-enhance-wrap > .prompt-enhance-actions {
        position: absolute;
        right: 10px;
        bottom: 10px;
        z-index: 3;
        width: var(--pe-action-width);
        height: var(--pe-action-height);
        display: flex;
        align-items: stretch;
        justify-content: stretch;
      }
      .prompt-enhance-wrap.lightbox-mode > .inline-send-inside,
      .prompt-enhance-wrap.lightbox-mode > #lightboxEditSend,
      .prompt-enhance-wrap.lightbox-mode > .lightbox-edit-send {
        position: absolute !important;
        right: 10px !important;
        bottom: 10px !important;
        z-index: 4;
        height: 30px !important;
        min-width: 104px;
        width: auto !important;
        margin: 0 !important;
        padding: 0 12px !important;
        border-radius: 8px;
        flex: none !important;
      }
      .prompt-enhance-wrap.lightbox-mode > .prompt-enhance-actions {
        right: 10px !important;
        bottom: 46px !important;
        z-index: 4;
      }
      @media (max-width: 768px) {
        .prompt-enhance-wrap {
          --pe-action-width: 92px;
          --pe-action-height: 28px;
          --pe-slash-size: 7px;
          --pe-lang-share: 40%;
        }
        .prompt-enhance-wrap.lightbox-mode > textarea {
          padding-left: 12px;
          padding-right: calc(var(--pe-action-width) + 12px);
          padding-bottom: 50px;
          min-height: 96px;
        }
        .prompt-enhance-wrap.lightbox-mode > .inline-send-inside,
        .prompt-enhance-wrap.lightbox-mode > #lightboxEditSend,
        .prompt-enhance-wrap.lightbox-mode > .lightbox-edit-send {
          right: 8px !important;
          bottom: 8px !important;
          min-width: 92px;
          height: 28px !important;
          padding: 0 10px !important;
        }
        .prompt-enhance-wrap.lightbox-mode > .prompt-enhance-actions {
          right: 8px !important;
          bottom: 42px !important;
        }
      }
      .prompt-enhance-actions > .prompt-enhance-btn,
      .prompt-enhance-actions > .prompt-lang-toggle-btn {
        height: 100%;
        min-width: 0;
        width: 100%;
        padding: 0 10px;
        background: var(--bg);
        border-color: var(--pe-border-color);
        color: var(--fg);
        cursor: pointer;
        user-select: none;
        transition: border-color .15s ease, background .15s ease;
      }
      .prompt-enhance-actions > .prompt-enhance-btn {
        border-radius: var(--pe-action-radius);
      }
      .prompt-enhance-actions > .prompt-lang-toggle-btn {
        display: none;
      }
      .prompt-enhance-btn:hover {
        border-color: #34455d;
        background: #e7eef8;
        box-shadow: inset 0 0 0 1px rgba(52, 69, 93, 0.22);
      }
      .prompt-enhance-btn:active {
        border-color: #2a3d57;
        background: #dce7f6;
      }
      html[data-theme='dark'] .prompt-enhance-btn {
        background: #111821;
        border-color: #607286;
        color: var(--fg);
      }
      html[data-theme='dark'] .prompt-enhance-btn:hover {
        border-color: #7a8ea6;
        background: #1a2330;
      }
      .prompt-lang-toggle-btn:hover {
        border-color: #34455d;
        background: #e7eef8;
        box-shadow: inset 0 0 0 1px rgba(52, 69, 93, 0.22);
      }
      .prompt-lang-toggle-btn:active {
        border-color: #2a3d57;
        background: #dce7f6;
      }
      html[data-theme='dark'] .prompt-lang-toggle-btn {
        background: #111821;
        border-color: #607286;
        color: var(--fg);
      }
      html[data-theme='dark'] .prompt-lang-toggle-btn:hover {
        border-color: #7a8ea6;
        background: #1a2330;
      }
      .prompt-enhance-actions.is-group-active {
        padding: 1px;
        background: var(--pe-border-color);
        border: 1px solid var(--pe-border-color);
        border-radius: var(--pe-action-radius);
        overflow: hidden;
      }
      .prompt-enhance-actions.is-group-active > .prompt-lang-toggle-btn.is-visible {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 var(--pe-lang-share);
        max-width: none;
        margin-right: 0;
        border-radius: var(--pe-action-radius) 0 0 var(--pe-action-radius);
        border: 0;
        clip-path: polygon(0 0, 100% 0, calc(100% - var(--pe-slash-size)) 100%, 0 100%);
        padding: 0 4px 0 8px;
        z-index: 2;
      }
      .prompt-enhance-actions.is-group-active > .prompt-enhance-btn {
        flex: 1 1 auto;
        min-width: 0;
        max-width: none;
        margin-left: calc(var(--pe-slash-size) * -1);
        border-radius: 0 var(--pe-action-radius) var(--pe-action-radius) 0;
        border: 0;
        clip-path: polygon(var(--pe-slash-size) 0, 100% 0, 100% 100%, 0 100%);
        padding: 0 10px 0 calc(10px + var(--pe-slash-size));
        z-index: 1;
      }
      .prompt-enhance-actions.is-group-active > .prompt-lang-toggle-btn.is-visible:hover,
      .prompt-enhance-actions.is-group-active > .prompt-enhance-btn:hover {
        border: 0;
        background: #dfe9f7;
        box-shadow: none;
      }
      .prompt-enhance-actions.is-group-active > .prompt-lang-toggle-btn.is-visible:active,
      .prompt-enhance-actions.is-group-active > .prompt-enhance-btn:active {
        border: 0;
        background: #d3e0f4;
        box-shadow: none;
      }
      html[data-theme='dark'] .prompt-enhance-actions.is-group-active > .prompt-lang-toggle-btn.is-visible:hover,
      html[data-theme='dark'] .prompt-enhance-actions.is-group-active > .prompt-enhance-btn:hover {
        border: 0;
        background: #1d2a3a;
      }
      html[data-theme='dark'] .prompt-enhance-wrap {
        --pe-border-color: #607286;
        --pe-scrollbar-thumb: rgba(130, 154, 184, 0.72);
        --pe-scrollbar-thumb-hover: rgba(156, 182, 214, 0.9);
        --pe-scrollbar-track: rgba(86, 102, 123, 0.28);
      }
      .prompt-enhance-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .prompt-lang-toggle-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `;
    document.head.appendChild(style);
  }

  function isPromptTextarea(el) {
    if (!(el instanceof HTMLTextAreaElement)) return false;
    if (el.readOnly) return false;
    const id = String(el.id || '').toLowerCase();
    const placeholder = String(el.placeholder || '');
    if (id.includes('prompt')) return true;
    if (el.classList.contains('lightbox-edit-input')) return true;
    if (placeholder.includes('提示词')) return true;
    return false;
  }

  async function callEnhanceApi(rawPrompt, signal, authHeader, requestId) {
    const body = {
      prompt: rawPrompt,
      temperature: 0.7,
      request_id: requestId,
    };

    const res = await fetch('/v1/public/prompt/enhance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...window.buildAuthHeaders(authHeader),
        'X-Enhance-Request-Id': requestId,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json();
        detail = err && err.error && err.error.message ? String(err.error.message) : '';
      } catch (e) {
        // ignore
      }
      throw new Error(detail || `enhance_failed_${res.status}`);
    }
    const data = await res.json();
    const text = String((data && data.enhanced_prompt) || '').trim();
    if (!text) {
      throw new Error('enhance_empty_response');
    }
    return text;
  }

  function newRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `enh_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function requestEnhanceStop(meta) {
    if (!meta || !meta.requestId || !meta.authHeader) return;
    fetch('/v1/public/prompt/enhance/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...window.buildAuthHeaders(meta.authHeader),
      },
      body: JSON.stringify({ request_id: meta.requestId }),
    }).catch(() => {});
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function parseEnhancedPrompt(text) {
    const raw = String(text || '').trim();
    // 兼容 Markdown 标题、粗体标题、普通标题三种写法
    const finalLabelRe = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?\*{0,2}\s*最终提示词(?:（[^）]*）|\([^)]*\))?\s*\*{0,2}\s*[:：]?/;
    const zhLabelRe = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?\*{0,2}\s*中文参考版(?:（[^）]*）|\([^)]*\))?\s*\*{0,2}\s*[:：]?/;
    const tailLabelRe = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?\*{0,2}\s*可调参数(?:（[^）]*）|\([^)]*\))?\s*\*{0,2}\s*[:：]?/;
    const finalLabelMatch = finalLabelRe.exec(raw);
    const zhLabelMatch = zhLabelRe.exec(raw);
    const tailLabelMatch = tailLabelRe.exec(raw);

    const finalStart = finalLabelMatch ? finalLabelMatch.index + finalLabelMatch[0].length : -1;
    const zhStart = zhLabelMatch ? zhLabelMatch.index + zhLabelMatch[0].length : -1;
    const tailStart = tailLabelMatch ? tailLabelMatch.index : -1;

    const head = finalLabelMatch ? raw.slice(0, finalLabelMatch.index).trim() : '';
    const en = (finalStart >= 0 && zhLabelMatch && zhLabelMatch.index >= finalStart)
      ? raw.slice(finalStart, zhLabelMatch.index).trim()
      : '';
    const zhEnd = tailStart >= 0 ? tailStart : raw.length;
    const zh = (zhStart >= 0 && zhEnd >= zhStart)
      ? raw.slice(zhStart, zhEnd).trim()
      : '';
    const tail = tailStart >= 0 ? raw.slice(tailStart).trim() : '';
    return {
      head,
      en,
      zh,
      tail,
      raw,
    };
  }

  function applyPromptToTextarea(textarea, value) {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function extractMentionTokens(text) {
    const raw = String(text || '');
    const tokens = raw.match(/@Image\s+\d+|@[0-9a-fA-F-]{32,36}/g) || [];
    const ordered = [];
    const seen = new Set();
    tokens.forEach((token) => {
      const key = String(token || '').trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      ordered.push(key);
    });
    return ordered;
  }

  function encodePromptMentions(text) {
    const raw = String(text || '');
    const mentions = extractMentionTokens(raw);
    if (!mentions.length) {
      return {
        text: raw,
        tokens: [],
        placeholders: []
      };
    }
    let encoded = raw;
    const placeholders = [];
    mentions.forEach((token, index) => {
      const placeholder = `[[IMAGE_TAG_${index + 1}]]`;
      placeholders.push(placeholder);
      encoded = encoded.replaceAll(token, placeholder);
    });
    return {
      text: encoded,
      tokens: mentions,
      placeholders
    };
  }

  function restorePromptMentions(text, mentionState) {
    const raw = String(text || '');
    const tokens = Array.isArray(mentionState && mentionState.tokens) ? mentionState.tokens : [];
    const placeholders = Array.isArray(mentionState && mentionState.placeholders) ? mentionState.placeholders : [];
    if (!tokens.length || !placeholders.length) {
      return raw;
    }

    let restored = raw;
    placeholders.forEach((placeholder, index) => {
      const token = tokens[index] || '';
      if (!placeholder || !token) return;
      restored = restored.replaceAll(placeholder, token);
    });
    return restored;
  }

  function updateToggleButtonText(toggleBtn, mode) {
    toggleBtn.textContent = mode === 'en' ? 'CN' : 'EN';
  }

  function setToggleButtonVisible(toggleBtn, visible) {
    toggleBtn.classList.toggle('is-visible', Boolean(visible));
  }

  function setEnhanceButtonMode(enhanceBtn, mode) {
    enhanceBtn.dataset.mode = mode;
    enhanceBtn.textContent = mode === 'clear' ? '清空' : '增强提示词';
  }

  function pickReferenceActionButton(textarea, wrapper) {
    if (!wrapper) return null;
    const inlineBtn = wrapper.querySelector('.inline-submit-btn, .inline-send-inside, #lightboxEditSend, .lightbox-edit-send');
    if (inlineBtn instanceof HTMLButtonElement) return inlineBtn;

    const id = String(textarea && textarea.id ? textarea.id : '').toLowerCase();
    if (id === 'editpromptinput') {
      const btn = document.getElementById('submitEditBtn');
      if (
        btn instanceof HTMLButtonElement &&
        btn.classList.contains('inline-submit-btn') &&
        wrapper.contains(btn)
      ) {
        return btn;
      }
    }
    if (id === 'lightboxeditinput') {
      const btn = document.getElementById('lightboxEditSend');
      if (
        btn instanceof HTMLButtonElement &&
        btn.classList.contains('inline-send-inside') &&
        wrapper.contains(btn)
      ) {
        return btn;
      }
    }
    return null;
  }

  function syncActionDimensions(textarea, wrapper, actionWrap) {
    if (!textarea || !wrapper || !actionWrap) return null;
    const refBtn = pickReferenceActionButton(textarea, wrapper);
    const mobile = isMobileViewport();
    const targetWidth = mobile ? 92 : 104;
    const targetHeight = mobile ? 28 : 30;
    wrapper.style.setProperty('--pe-action-width', `${targetWidth}px`);
    wrapper.style.setProperty('--pe-action-height', `${targetHeight}px`);
    if (!(refBtn instanceof HTMLButtonElement)) return null;
    const style = window.getComputedStyle(refBtn);
    const radius = parseFloat(style.borderTopLeftRadius || '8') || 8;
    wrapper.style.setProperty('--pe-action-radius', `${Math.max(4, Math.round(radius))}px`);
    return refBtn;
  }

  function bindActionDimensionSync(textarea, wrapper, actionWrap) {
    const run = () => syncActionDimensions(textarea, wrapper, actionWrap);
    let observedBtn = null;
    let resizeObserver = null;
    let mutationObserver = null;

    const rebind = () => {
      const nextBtn = run();
      if (!window.ResizeObserver) return;
      if (!resizeObserver) {
        resizeObserver = new ResizeObserver(() => run());
      }
      if (observedBtn === nextBtn) return;
      if (observedBtn) resizeObserver.unobserve(observedBtn);
      observedBtn = nextBtn;
      if (observedBtn) resizeObserver.observe(observedBtn);
    };

    rebind();
    requestAnimationFrame(rebind);
    setTimeout(rebind, 80);
    setTimeout(rebind, 240);

    window.addEventListener('resize', rebind, { passive: true });
    mutationObserver = new MutationObserver(() => rebind());
    mutationObserver.observe(wrapper, { childList: true });
    wrapper.__peResizeObserver = resizeObserver;
    wrapper.__peMutationObserver = mutationObserver;
  }

  function syncActionGroupState(enhanceBtn, toggleBtn, actionWrap) {
    if (!actionWrap || !enhanceBtn || !toggleBtn) return;
    const isClearMode = String(enhanceBtn.dataset.mode || 'enhance') === 'clear';
    const isRunning = String(enhanceBtn.dataset.running || '0') === '1';
    const langVisible = toggleBtn.classList.contains('is-visible');
    actionWrap.classList.toggle('is-group-active', isClearMode && langVisible && !isRunning);
  }

  function setEnhanceRunning(textarea, enhanceBtn, toggleBtn, running, actionWrap) {
    enhanceBtn.dataset.running = running ? '1' : '0';
    if (running) {
      enhanceBtn.textContent = '中止';
      enhanceBtn.disabled = false;
      if (toggleBtn) toggleBtn.disabled = true;
      syncActionGroupState(enhanceBtn, toggleBtn, actionWrap);
      return;
    }
    if (toggleBtn) toggleBtn.disabled = false;
    setEnhanceButtonMode(enhanceBtn, String(enhanceBtn.dataset.mode || 'enhance'));
    enhanceRequestMap.delete(textarea);
    syncActionGroupState(enhanceBtn, toggleBtn, actionWrap);
  }

  function cancelEnhance(textarea) {
    const requestMeta = enhanceRequestMap.get(textarea);
    if (!requestMeta) return;
    if (requestMeta.controller) {
      requestMeta.controller.abort();
    }
    requestEnhanceStop(requestMeta);
  }

  function resetEnhancerState(textarea, enhanceBtn, toggleBtn, actionWrap) {
    enhanceStateMap.delete(textarea);
    setToggleButtonVisible(toggleBtn, false);
    updateToggleButtonText(toggleBtn, 'zh');
    setEnhanceButtonMode(enhanceBtn, 'enhance');
    syncActionGroupState(enhanceBtn, toggleBtn, actionWrap);
  }

  function buildDesktopText(state, mode) {
    const middleLabel = mode === 'en' ? '最终提示词：' : '中文参考版：';
    const middleText = mode === 'en' ? state.en : state.zh;
    const blocks = [];
    if (state.head) blocks.push(state.head);
    blocks.push(`${middleLabel}\n${middleText}`);
    if (state.tail) blocks.push(state.tail);
    return blocks.join('\n\n');
  }

  function applyEnhancedByMode(textarea, toggleBtn, mode) {
    const state = enhanceStateMap.get(textarea);
    if (!state) return;
    const mobile = isMobileViewport();
    if (mode === 'en' && state.en) {
      state.mode = 'en';
      if (mobile) {
        applyPromptToTextarea(textarea, state.en);
      } else {
        applyPromptToTextarea(textarea, buildDesktopText(state, 'en'));
      }
    } else if (mode === 'zh' && state.zh) {
      state.mode = 'zh';
      if (mobile) {
        applyPromptToTextarea(textarea, state.zh);
      } else {
        applyPromptToTextarea(textarea, buildDesktopText(state, 'zh'));
      }
    } else {
      applyPromptToTextarea(textarea, state.raw);
    }
    enhanceStateMap.set(textarea, state);
    updateToggleButtonText(toggleBtn, state.mode);
  }

  async function onEnhanceClick(textarea, enhanceBtn, toggleBtn, actionWrap) {
    if (String(enhanceBtn.dataset.running || '0') === '1') {
      cancelEnhance(textarea);
      toast('已取消提示词增强', 'warning');
      return;
    }
    const currentMode = String(enhanceBtn.dataset.mode || 'enhance');
    if (currentMode === 'clear') {
      applyPromptToTextarea(textarea, '');
      resetEnhancerState(textarea, enhanceBtn, toggleBtn, actionWrap);
      toast('已清空提示词', 'success');
      return;
    }

    const raw = String(textarea.value || '').trim();
    if (!raw) {
      toast('请输入提示词', 'warning');
      return;
    }
    const mentionState = encodePromptMentions(raw);
    if (typeof window.ensurePublicKey !== 'function' || typeof window.buildAuthHeaders !== 'function') {
      toast('公共鉴权脚本未加载', 'error');
      return;
    }
    const authHeader = await window.ensurePublicKey();
    if (authHeader === null) {
      toast('请先配置 Public Key', 'error');
      return;
    }
    const requestId = newRequestId();
    const controller = new AbortController();
    enhanceRequestMap.set(textarea, {
      controller,
      requestId,
      authHeader,
    });
    setEnhanceRunning(textarea, enhanceBtn, toggleBtn, true, actionWrap);
    try {
      const enhanced = await callEnhanceApi(mentionState.text, controller.signal, authHeader, requestId);
      const parsed = parseEnhancedPrompt(enhanced);
      const restoredParsed = {
        head: restorePromptMentions(parsed.head, mentionState),
        en: restorePromptMentions(parsed.en, mentionState),
        zh: restorePromptMentions(parsed.zh, mentionState),
        tail: restorePromptMentions(parsed.tail, mentionState),
        raw: restorePromptMentions(parsed.raw, mentionState),
      };
      const hasDualLanguage = Boolean(restoredParsed.en && restoredParsed.zh);
      const mode = ((enhanceStateMap.get(textarea) || {}).mode || 'zh');
      enhanceStateMap.set(textarea, {
        head: restoredParsed.head,
        en: restoredParsed.en,
        zh: restoredParsed.zh,
        tail: restoredParsed.tail,
        raw: restoredParsed.raw,
        mode,
      });

      if (hasDualLanguage) {
        setToggleButtonVisible(toggleBtn, true);
        const applyMode = mode === 'en' ? 'en' : 'zh';
        applyEnhancedByMode(textarea, toggleBtn, applyMode);
      } else {
        setToggleButtonVisible(toggleBtn, false);
        applyPromptToTextarea(textarea, restoredParsed.raw);
      }
      setEnhanceButtonMode(enhanceBtn, 'clear');
      syncActionGroupState(enhanceBtn, toggleBtn, actionWrap);
      toast('提示词增强完成', 'success');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        toast('已取消提示词增强', 'warning');
        return;
      }
      const msg = String(e && e.message ? e.message : e);
      toast(`提示词增强失败: ${msg}`, 'error');
    } finally {
      setEnhanceRunning(textarea, enhanceBtn, toggleBtn, false, actionWrap);
    }
  }

  function mountEnhancer(textarea) {
    if (!isPromptTextarea(textarea)) return;
    if (textarea.dataset.promptEnhancerMounted === '1') return;
    const parent = textarea.parentElement;
    if (!parent) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'prompt-enhance-wrap';
    const isLightbox = textarea.classList.contains('lightbox-edit-input');
    if (isLightbox) {
      wrapper.classList.add('lightbox-mode');
    }
    parent.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);

    function syncLightboxSendButton() {
      if (!isLightbox) return;
      const host = wrapper.parentElement;
      if (!host) return;
      const sendBtn = host.querySelector('#lightboxEditSend, .lightbox-edit-send');
      if (!(sendBtn instanceof HTMLButtonElement)) return;
      if (sendBtn.parentElement !== wrapper) {
        wrapper.appendChild(sendBtn);
      }
      sendBtn.classList.add('inline-send-inside');
    }

    if (isLightbox) {
      syncLightboxSendButton();
      requestAnimationFrame(syncLightboxSendButton);
      setTimeout(syncLightboxSendButton, 80);
      const host = wrapper.parentElement;
      if (host) {
        const observer = new MutationObserver(() => syncLightboxSendButton());
        observer.observe(host, { childList: true, subtree: false });
        wrapper.__lightboxSendObserver = observer;
      }
    }

    const actionWrap = document.createElement('div');
    actionWrap.className = 'prompt-enhance-actions';
    wrapper.appendChild(actionWrap);

    const langBtn = document.createElement('button');
    langBtn.type = 'button';
    langBtn.className = 'geist-button-outline prompt-lang-toggle-btn';
    updateToggleButtonText(langBtn, 'zh');
    langBtn.addEventListener('click', () => {
      const state = enhanceStateMap.get(textarea);
      if (!state || (!state.en && !state.zh)) {
        toast('请先增强提示词', 'warning');
        return;
      }
      const nextMode = (state.mode || 'zh') === 'zh' ? 'en' : 'zh';
      applyEnhancedByMode(textarea, langBtn, nextMode);
    });
    actionWrap.appendChild(langBtn);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'geist-button-outline prompt-enhance-btn';
    setEnhanceButtonMode(button, 'enhance');
    button.addEventListener('click', () => onEnhanceClick(textarea, button, langBtn, actionWrap));
    actionWrap.appendChild(button);
    syncActionGroupState(button, langBtn, actionWrap);
    bindActionDimensionSync(textarea, wrapper, actionWrap);

    textarea.dataset.promptEnhancerMounted = '1';
  }

  function init() {
    injectStyles();
    const areas = Array.from(document.querySelectorAll('textarea'));
    areas.forEach((area) => mountEnhancer(area));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

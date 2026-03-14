(() => {
  let Room;
  let createLocalTracks;
  let RoomEvent;
  let Track;
  let room = null;
  let visualizerTimer = null;
  let isConnecting = false;
  let suppressDisconnectLog = false;

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusText = document.getElementById('statusText');
  const logContainer = document.getElementById('log');
  const voiceSelect = document.getElementById('voiceSelect');
  const personalitySelect = document.getElementById('personalitySelect');
  const speedRange = document.getElementById('speedRange');
  const speedValue = document.getElementById('speedValue');
  const statusVoice = document.getElementById('statusVoice');
  const statusPersonality = document.getElementById('statusPersonality');
  const statusSpeed = document.getElementById('statusSpeed');
  const audioRoot = document.getElementById('audioRoot');
  const copyLogBtn = document.getElementById('copyLogBtn');
  const clearLogBtn = document.getElementById('clearLogBtn');
  const visualizer = document.getElementById('visualizer');

  function log(message, level = 'info') {
    if (!logContainer) {
      return;
    }
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString();
    p.textContent = `[${time}] ${message}`;
    if (level === 'error') {
      p.classList.add('log-error');
    } else if (level === 'warn') {
      p.classList.add('log-warn');
    }
    logContainer.prepend(p);
    if (typeof console !== 'undefined') {
      console.log(message);
    }
  }

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    } else {
      log(message, type === 'error' ? 'error' : 'info');
    }
  }

  function setStatus(state, text) {
    if (!statusText) {
      return;
    }
    statusText.textContent = text;
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(connected) {
    if (!startBtn || !stopBtn) {
      return;
    }
    if (connected) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      startBtn.disabled = false;
    }
  }

  function updateMeta() {
    if (statusVoice) {
      statusVoice.textContent = voiceSelect.value;
    }
    if (statusPersonality) {
      statusPersonality.textContent = personalitySelect.value;
    }
    if (statusSpeed) {
      statusSpeed.textContent = `${speedRange.value}x`;
    }
  }

  function initLiveKit() {
    const lk = window.LiveKitClient || window.LivekitClient;
    if (!lk) {
      return false;
    }
    Room = lk.Room;
    createLocalTracks = lk.createLocalTracks;
    RoomEvent = lk.RoomEvent;
    Track = lk.Track;
    return true;
  }

  function ensureLiveKit() {
    if (Room) {
      return true;
    }
    if (!initLiveKit()) {
      log('错误: LiveKit SDK 未能正确加载，请刷新页面重试', 'error');
      toast('LiveKit SDK 加载失败', 'error');
      return false;
    }
    return true;
  }

  function ensureMicSupport() {
    const hasMediaDevices = typeof navigator !== 'undefined' && navigator.mediaDevices;
    const hasGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (hasGetUserMedia) {
      return true;
    }
    const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const secureHint = window.isSecureContext || isLocalhost
      ? '请使用最新版浏览器并允许麦克风权限'
      : '请使用 HTTPS 或在本机 localhost 访问';
    throw new Error(`当前环境不支持麦克风权限，${secureHint}`);
  }

  function getLivekitHost(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return '-';
    }
    try {
      return new URL(rawUrl).host || rawUrl;
    } catch (err) {
      return rawUrl;
    }
  }

  function normalizeLivekitUrl(rawUrl, fallback = '') {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return fallback;
    }
    const value = rawUrl.trim();
    const withProtocol = value.includes('://') ? value : `wss://${value}`;
    try {
      const u = new URL(withProtocol);
      if (!u.protocol.startsWith('ws')) {
        return fallback;
      }
      const path = (u.pathname || '').replace(/\/+$/, '');
      return `${u.protocol}//${u.host}${path}`;
    } catch (err) {
      return fallback;
    }
  }

  function normalizeLivekitUrls(rawUrls, fallbackUrl = 'wss://livekit.grok.com') {
    const result = [];
    const push = (value) => {
      const normalized = normalizeLivekitUrl(value, '');
      if (!normalized || result.includes(normalized)) {
        return;
      }
      result.push(normalized);
    };

    if (Array.isArray(rawUrls)) {
      for (const value of rawUrls) {
        push(value);
      }
    } else {
      push(rawUrls);
    }

    push(fallbackUrl);
    if (!result.length) {
      result.push('wss://livekit.grok.com');
    }
    return result;
  }

  function isSignalProxyUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const path = (parsed.pathname || '').replace(/\/+$/, '');
      return path.endsWith('/voice/signal') || path.endsWith('/voice/signal/rtc');
    } catch (err) {
      return false;
    }
  }

  function normalizeIceServers(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const urlsRaw = item.urls || item.url;
      let urls = [];
      if (typeof urlsRaw === 'string') {
        const value = urlsRaw.trim();
        if (value) {
          urls = [value];
        }
      } else if (Array.isArray(urlsRaw)) {
        urls = urlsRaw
          .filter((u) => typeof u === 'string')
          .map((u) => u.trim())
          .filter((u) => u.length > 0);
      }
      if (!urls.length) {
        continue;
      }

      const entry = { urls };
      if (typeof item.username === 'string' && item.username.trim()) {
        entry.username = item.username.trim();
      }
      if (item.credential !== undefined && item.credential !== null) {
        entry.credential = item.credential;
      }
      normalized.push(entry);
    }
    return normalized;
  }

  function buildConnectOptions(iceServers, forceRelay = false) {
    const options = {
      autoSubscribe: true,
      maxRetries: 1,
      websocketTimeout: 30000,
      peerConnectionTimeout: 20000
    };
    const rtcConfig = {};
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      rtcConfig.iceServers = iceServers;
    }
    if (forceRelay) {
      rtcConfig.iceTransportPolicy = 'relay';
    }
    if (Object.keys(rtcConfig).length > 0) {
      options.rtcConfig = rtcConfig;
    }
    return options;
  }

  function buildCandidateUrls(rawUrls) {
    const seeds = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
    const candidates = [];
    const push = (u) => {
      if (!u || candidates.includes(u)) {
        return;
      }
      candidates.push(u);
    };

    for (const rawUrl of seeds) {
      const main = normalizeLivekitUrl(rawUrl, '').replace(/\/+$/, '');
      if (!main) {
        continue;
      }

      push(main);
      if (main.endsWith('/rtc')) {
        push(main.slice(0, -4));
      } else {
        push(`${main}/rtc`);
      }

      // 某些移动网络对默认端口推断不稳定，追加 :443 变体做兜底。
      try {
        const parsed = new URL(main);
        if (parsed.protocol === 'wss:' && !parsed.port) {
          const base443 = `${parsed.protocol}//${parsed.hostname}:443`;
          const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
          push(`${base443}${path}`);
          if (path.endsWith('/rtc')) {
            push(base443);
          } else {
            push(`${base443}/rtc`);
          }
        }
      } catch (err) {
        // ignore
      }
    }
    if (!candidates.length) {
      push('wss://livekit.grok.com');
      push('wss://livekit.grok.com/rtc');
    }
    return candidates;
  }

  function bindRoomEvents(targetRoom) {
    targetRoom.on(RoomEvent.ParticipantConnected, (p) => log(`参与者已连接: ${p.identity}`));
    targetRoom.on(RoomEvent.ParticipantDisconnected, (p) => log(`参与者已断开: ${p.identity}`));
    targetRoom.on(RoomEvent.TrackSubscribed, (track) => {
      log(`订阅音轨: ${track.kind}`);
      if (track.kind === Track.Kind.Audio) {
        const element = track.attach();
        element.autoplay = true;
        element.playsInline = true;
        if (audioRoot) {
          audioRoot.appendChild(element);
        } else {
          document.body.appendChild(element);
        }
      }
    });

    targetRoom.on(RoomEvent.Disconnected, () => {
      if (!suppressDisconnectLog) {
        log('已断开连接');
      }
      if (!isConnecting) {
        resetUI();
      }
    });
  }

  function createRoomInstance() {
    const targetRoom = new Room({
      adaptiveStream: true,
      dynacast: true
    });
    bindRoomEvents(targetRoom);
    return targetRoom;
  }

  async function connectWithFallbacks(rawUrls, token, iceServers) {
    const urlCandidates = buildCandidateUrls(rawUrls);
    const strategies = [{ forceRelay: false, label: '默认' }];
    if (Array.isArray(iceServers) && iceServers.length > 0) {
      strategies.push({ forceRelay: true, label: 'relay' });
    }

    let lastError = null;
    let attempt = 0;

    suppressDisconnectLog = true;
    try {
      for (const candidateUrl of urlCandidates) {
        for (const strategy of strategies) {
          attempt += 1;
          const connectOptions = buildConnectOptions(iceServers, strategy.forceRelay);
          log(`尝试连接 #${attempt} (${strategy.label}): ${candidateUrl}`);

          room = createRoomInstance();
          try {
            await room.connect(candidateUrl, token, connectOptions);
            return {
              usedUrl: candidateUrl,
              usedProxy: isSignalProxyUrl(candidateUrl),
              usedRelay: strategy.forceRelay,
              attempts: attempt
            };
          } catch (err) {
            lastError = err;
            const message = err && err.message ? err.message : String(err || '');
            log(`连接失败 #${attempt} (${strategy.label}): ${message}`, 'warn');
            try {
              await room.disconnect();
            } catch (disconnectErr) {
              // ignore
            }
            room = null;
          }
        }
      }
    } finally {
      suppressDisconnectLog = false;
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error('连接失败：未找到可用连接策略');
  }

  async function startSession() {
    if (!ensureLiveKit()) {
      return;
    }

    let localTracks = [];
    try {
      isConnecting = true;
      const authHeader = await ensurePublicKey();
      if (authHeader === null) {
        toast('请先配置 Public Key', 'error');
        window.location.href = '/public/login';
        return;
      }

      startBtn.disabled = true;
      updateMeta();
      setStatus('connecting', '正在连接');
      log('正在获取 Token...');

      const params = new URLSearchParams({
        voice: voiceSelect.value,
        personality: personalitySelect.value,
        speed: speedRange.value
      });

      const headers = buildAuthHeaders(authHeader);

      const response = await fetch(`/v1/public/voice/token?${params.toString()}`, {
        headers
      });

      if (!response.ok) {
        throw new Error(`获取 Token 失败: ${response.status}`);
      }

      const payload = await response.json();
      const token = typeof payload.token === 'string' ? payload.token.trim() : '';
      const url = typeof payload.url === 'string' && payload.url.trim()
        ? payload.url.trim()
        : 'wss://livekit.grok.com';
      const urls = normalizeLivekitUrls(payload.urls, url);
      const signalProxyUrl = normalizeLivekitUrl(payload.signal_proxy_url || '', '');
      const isMobile = /Android|webOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
      const connectUrlSeeds = [];
      if (signalProxyUrl && isMobile) {
        connectUrlSeeds.push(signalProxyUrl);
      }
      connectUrlSeeds.push(...urls);
      if (signalProxyUrl && !isMobile) {
        connectUrlSeeds.push(signalProxyUrl);
      }
      const iceServers = normalizeIceServers(payload.ice_servers);
      const livekitHost = getLivekitHost(connectUrlSeeds[0] || url);
      if (!token) {
        throw new Error('服务端未返回有效 Token');
      }
      log(`获取 Token 成功 (${voiceSelect.value}, ${personalitySelect.value}, ${speedRange.value}x)`);
      log(`连接服务器: ${livekitHost}${iceServers.length ? `, ICE=${iceServers.length}` : ''}`);
      if (signalProxyUrl) {
        log(`signal 代理已就绪: ${signalProxyUrl}${isMobile ? ' (移动端优先)' : ' (回退使用)'}`);
      }

      log('正在请求麦克风权限...');
      ensureMicSupport();
      localTracks = await createLocalTracks({ audio: true, video: false });
      log('麦克风权限已授权');

      const connectResult = await connectWithFallbacks(connectUrlSeeds, token, iceServers);
      if (connectResult.usedRelay) {
        log('relay 模式连接成功', 'warn');
      }
      if (connectResult.usedProxy) {
        log('通过同域 signal 代理连接成功', 'warn');
      }
      log(`已连接到 LiveKit 服务器（尝试 ${connectResult.attempts} 次）`);

      setStatus('connected', '通话中');
      setButtons(true);

      for (const track of localTracks) {
        await room.localParticipant.publishTrack(track);
      }
      log('语音已开启');
      toast('语音连接成功', 'success');
    } catch (err) {
      for (const track of localTracks) {
        try {
          track.stop();
        } catch (stopErr) {
          // ignore
        }
      }
      const message = err && err.message ? err.message : '连接失败';
      log(`错误: ${message}`, 'error');
      if (/could not establish pc connection/i.test(message)) {
        log('提示: 该错误通常与网络环境或 ICE/STUN/TURN 配置相关', 'warn');
      }
      toast(message, 'error');
      setStatus('error', '连接错误');
      startBtn.disabled = false;
    } finally {
      isConnecting = false;
    }
  }

  async function stopSession() {
    if (room) {
      await room.disconnect();
    }
    resetUI();
  }

  function resetUI() {
    setStatus('', '未连接');
    setButtons(false);
    if (audioRoot) {
      audioRoot.innerHTML = '';
    }
  }

  function clearLog() {
    if (logContainer) {
      logContainer.innerHTML = '';
    }
  }

  async function copyLog() {
    if (!logContainer) {
      return;
    }
    const lines = Array.from(logContainer.querySelectorAll('p'))
      .map((p) => p.textContent)
      .join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      toast('日志已复制', 'success');
    } catch (err) {
      toast('复制失败，请手动选择', 'error');
    }
  }

  speedRange.addEventListener('input', (e) => {
    speedValue.textContent = Number(e.target.value).toFixed(1);
    const min = Number(speedRange.min || 0);
    const max = Number(speedRange.max || 100);
    const val = Number(speedRange.value || 0);
    const pct = ((val - min) / (max - min)) * 100;
    speedRange.style.setProperty('--range-progress', `${pct}%`);
    updateMeta();
  });

  voiceSelect.addEventListener('change', updateMeta);
  personalitySelect.addEventListener('change', updateMeta);

  startBtn.addEventListener('click', startSession);
  stopBtn.addEventListener('click', stopSession);
  if (copyLogBtn) {
    copyLogBtn.addEventListener('click', copyLog);
  }
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', clearLog);
  }

  speedValue.textContent = Number(speedRange.value).toFixed(1);
  {
    const min = Number(speedRange.min || 0);
    const max = Number(speedRange.max || 100);
    const val = Number(speedRange.value || 0);
    const pct = ((val - min) / (max - min)) * 100;
    speedRange.style.setProperty('--range-progress', `${pct}%`);
  }
  function buildVisualizerBars() {
    if (!visualizer) return;
    visualizer.innerHTML = '';
    const targetCount = Math.max(36, Math.floor(visualizer.offsetWidth / 7));
    for (let i = 0; i < targetCount; i += 1) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      visualizer.appendChild(bar);
    }
  }

  window.addEventListener('resize', buildVisualizerBars);
  buildVisualizerBars();
  updateMeta();
  setStatus('', '未连接');

  if (!visualizerTimer) {
    visualizerTimer = setInterval(() => {
      const bars = document.querySelectorAll('.visualizer .bar');
      bars.forEach((bar) => {
        if (statusText && statusText.classList.contains('connected')) {
          bar.style.height = `${Math.random() * 32 + 6}px`;
        } else {
          bar.style.height = '6px';
        }
      });
    }, 150);
  }
})();

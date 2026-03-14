(() => {
  const STORAGE_KEY = 'grok2api_parent_post_memory_v1';
  const MAX_ITEMS = 300;

  function nowMs() {
    return Date.now();
  }

  function isParentPostId(value) {
    return /^[0-9a-fA-F-]{32,36}$/.test(String(value || '').trim());
  }

  function buildImaginePublicUrl(parentPostId) {
    const id = String(parentPostId || '').trim();
    if (!id) return '';
    return `https://imagine-public.x.ai/imagine-public/images/${id}.jpg`;
  }

  function extractParentPostId(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (isParentPostId(raw)) return raw;

    const patterns = [
      /\/generated\/([0-9a-fA-F-]{32,36})(?:\/|$)/,
      /\/imagine-public\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/,
      /\/images\/([0-9a-fA-F-]{32,36})(?:\.jpg|\/|$)/,
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) {
        return match[1];
      }
    }

    const all = raw.match(/([0-9a-fA-F-]{32,36})/g);
    return all && all.length ? all[all.length - 1] : '';
  }

  function loadMemory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter((item) => item && isParentPostId(item.parentPostId));
    } catch (e) {
      return [];
    }
  }

  function saveMemory(items) {
    try {
      const normalized = Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (e) {
      // ignore
    }
  }

  function normalizeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:image/')) {
      return raw;
    }
    if (raw.startsWith('/')) {
      return raw;
    }
    return raw;
  }

  function remember(entry) {
    if (!entry || typeof entry !== 'object') return null;

    const parentPostId = extractParentPostId(entry.parentPostId || entry.parent_post_id || entry.id || '');
    if (!isParentPostId(parentPostId)) return null;

    const sourceImageUrl = normalizeUrl(entry.sourceImageUrl || entry.source_image_url || '');
    const imageUrl = normalizeUrl(entry.imageUrl || entry.image_url || entry.url || '');
    const item = {
      parentPostId,
      sourceImageUrl: sourceImageUrl || imageUrl || buildImaginePublicUrl(parentPostId),
      imageUrl: imageUrl || sourceImageUrl || buildImaginePublicUrl(parentPostId),
      origin: String(entry.origin || 'unknown'),
      updatedAt: Number(entry.updatedAt || nowMs()),
    };

    const all = loadMemory();
    const idx = all.findIndex((it) => it.parentPostId === parentPostId);
    if (idx >= 0) {
      all.splice(idx, 1);
    }
    all.unshift(item);
    saveMemory(all);
    return item;
  }

  function getByParentPostId(parentPostId) {
    const id = extractParentPostId(parentPostId);
    if (!isParentPostId(id)) return null;
    const all = loadMemory();
    return all.find((item) => item.parentPostId === id) || null;
  }

  function list(limit = 50) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return loadMemory().slice(0, n);
  }

  function resolveByText(text) {
    const raw = String(text || '').trim();
    const parentPostId = extractParentPostId(raw);
    if (!parentPostId) return null;
    const hit = getByParentPostId(parentPostId);
    if (hit) return hit;
    const looksLikeUrl = raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/');
    const fallbackUrl = looksLikeUrl ? raw : buildImaginePublicUrl(parentPostId);
    return {
      parentPostId,
      sourceImageUrl: fallbackUrl,
      imageUrl: fallbackUrl,
      origin: 'fallback',
      updatedAt: nowMs(),
    };
  }

  window.ParentPostMemory = {
    key: STORAGE_KEY,
    extractParentPostId,
    isParentPostId,
    buildImaginePublicUrl,
    remember,
    getByParentPostId,
    list,
    resolveByText,
  };
})();

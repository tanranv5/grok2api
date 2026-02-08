const ADMIN_TOKEN_KEY = "adminToken";

async function ensureApiKey() {
  const token = localStorage.getItem(ADMIN_TOKEN_KEY) || "";
  if (!token) {
    window.location.href = "/login";
    return null;
  }
  return `Bearer ${token}`;
}

function buildAuthHeaders(apiKey) {
  return apiKey ? { Authorization: apiKey } : {};
}

function logout() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  window.location.href = "/login";
}

async function fetchStorageType() {
  const apiKey = await ensureApiKey();
  if (apiKey === null) return null;
  try {
    const res = await fetch("/api/storage/mode", {
      headers: buildAuthHeaders(apiKey),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return String(data?.data?.mode || "");
  } catch {
    return null;
  }
}

function formatStorageLabel(type) {
  if (!type) return "-";
  return String(type).toLowerCase();
}

async function updateStorageModeButton() {
  const btn = document.getElementById("storage-mode-btn");
  if (!btn) return;
  btn.textContent = "...";
  btn.title = "存储模式";
  btn.classList.remove("storage-ready");
  const storageType = await fetchStorageType();
  const label = formatStorageLabel(storageType);
  btn.textContent = label === "-" ? label : label.toUpperCase();
  if (label !== "-") btn.classList.add("storage-ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", updateStorageModeButton);
} else {
  updateStorageModeButton();
}


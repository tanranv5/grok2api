import type { GrokSettings } from "../settings";
import { sanitizeHeaderValue } from "../utils/sanitize";

const BASE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://grok.com",
  Referer: "https://grok.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  Baggage: "sentry-environment=production,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
};

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function randomString(length: number, lettersOnly = true): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const chars = lettersOnly ? letters : letters + digits;
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) out += chars[bytes[i]! % chars.length]!;
  return out;
}

function generateStatsigId(): string {
  let msg: string;
  if (Math.random() < 0.5) {
    const rand = randomString(5, false);
    msg = `e:TypeError: Cannot read properties of null (reading 'children['${rand}']')`;
  } else {
    const rand = randomString(10, true);
    msg = `e:TypeError: Cannot read properties of undefined (reading '${rand}')`;
  }
  return btoa(msg);
}

function extractChromeMajor(userAgent: string): string {
  const match = userAgent.match(/(?:Chrome|Chromium|Edg)\/(\d{2,3})/i);
  return match?.[1] ?? "136";
}

function buildClientHints(userAgent: string): Record<string, string> {
  const major = extractChromeMajor(userAgent);
  return {
    "Sec-Ch-Ua": `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not(A:Brand";v="24"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "\"macOS\"",
    "Sec-Ch-Ua-Arch": "x86",
    "Sec-Ch-Ua-Bitness": "64",
    "Sec-Ch-Ua-Model": "",
  };
}

function resolveContentType(pathname: string): string {
  return pathname.includes("upload-file")
    ? "text/plain;charset=UTF-8"
    : "application/json";
}

export function getDynamicHeaders(settings: GrokSettings, pathname: string): Record<string, string> {
  const dynamic = settings.dynamic_statsig !== false;
  const configuredStatsig = sanitizeHeaderValue(settings.x_statsig_id ?? "", {
    removeAllSpaces: true,
  });
  const statsigId = dynamic ? generateStatsigId() : configuredStatsig;
  if (!dynamic && !statsigId) throw new Error("配置缺少 x_statsig_id（且未启用 dynamic_statsig）");

  const userAgent = sanitizeHeaderValue(DEFAULT_USER_AGENT);
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    ...buildClientHints(userAgent),
    "User-Agent": userAgent,
  };
  headers["x-statsig-id"] = statsigId;
  headers["x-xai-request-id"] = crypto.randomUUID();
  headers["Content-Type"] = resolveContentType(pathname);
  return headers;
}

export function getWebSocketHeaders(cookie: string): Record<string, string> {
  const userAgent = sanitizeHeaderValue(DEFAULT_USER_AGENT);
  return {
    ...buildClientHints(userAgent),
    Cookie: sanitizeHeaderValue(cookie),
    Origin: "https://grok.com",
    Upgrade: "websocket",
    Connection: "Upgrade",
    "User-Agent": userAgent,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

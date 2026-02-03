import type { GrokSettings } from "../settings";

const BASE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://grok.com",
  Referer: "https://grok.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Sec-Ch-Ua": '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  Baggage: "sentry-environment=production,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
};

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

export function getDynamicHeaders(settings: GrokSettings, pathname: string): Record<string, string> {
  const dynamic = settings.dynamic_statsig !== false;
  const statsigId = dynamic ? generateStatsigId() : (settings.x_statsig_id ?? "").trim();
  if (!dynamic && !statsigId) throw new Error("配置缺少 x_statsig_id（且未启用 dynamic_statsig）");

  const headers: Record<string, string> = { ...BASE_HEADERS };
  headers["x-statsig-id"] = statsigId;
  headers["x-xai-request-id"] = crypto.randomUUID();
  headers["Content-Type"] = pathname.includes("upload-file") ? "text/plain;charset=UTF-8" : "application/json";
  return headers;
}


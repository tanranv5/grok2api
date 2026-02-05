import { dbFirst, dbRun } from "./db";
import type { Env } from "./env";
import { nowMs } from "./utils/time";

export interface GlobalSettings {
  base_url?: string;
  log_level?: string;
  image_mode?: "url" | "base64";
  admin_username?: string;
  admin_password?: string;
  image_cache_max_size_mb?: number;
  video_cache_max_size_mb?: number;
}

export interface GrokSettings {
  api_key?: string;
  proxy_url?: string;
  proxy_pool_url?: string;
  proxy_pool_interval?: number;
  cache_proxy_url?: string;
  cf_clearance?: string; // stored as VALUE only (no "cf_clearance=" prefix)
  x_statsig_id?: string;
  dynamic_statsig?: boolean;
  filtered_tags?: string;
  show_thinking?: boolean;
  temporary?: boolean;
  video_poster_preview?: boolean;
  stream_first_response_timeout?: number;
  stream_chunk_timeout?: number;
  stream_total_timeout?: number;
  max_retry?: number;
  retry_status_codes?: number[];
  retry_on_network_error?: boolean;
  retry_backoff_base?: number;
  retry_backoff_factor?: number;
  retry_backoff_max?: number;
}

export interface SettingsBundle {
  global: Required<GlobalSettings>;
  grok: Required<GrokSettings>;
}

const DEFAULTS: SettingsBundle = {
  global: {
    base_url: "",
    log_level: "INFO",
    image_mode: "url",
    admin_username: "admin",
    admin_password: "admin",
    image_cache_max_size_mb: 512,
    video_cache_max_size_mb: 1024,
  },
  grok: {
    api_key: "",
    proxy_url: "",
    proxy_pool_url: "",
    proxy_pool_interval: 300,
    cache_proxy_url: "",
    cf_clearance: "",
    x_statsig_id: "",
    dynamic_statsig: true,
    filtered_tags: "xaiartifact,xai:tool_usage_card,grok:render",
    show_thinking: true,
    temporary: false,
    video_poster_preview: false,
    stream_first_response_timeout: 30,
    stream_chunk_timeout: 120,
    stream_total_timeout: 600,
    max_retry: 3,
    retry_status_codes: [401, 429],
    retry_on_network_error: true,
    retry_backoff_base: 1,
    retry_backoff_factor: 2,
    retry_backoff_max: 30,
  },
};

function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stripCfPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("cf_clearance=") ? trimmed.slice("cf_clearance=".length) : trimmed;
}

export function normalizeCfCookie(value: string): string {
  const cleaned = stripCfPrefix(value);
  return cleaned ? `cf_clearance=${cleaned}` : "";
}

export async function getSettings(env: Env): Promise<SettingsBundle> {
  const globalRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["global"],
  );
  const grokRow = await dbFirst<{ value: string }>(
    env.DB,
    "SELECT value FROM settings WHERE key = ?",
    ["grok"],
  );

  const globalCfg = globalRow?.value
    ? safeParseJson<GlobalSettings>(globalRow.value, DEFAULTS.global)
    : DEFAULTS.global;
  const grokCfg = grokRow?.value
    ? safeParseJson<GrokSettings>(grokRow.value, DEFAULTS.grok)
    : DEFAULTS.grok;

  return {
    global: { ...DEFAULTS.global, ...globalCfg },
    grok: { ...DEFAULTS.grok, ...grokCfg, cf_clearance: stripCfPrefix(grokCfg.cf_clearance ?? "") },
  };
}

export async function saveSettings(
  env: Env,
  updates: { global_config?: GlobalSettings; grok_config?: GrokSettings },
): Promise<void> {
  const now = nowMs();
  const current = await getSettings(env);

  const nextGlobal: GlobalSettings = { ...current.global, ...(updates.global_config ?? {}) };
  const nextGrok: GrokSettings = {
    ...current.grok,
    ...(updates.grok_config ?? {}),
    cf_clearance: stripCfPrefix(updates.grok_config?.cf_clearance ?? current.grok.cf_clearance ?? ""),
  };

  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["global", JSON.stringify(nextGlobal), now],
  );
  await dbRun(
    env.DB,
    "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    ["grok", JSON.stringify(nextGrok), now],
  );
}

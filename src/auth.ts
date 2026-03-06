import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { getSettings } from "./settings";
import { dbFirst } from "./db";
import { validateApiKey } from "./repo/apiKeys";
import { verifyAdminSession } from "./repo/adminSessions";

export interface ApiAuthInfo {
  key: string | null;
  name: string;
  is_admin: boolean;
}

const textEncoder = new TextEncoder();

function bearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function authError(message: string, code: string): Record<string, unknown> {
  return {
    error: {
      message,
      type: "authentication_error",
      code,
    },
  };
}

function parseApiKeys(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index++) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export const requireApiAuth: MiddlewareHandler<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }> = async (
  c,
  next,
) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  const settings = await getSettings(c.env);
  const globalKeys = parseApiKeys((settings.grok as { api_key?: unknown }).api_key);

  if (!token) {
    if (!globalKeys.length) {
      const row = await dbFirst<{ c: number }>(
        c.env.DB,
        "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1",
      );
      if ((row?.c ?? 0) === 0) {
        c.set("apiAuth", { key: null, name: "Anonymous", is_admin: false });
        return next();
      }
    }
    return c.json(authError("缺少认证令牌", "missing_token"), 401);
  }

  for (const globalKey of globalKeys) {
    if (safeEqual(token, globalKey)) {
      c.set("apiAuth", { key: token, name: "默认管理员", is_admin: true });
      return next();
    }
  }

  const keyInfo = await validateApiKey(c.env.DB, token);
  if (keyInfo) {
    c.set("apiAuth", { key: keyInfo.key, name: keyInfo.name, is_admin: false });
    return next();
  }

  return c.json(authError(`令牌无效，长度 ${token.length}`, "invalid_token"), 401);
};

export const requireAdminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  if (!token) return c.json({ error: "缺少会话", code: "MISSING_SESSION" }, 401);
  const ok = await verifyAdminSession(c.env.DB, token);
  if (!ok) return c.json({ error: "会话已过期", code: "SESSION_EXPIRED" }, 401);
  return next();
};

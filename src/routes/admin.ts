import { Hono } from "hono";
import type { Env } from "../env";
import { requireAdminAuth } from "../auth";
import { getSettings, saveSettings, normalizeCfCookie } from "../settings";
import {
  addApiKey,
  batchAddApiKeys,
  batchDeleteApiKeys,
  batchUpdateApiKeyStatus,
  deleteApiKey,
  listApiKeys,
  updateApiKeyName,
  updateApiKeyStatus,
} from "../repo/apiKeys";
import { displayKey } from "../utils/crypto";
import { createAdminSession, deleteAdminSession, verifyAdminSession } from "../repo/adminSessions";
import {
  addTokens,
  countTokens,
  deleteTokens,
  getAllTags,
  listTokens,
  listTokensPaged,
  markTokenActive,
  tokenRowToInfo,
  updateTokenNote,
  updateTokenTags,
  updateTokenLimits,
  selectBestToken,
} from "../repo/tokens";
import { checkRateLimits } from "../grok/rateLimits";
import { addRequestLog, clearRequestLogs, getRequestLogs, getRequestStats } from "../repo/logs";
import { getRefreshProgress, setRefreshProgress } from "../repo/refreshProgress";
import {
  deleteCacheRows,
  getCacheSizeBytes,
  listCacheRowsByType,
  listOldestRows,
  type CacheType,
} from "../repo/cache";
import { streamImagineWs } from "../grok/image_ws";
import { getDynamicHeaders } from "../grok/headers";

function jsonError(message: string, code: string): Record<string, unknown> {
  return { error: message, code };
}

function parseBearer(auth: string | null): string | null {
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function validateTokenType(token_type: string): "sso" | "ssoSuper" {
  if (token_type !== "sso" && token_type !== "ssoSuper") throw new Error("无效的Token类型");
  return token_type;
}

function formatBytes(sizeBytes: number): string {
  const kb = 1024;
  const mb = 1024 * 1024;
  if (sizeBytes < mb) return `${(sizeBytes / kb).toFixed(1)} KB`;
  return `${(sizeBytes / mb).toFixed(1)} MB`;
}

function adminSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function stripBase64Prefix(input: string): string {
  if (!input) return "";
  const idx = input.indexOf(",");
  if (idx === -1) return input;
  const head = input.slice(0, idx);
  if (head.toLowerCase().includes("base64")) return input.slice(idx + 1);
  return input;
}

async function clearKvCacheByType(
  env: Env,
  type: CacheType | null,
  batch = 200,
  maxLoops = 20,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < maxLoops; i++) {
    const rows = await listOldestRows(env.DB, type, null, batch);
    if (!rows.length) break;
    const keys = rows.map((r) => r.key);
    await Promise.all(keys.map((k) => env.KV_CACHE.delete(k)));
    await deleteCacheRows(env.DB, keys);
    deleted += keys.length;
    if (keys.length < batch) break;
  }
  return deleted;
}

export const adminRoutes = new Hono<{ Bindings: Env }>();
const RATE_LIMIT_MODEL = "grok-3";
const REFRESH_STALE_MS = 10 * 60 * 1000;
const MAX_REFRESH_BATCH = 50;
const LIVEKIT_TOKEN_API = "https://grok.com/rest/livekit/tokens";

adminRoutes.post("/api/login", async (c) => {
  try {
    const body = (await c.req.json()) as { username?: string; password?: string };
    const settings = await getSettings(c.env);

    if (body.username !== settings.global.admin_username || body.password !== settings.global.admin_password) {
      return c.json({ success: false, message: "用户名或密码错误" });
    }

    const token = await createAdminSession(c.env.DB);
    return c.json({ success: true, token, message: "登录成功" });
  } catch (e) {
    return c.json(jsonError(`登录失败: ${e instanceof Error ? e.message : String(e)}`, "LOGIN_ERROR"), 500);
  }
});

adminRoutes.post("/api/logout", requireAdminAuth, async (c) => {
  try {
    const token = parseBearer(c.req.header("Authorization") ?? null);
    if (token) await deleteAdminSession(c.env.DB, token);
    return c.json({ success: true, message: "登出成功" });
  } catch (e) {
    return c.json(jsonError(`登出失败: ${e instanceof Error ? e.message : String(e)}`, "LOGOUT_ERROR"), 500);
  }
});

adminRoutes.get("/api/settings", requireAdminAuth, async (c) => {
  try {
    const settings = await getSettings(c.env);
    return c.json({ success: true, data: settings });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_SETTINGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/settings", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { global_config?: any; grok_config?: any };
    await saveSettings(c.env, { global_config: body.global_config, grok_config: body.grok_config });
    return c.json({ success: true, message: "配置更新成功" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_SETTINGS_ERROR"), 500);
  }
});

adminRoutes.get("/api/storage/mode", requireAdminAuth, async (c) => {
  return c.json({ success: true, data: { mode: "D1" } });
});

adminRoutes.get("/api/v1/admin/voice/token", requireAdminAuth, async (c) => {
  try {
    const voice = String(c.req.query("voice") ?? "ara");
    const personality = String(c.req.query("personality") ?? "assistant");
    const speedRaw = Number(c.req.query("speed") ?? "1.0");
    const speed = Number.isFinite(speedRaw) ? Math.min(2, Math.max(0.5, speedRaw)) : 1.0;
    const settings = await getSettings(c.env);
    const chosen = await selectBestToken(c.env.DB, "grok-4.1-fast");
    if (!chosen) return c.json({ error: "No available token", code: "NO_AVAILABLE_TOKEN" }, 503);

    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
    const headers = getDynamicHeaders(settings.grok, "/rest/livekit/tokens");
    headers.Cookie = cookie;
    headers.Referer = "https://grok.com/";
    const payload = {
      sessionPayload: JSON.stringify({
        voice,
        personality,
        playback_speed: speed,
        enable_vision: false,
        turn_detection: { type: "server_vad" },
      }),
      requestAgentDispatch: false,
      livekitUrl: "wss://livekit.grok.com",
      params: { enable_markdown_transcript: "true" },
    };
    const resp = await fetch(LIVEKIT_TOKEN_API, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return c.json({ error: `Upstream error ${resp.status}`, detail: txt.slice(0, 200) }, 502);
    }
    const data = (await resp.json()) as { token?: string };
    if (!data?.token) return c.json({ error: "Missing voice token" }, 502);
    return c.json({ token: data.token, url: "wss://livekit.grok.com", participant_name: "", room_name: "" });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "voice_error" }, 500);
  }
});

adminRoutes.post("/api/v1/admin/imagine/stream", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { prompt?: string; aspect_ratio?: string };
    const prompt = String(body.prompt ?? "").trim();
    const aspect_ratio = String(body.aspect_ratio ?? "2:3");
    if (!prompt) return c.json({ error: "Missing prompt", code: "missing_prompt" }, 400);

    const settings = await getSettings(c.env);
    const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
    if (!chosen) return c.json({ error: "No available token", code: "NO_AVAILABLE_TOKEN" }, 503);
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
    const upstream = streamImagineWs({
      cookie,
      prompt,
      aspect_ratio,
      n: 1,
      enable_nsfw: settings.grok.image_ws_nsfw !== false,
      timeout: Math.max(10, Number(settings.grok.stream_idle_timeout ?? 120) || 120),
      blocked_seconds: Math.max(5, Number(settings.grok.image_ws_blocked_seconds ?? 15) || 15),
      final_min_bytes: Math.max(1, Number(settings.grok.image_ws_final_min_bytes ?? 100000) || 100000),
      medium_min_bytes: Math.max(1, Number(settings.grok.image_ws_medium_min_bytes ?? 30000) || 30000),
    });

    const encoder = new TextEncoder();
    let sequence = 0;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(adminSse("status", { type: "status", status: "running" })));
        try {
          for await (const item of upstream) {
            if (item.type === "error") {
              controller.enqueue(
                encoder.encode(adminSse("error", { type: "error", message: item.error, code: item.error_code })),
              );
              continue;
            }
            sequence += 1;
            controller.enqueue(
              encoder.encode(
                adminSse("image", {
                  type: "image",
                  b64_json: stripBase64Prefix(item.blob),
                  sequence,
                  elapsed_ms: 0,
                }),
              ),
            );
          }
          controller.enqueue(encoder.encode(adminSse("status", { type: "status", status: "stopped" })));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), code: "imagine_stream_error" }, 500);
  }
});

adminRoutes.get("/api/v1/admin/imagine/ws", async (c) => {
  const q = c.req.query("api_key") ?? "";
  const ok = q ? await verifyAdminSession(c.env.DB, q) : false;
  if (!ok) return c.text("Unauthorized", 401);

  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("Expected websocket", 426);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  let running = false;
  let stop = false;
  const send = (data: unknown) => {
    try {
      server.send(JSON.stringify(data));
    } catch {
      // ignore
    }
  };

  server.addEventListener("message", async (evt) => {
    let payload: any = null;
    try {
      payload = JSON.parse(String(evt.data || "{}"));
    } catch {
      payload = null;
    }
    if (!payload?.type) return;
    if (payload.type === "stop") {
      stop = true;
      running = false;
      send({ type: "status", status: "stopped" });
      return;
    }
    if (payload.type !== "start" || running) return;
    const prompt = String(payload.prompt ?? "").trim();
    const aspect_ratio = String(payload.aspect_ratio ?? "2:3");
    if (!prompt) {
      send({ type: "error", message: "Missing prompt", code: "missing_prompt" });
      return;
    }
    running = true;
    stop = false;
    send({ type: "status", status: "running", run_id: crypto.randomUUID() });
    const settings = await getSettings(c.env);
    let sequence = 0;
    while (!stop) {
      const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
      if (!chosen) {
        send({ type: "error", message: "No available token", code: "NO_AVAILABLE_TOKEN" });
        break;
      }
      const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
      const cookie = cf
        ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
        : `sso-rw=${chosen.token};sso=${chosen.token}`;
      const upstream = streamImagineWs({
        cookie,
        prompt,
        aspect_ratio,
        n: 1,
        enable_nsfw: settings.grok.image_ws_nsfw !== false,
        timeout: Math.max(10, Number(settings.grok.stream_idle_timeout ?? 120) || 120),
        blocked_seconds: Math.max(5, Number(settings.grok.image_ws_blocked_seconds ?? 15) || 15),
        final_min_bytes: Math.max(1, Number(settings.grok.image_ws_final_min_bytes ?? 100000) || 100000),
        medium_min_bytes: Math.max(1, Number(settings.grok.image_ws_medium_min_bytes ?? 30000) || 30000),
      });
      for await (const item of upstream) {
        if (stop) break;
        if (item.type === "error") {
          send({ type: "error", message: item.error, code: item.error_code });
          continue;
        }
        sequence += 1;
        send({
          type: "image",
          b64_json: stripBase64Prefix(item.blob),
          sequence,
          elapsed_ms: 0,
        });
      }
    }
    running = false;
    send({ type: "status", status: "stopped" });
  });

  server.addEventListener("close", () => {
    stop = true;
    running = false;
  });

  return new Response(null, { status: 101, webSocket: client });
});

adminRoutes.get("/api/tokens", requireAdminAuth, async (c) => {
  try {
    const rows = await listTokens(c.env.DB);
    const infos = rows.map(tokenRowToInfo);
    return c.json({ success: true, data: infos, total: infos.length });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[]; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const count = await addTokens(c.env.DB, tokens, token_type);
    return c.json({ success: true, message: `添加成功(${count})` });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { tokens?: string[]; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const deleted = await deleteTokens(c.env.DB, tokens, token_type);
    return c.json({ success: true, message: `删除成功(${deleted})` });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "TOKENS_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/tags", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string; tags?: string[] };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const tags = Array.isArray(body.tags) ? body.tags : [];
    await updateTokenTags(c.env.DB, token, token_type, tags);
    return c.json({ success: true, message: "标签更新成功", tags });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_TAGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/note", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string; note?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const note = String(body.note ?? "");
    await updateTokenNote(c.env.DB, token, token_type, note);
    return c.json({ success: true, message: "备注更新成功", note });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "UPDATE_NOTE_ERROR"), 500);
  }
});

adminRoutes.get("/api/tokens/tags/all", requireAdminAuth, async (c) => {
  try {
    const tags = await getAllTags(c.env.DB);
    return c.json({ success: true, data: tags });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_TAGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/test", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { token?: string; token_type?: string };
    const token_type = validateTokenType(String(body.token_type ?? ""));
    const token = String(body.token ?? "");
    const settings = await getSettings(c.env);

    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;

    const result = await checkRateLimits(cookie, settings.grok, RATE_LIMIT_MODEL);
    if (result) {
      const remaining = (result as any).remainingTokens ?? -1;
      const limit = (result as any).limit ?? -1;
      await updateTokenLimits(c.env.DB, token, { remaining_queries: typeof remaining === "number" ? remaining : -1 });
      await markTokenActive(c.env.DB, token);
      return c.json({
        success: true,
        message: "Token有效",
        data: { valid: true, remaining_queries: typeof remaining === "number" ? remaining : -1, limit },
      });
    }

    // Fallback：根据本地状态判断原因
    const rows = await listTokens(c.env.DB);
    const row = rows.find((r) => r.token === token && r.token_type === token_type);
    if (!row) {
      return c.json({ success: false, message: "Token数据异常", data: { valid: false, error_type: "unknown" } });
    }
    const now = Date.now();
    if (row.status === "expired") {
      return c.json({ success: false, message: "Token已失效", data: { valid: false, error_type: "expired", error_code: 401 } });
    }
    if (row.cooldown_until && row.cooldown_until > now) {
      const remaining = Math.floor((row.cooldown_until - now + 999) / 1000);
      return c.json({
        success: false,
        message: "Token处于冷却中",
        data: { valid: false, error_type: "cooldown", error_code: 429, cooldown_remaining: remaining },
      });
    }
    const exhausted =
      token_type === "ssoSuper"
        ? row.remaining_queries === 0 || row.heavy_remaining_queries === 0
        : row.remaining_queries === 0;
    if (exhausted) {
      return c.json({
        success: false,
        message: "Token额度耗尽",
        data: { valid: false, error_type: "exhausted", error_code: "quota_exhausted" },
      });
    }
    return c.json({
      success: false,
      message: "服务器被 block 或网络错误",
      data: { valid: false, error_type: "blocked", error_code: 403 },
    });
  } catch (e) {
    return c.json(jsonError(`测试失败: ${e instanceof Error ? e.message : String(e)}`, "TEST_TOKEN_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/refresh-all", requireAdminAuth, async (c) => {
  try {
    const progress = await getRefreshProgress(c.env.DB);
    if (progress.running) {
      const now = Date.now();
      if (now - progress.updated_at > REFRESH_STALE_MS) {
        await setRefreshProgress(c.env.DB, { running: false });
      } else {
        return c.json({ success: false, message: "刷新任务正在进行中", data: progress });
      }
    }

    const body = (await c.req.json().catch(() => ({}))) as { cursor?: unknown; limit?: unknown };
    const cursor = Math.max(0, Number(body.cursor ?? 0) || 0);
    const limitRaw = Number(body.limit ?? MAX_REFRESH_BATCH);
    const limit = Math.max(1, Math.min(MAX_REFRESH_BATCH, Number.isFinite(limitRaw) ? limitRaw : MAX_REFRESH_BATCH));

    const total = await countTokens(c.env.DB);
    if (total === 0) {
      await setRefreshProgress(c.env.DB, { running: false, current: 0, total: 0, success: 0, failed: 0 });
      return c.json({ success: true, message: "暂无Token", data: { started: false, cursor: 0, total: 0, done: true } });
    }

    if (cursor >= total) {
      await setRefreshProgress(c.env.DB, { running: false, current: total, total, success: progress.success, failed: progress.failed });
      return c.json({ success: true, message: "刷新已完成", data: { started: false, cursor: total, total, done: true } });
    }

    const tokens = await listTokensPaged(c.env.DB, limit, cursor);
    const nextCursor = Math.min(cursor + tokens.length, total);
    const baseSuccess = cursor > 0 ? progress.success : 0;
    const baseFailed = cursor > 0 ? progress.failed : 0;

    await setRefreshProgress(c.env.DB, {
      running: true,
      current: cursor,
      total,
      success: baseSuccess,
      failed: baseFailed,
    });

    const settings = await getSettings(c.env);
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

    c.executionCtx.waitUntil(
      (async () => {
        let success = 0;
        let failed = 0;
        let completed = 0;
        let idx = 0;
        const concurrency = Math.min(10, tokens.length);

        const runOne = async () => {
          while (true) {
            const i = idx;
            if (i >= tokens.length) return;
            idx += 1;
            const t = tokens[i]!;
            const cookie = cf ? `sso-rw=${t.token};sso=${t.token};${cf}` : `sso-rw=${t.token};sso=${t.token}`;
            try {
              const r = await checkRateLimits(cookie, settings.grok, RATE_LIMIT_MODEL);
              if (r) {
                const remaining = (r as any).remainingTokens;
                if (typeof remaining === "number") {
                  await updateTokenLimits(c.env.DB, t.token, { remaining_queries: remaining });
                }
                await markTokenActive(c.env.DB, t.token);
                success += 1;
              } else {
                failed += 1;
              }
            } catch {
              failed += 1;
            }
            completed += 1;
            if (completed % 5 === 0 || completed === tokens.length) {
              await setRefreshProgress(c.env.DB, {
                running: true,
                current: cursor + completed,
                total,
                success: baseSuccess + success,
                failed: baseFailed + failed,
              });
            }
          }
        };

        try {
          await Promise.all(Array.from({ length: concurrency }, runOne));
        } finally {
          await setRefreshProgress(c.env.DB, {
            running: false,
            current: nextCursor,
            total,
            success: baseSuccess + success,
            failed: baseFailed + failed,
          });
        }
      })(),
    );

    return c.json({
      success: true,
      message: "刷新任务已启动",
      data: { started: true, cursor: nextCursor, total, batch: tokens.length, done: nextCursor >= total },
    });
  } catch (e) {
    return c.json(jsonError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`, "REFRESH_ALL_ERROR"), 500);
  }
});

adminRoutes.post("/api/tokens/refresh-selected", requireAdminAuth, async (c) => {
  try {
    const progress = await getRefreshProgress(c.env.DB);
    if (progress.running) {
      const now = Date.now();
      if (now - progress.updated_at > REFRESH_STALE_MS) {
        await setRefreshProgress(c.env.DB, { running: false });
      } else {
        return c.json({ success: false, message: "刷新任务正在进行中", data: progress });
      }
    }

    const body = (await c.req.json().catch(() => ({}))) as { tokens?: unknown; cursor?: unknown; limit?: unknown };
    const tokensInput = Array.isArray(body.tokens) ? body.tokens : [];
    const tokens = Array.from(
      new Set(
        tokensInput
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t) => t.trim()),
      ),
    );
    if (!tokens.length) {
      return c.json({ success: false, message: "未提供 Token 列表" });
    }

    const cursor = Math.max(0, Number(body.cursor ?? 0) || 0);
    const limitRaw = Number(body.limit ?? MAX_REFRESH_BATCH);
    const limit = Math.max(1, Math.min(MAX_REFRESH_BATCH, Number.isFinite(limitRaw) ? limitRaw : MAX_REFRESH_BATCH));
    const total = tokens.length;

    if (cursor >= total) {
      await setRefreshProgress(c.env.DB, {
        running: false,
        current: total,
        total,
        success: progress.success,
        failed: progress.failed,
      });
      return c.json({ success: true, message: "刷新已完成", data: { started: false, cursor: total, total, done: true } });
    }

    const tokensSlice = tokens.slice(cursor, cursor + limit);
    const nextCursor = Math.min(cursor + tokensSlice.length, total);
    const baseSuccess = cursor > 0 ? progress.success : 0;
    const baseFailed = cursor > 0 ? progress.failed : 0;

    await setRefreshProgress(c.env.DB, {
      running: true,
      current: cursor,
      total,
      success: baseSuccess,
      failed: baseFailed,
    });

    const settings = await getSettings(c.env);
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");

    c.executionCtx.waitUntil(
      (async () => {
        let success = 0;
        let failed = 0;
        let completed = 0;
        let idx = 0;
        const concurrency = Math.min(10, tokensSlice.length);

        const runOne = async () => {
          while (true) {
            const i = idx;
            if (i >= tokensSlice.length) return;
            idx += 1;
            const token = tokensSlice[i]!;
            const cookie = cf ? `sso-rw=${token};sso=${token};${cf}` : `sso-rw=${token};sso=${token}`;
            try {
              const r = await checkRateLimits(cookie, settings.grok, RATE_LIMIT_MODEL);
              if (r) {
                const remaining = (r as any).remainingTokens;
                if (typeof remaining === "number") await updateTokenLimits(c.env.DB, token, { remaining_queries: remaining });
                await markTokenActive(c.env.DB, token);
                success += 1;
              } else {
                failed += 1;
              }
            } catch {
              failed += 1;
            }
            completed += 1;
            if (completed % 5 === 0 || completed === tokensSlice.length) {
              await setRefreshProgress(c.env.DB, {
                running: true,
                current: cursor + completed,
                total,
                success: baseSuccess + success,
                failed: baseFailed + failed,
              });
            }
          }
        };

        try {
          await Promise.all(Array.from({ length: concurrency }, runOne));
        } finally {
          await setRefreshProgress(c.env.DB, {
            running: false,
            current: nextCursor,
            total,
            success: baseSuccess + success,
            failed: baseFailed + failed,
          });
        }
      })(),
    );

    return c.json({
      success: true,
      message: "刷新任务已启动",
      data: { started: true, cursor: nextCursor, total, batch: tokensSlice.length, done: nextCursor >= total },
    });
  } catch (e) {
    return c.json(
      jsonError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`, "REFRESH_SELECTED_ERROR"),
      500,
    );
  }
});

adminRoutes.get("/api/tokens/refresh-progress", requireAdminAuth, async (c) => {
  try {
    const progress = await getRefreshProgress(c.env.DB);
    return c.json({ success: true, data: progress });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_PROGRESS_ERROR"), 500);
  }
});

adminRoutes.get("/api/stats", requireAdminAuth, async (c) => {
  try {
    const rows = await listTokens(c.env.DB);
    const now = Date.now();

    const calc = (type: "sso" | "ssoSuper") => {
      const tokens = rows.filter((r) => r.token_type === type);
      const total = tokens.length;
      const expired = tokens.filter((t) => t.status === "expired").length;
      let cooldown = 0;
      let exhausted = 0;
      let unused = 0;
      let active = 0;

      for (const t of tokens) {
        if (t.status === "expired") continue;
        if (t.cooldown_until && t.cooldown_until > now) {
          cooldown += 1;
          continue;
        }

        const isUnused = type === "ssoSuper" ? t.remaining_queries === -1 && t.heavy_remaining_queries === -1 : t.remaining_queries === -1;
        if (isUnused) {
          unused += 1;
          continue;
        }

        const isExhausted = type === "ssoSuper" ? t.remaining_queries === 0 || t.heavy_remaining_queries === 0 : t.remaining_queries === 0;
        if (isExhausted) {
          exhausted += 1;
          continue;
        }
        active += 1;
      }

      return { total, expired, active, cooldown, exhausted, unused };
    };

    const normal = calc("sso");
    const superStats = calc("ssoSuper");
    return c.json({ success: true, data: { normal, super: superStats, total: normal.total + superStats.total } });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "STATS_ERROR"), 500);
  }
});

adminRoutes.get("/api/request-stats", requireAdminAuth, async (c) => {
  try {
    const stats = await getRequestStats(c.env.DB);
    return c.json({ success: true, data: stats });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "REQUEST_STATS_ERROR"), 500);
  }
});

// === API Keys ===
adminRoutes.get("/api/keys", requireAdminAuth, async (c) => {
  try {
    const keys = await listApiKeys(c.env.DB);
    const settings = await getSettings(c.env);
    const globalKeySet = Boolean((settings.grok.api_key ?? "").trim());
    const data = keys.map((k) => ({ ...k, display_key: displayKey(k.key) }));
    return c.json({ success: true, data, global_key_set: globalKeySet });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "KEYS_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { name?: string };
    const name = String(body.name ?? "").trim();
    if (!name) return c.json({ success: false, message: "name不能为空" });
    const row = await addApiKey(c.env.DB, name);
    return c.json({ success: true, data: row, message: "Key创建成功" });
  } catch (e) {
    return c.json(jsonError(`添加失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { name_prefix?: string; count?: number };
    const prefix = String(body.name_prefix ?? "").trim();
    const count = Math.max(1, Math.min(100, Number(body.count ?? 1)));
    if (!prefix) return c.json({ success: false, message: "name_prefix不能为空" });
    const rows = await batchAddApiKeys(c.env.DB, prefix, count);
    return c.json({ success: true, data: rows, message: `成功创建 ${rows.length} 个Key` });
  } catch (e) {
    return c.json(jsonError(`批量添加失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_ADD_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string };
    const key = String(body.key ?? "");
    if (!key) return c.json({ success: false, message: "Key不能为空" });
    const ok = await deleteApiKey(c.env.DB, key);
    return c.json(ok ? { success: true, message: "Key删除成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`删除失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-delete", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { keys?: string[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const deleted = await batchDeleteApiKeys(c.env.DB, keys);
    return c.json({ success: true, message: `成功删除 ${deleted} 个Key` });
  } catch (e) {
    return c.json(jsonError(`批量删除失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_DELETE_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/status", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string; is_active?: boolean };
    const key = String(body.key ?? "");
    const ok = await updateApiKeyStatus(c.env.DB, key, Boolean(body.is_active));
    return c.json(ok ? { success: true, message: "状态更新成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_STATUS_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/batch-status", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { keys?: string[]; is_active?: boolean };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const updated = await batchUpdateApiKeyStatus(c.env.DB, keys, Boolean(body.is_active));
    return c.json({ success: true, message: `成功更新 ${updated} 个Key 状态` });
  } catch (e) {
    return c.json(jsonError(`批量更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_BATCH_STATUS_ERROR"), 500);
  }
});

adminRoutes.post("/api/keys/name", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { key?: string; name?: string };
    const ok = await updateApiKeyName(c.env.DB, String(body.key ?? ""), String(body.name ?? ""));
    return c.json(ok ? { success: true, message: "备注更新成功" } : { success: false, message: "Key不存在" });
  } catch (e) {
    return c.json(jsonError(`更新失败: ${e instanceof Error ? e.message : String(e)}`, "KEY_NAME_ERROR"), 500);
  }
});

// === Logs ===
adminRoutes.get("/api/logs", requireAdminAuth, async (c) => {
  try {
    const limitStr = c.req.query("limit");
    const limit = Math.max(1, Math.min(5000, Number(limitStr ?? 1000)));
    const logs = await getRequestLogs(c.env.DB, limit);
    return c.json({ success: true, data: logs });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "GET_LOGS_ERROR"), 500);
  }
});

adminRoutes.post("/api/logs/clear", requireAdminAuth, async (c) => {
  try {
    await clearRequestLogs(c.env.DB);
    return c.json({ success: true, message: "日志已清空" });
  } catch (e) {
    return c.json(jsonError(`清空失败: ${e instanceof Error ? e.message : String(e)}`, "CLEAR_LOGS_ERROR"), 500);
  }
});

// Cache endpoints (Workers Cache API 无法枚举/统计；这里提供兼容返回，保持后台可用)
adminRoutes.get("/api/cache/size", requireAdminAuth, async (c) => {
  try {
    const bytes = await getCacheSizeBytes(c.env.DB);
    return c.json({
      success: true,
      data: {
        image_size: formatBytes(bytes.image),
        video_size: formatBytes(bytes.video),
        total_size: formatBytes(bytes.total),
        image_size_bytes: bytes.image,
        video_size_bytes: bytes.video,
        total_size_bytes: bytes.total,
      },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_SIZE_ERROR"), 500);
  }
});

adminRoutes.get("/api/cache/list", requireAdminAuth, async (c) => {
  try {
    const t = (c.req.query("type") ?? "image").toLowerCase();
    const type: CacheType = t === "video" ? "video" : "image";
    const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const { total, items } = await listCacheRowsByType(c.env.DB, type, limit, offset);
    const mapped = items.map((it) => {
      const name = it.key.startsWith(`${type}/`) ? it.key.slice(type.length + 1) : it.key;
      return {
        name,
        size: formatBytes(it.size),
        mtime: it.last_access_at || it.created_at,
        url: `/images/${name}`,
      };
    });

    return c.json({
      success: true,
      data: { total, items: mapped, offset, limit, has_more: offset + mapped.length < total },
    });
  } catch (e) {
    return c.json(jsonError(`获取失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_LIST_ERROR"), 500);
  }
});

adminRoutes.post("/api/cache/clear", requireAdminAuth, async (c) => {
  try {
    const deletedImages = await clearKvCacheByType(c.env, "image");
    const deletedVideos = await clearKvCacheByType(c.env, "video");
    return c.json({
      success: true,
      message: `缓存清理完成，已删除 ${deletedImages + deletedVideos} 个文件`,
      data: { deleted_count: deletedImages + deletedVideos },
    });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "CACHE_CLEAR_ERROR"), 500);
  }
});
adminRoutes.post("/api/cache/clear/images", requireAdminAuth, async (c) => {
  try {
    const deleted = await clearKvCacheByType(c.env, "image");
    return c.json({ success: true, message: `图片缓存清理完成，已删除 ${deleted} 个文件`, data: { deleted_count: deleted, type: "images" } });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "IMAGE_CACHE_CLEAR_ERROR"), 500);
  }
});
adminRoutes.post("/api/cache/clear/videos", requireAdminAuth, async (c) => {
  try {
    const deleted = await clearKvCacheByType(c.env, "video");
    return c.json({ success: true, message: `视频缓存清理完成，已删除 ${deleted} 个文件`, data: { deleted_count: deleted, type: "videos" } });
  } catch (e) {
    return c.json(jsonError(`清理失败: ${e instanceof Error ? e.message : String(e)}`, "VIDEO_CACHE_CLEAR_ERROR"), 500);
  }
});

// A lightweight endpoint to create an audit log from the panel if needed (optional)
adminRoutes.post("/api/logs/add", requireAdminAuth, async (c) => {
  try {
    const body = (await c.req.json()) as { model?: string; status?: number; error?: string };
    await addRequestLog(c.env.DB, {
      ip: "admin",
      model: String(body.model ?? "admin"),
      duration: 0,
      status: Number(body.status ?? 200),
      key_name: "admin",
      token_suffix: "",
      error: String(body.error ?? ""),
    });
    return c.json({ success: true });
  } catch (e) {
    return c.json(jsonError(`写入失败: ${e instanceof Error ? e.message : String(e)}`, "LOG_ADD_ERROR"), 500);
  }
});

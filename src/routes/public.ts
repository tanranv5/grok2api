import { Hono } from "hono";
import type { Env } from "../env";
import { authenticateApiToken, extractBearerToken, requireApiAuth, type ApiAuthInfo } from "../auth";
import { getSettings, normalizeCfCookie } from "../settings";
import { selectBestToken } from "../repo/tokens";
import { streamImagineWs } from "../grok/image_ws";
import { getMediaPost } from "../grok/mediaPost";
import { createImagineTaskSession, deleteImagineTaskSessions, getImagineTaskSession } from "../public/imagineTasks";
import { runPublicEdit } from "../public/edit";
import { authenticateQueryToken, buildPublicSignalProxyUrl, handlePublicVoiceSignalProxy } from "../public/voice";
import { publicVideoRoutes } from "./publicVideo";
import { getDynamicHeaders } from "../grok/headers";

type PublicVars = { apiAuth: ApiAuthInfo };

const LIVEKIT_TOKEN_API = "https://grok.com/rest/livekit/tokens";
const IMAGINE_BATCH_SIZE = 6;

export const publicRoutes = new Hono<{ Bindings: Env; Variables: PublicVars }>();

publicRoutes.get("/verify", requireApiAuth, (c) => c.json({ success: true }));

publicRoutes.post("/chat/completions", requireApiAuth, async (c) => {
  const body = await c.req.text();
  return fetch(
    new Request(new URL("/v1/chat/completions", c.req.url).toString(), {
      method: "POST",
      headers: {
        "Content-Type": c.req.header("Content-Type") || "application/json",
        ...(c.req.header("Authorization") ? { Authorization: c.req.header("Authorization") as string } : {}),
      },
      body,
    }),
  );
});

publicRoutes.post("/prompt/enhance", requireApiAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown; temperature?: unknown };
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return c.json({ error: { message: "prompt is required" } }, 400);
  const payload = {
    model: "grok-4.1-fast",
    stream: false,
    temperature: Number(body.temperature ?? 0.7) || 0.7,
    messages: [
      {
        role: "system",
        content:
          "你是专业提示词增强器。请输出四段：1) 设计思路 2) 最终提示词 3) 中文参考版 4) 可调参数。保持可直接复制使用。",
      },
      { role: "user", content: prompt },
    ],
  };
  const response = await fetch(
    new Request(new URL("/v1/chat/completions", c.req.url).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(c.req.header("Authorization") ? { Authorization: c.req.header("Authorization") as string } : {}),
      },
      body: JSON.stringify(payload),
    }),
  );
  if (!response.ok) return response;
  const data = await response.json() as any;
  const enhanced = String(data?.choices?.[0]?.message?.content ?? "").trim();
  return c.json({ enhanced_prompt: enhanced });
});

publicRoutes.post("/prompt/enhance/stop", requireApiAuth, async (c) => c.json({ success: true }));

publicRoutes.get("/imagine/config", async (c) => {
  const settings = await getSettings(c.env);
  return c.json({
    final_min_bytes: Number(settings.grok.image_ws_final_min_bytes ?? 100000) || 100000,
    medium_min_bytes: Number(settings.grok.image_ws_medium_min_bytes ?? 30000) || 30000,
    nsfw: settings.grok.image_ws_nsfw !== false,
  });
});

publicRoutes.use("/voice/token", requireApiAuth);
publicRoutes.use("/imagine/start", requireApiAuth);
publicRoutes.use("/imagine/stop", requireApiAuth);
publicRoutes.use("/imagine/parent-post", requireApiAuth);
publicRoutes.use("/imagine/edit", requireApiAuth);
publicRoutes.use("/imagine/workbench/edit", requireApiAuth);

publicRoutes.get("/voice/token", async (c) => {
  const settings = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-4.1-fast");
  if (!chosen) return c.json({ error: "No available token", code: "NO_AVAILABLE_TOKEN" }, 503);

  const voice = String(c.req.query("voice") ?? "ara");
  const personality = String(c.req.query("personality") ?? "assistant");
  const speedRaw = Number(c.req.query("speed") ?? "1.0");
  const speed = Number.isFinite(speedRaw) ? Math.min(2, Math.max(0.5, speedRaw)) : 1.0;
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
  const response = await fetch(LIVEKIT_TOKEN_API, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!response.ok) return c.json({ error: `Upstream error ${response.status}` }, 502);
  const data = await response.json() as { token?: string; url?: string; livekitUrl?: string };
  const rawToken = extractBearerToken(c.req.header("Authorization") ?? null);
  return c.json({
    token: data.token ?? "",
    url: data.url || data.livekitUrl || "wss://livekit.grok.com",
    signal_proxy_url: rawToken ? buildPublicSignalProxyUrl(new URL(c.req.url), rawToken) : "",
  });
});

publicRoutes.get("/voice/signal/:token", handlePublicVoiceSignalProxy);
publicRoutes.get("/voice/signal/:token/*", handlePublicVoiceSignalProxy);

publicRoutes.post("/imagine/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string; aspect_ratio?: string; nsfw?: boolean };
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return c.text("Prompt cannot be empty", 400);
  const session = await createImagineTaskSession(c.env, {
    prompt,
    aspectRatio: String(body.aspect_ratio ?? "2:3").trim() || "2:3",
    nsfw: body.nsfw !== false,
  });
  return c.json({ task_id: session.taskId, aspect_ratio: session.aspectRatio });
});

publicRoutes.post("/imagine/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { task_ids?: unknown };
  const taskIds = Array.isArray(body.task_ids) ? body.task_ids.filter((item): item is string => typeof item === "string") : [];
  return c.json({ status: "success", removed: await deleteImagineTaskSessions(c.env, taskIds) });
});

publicRoutes.get("/imagine/parent-post", async (c) => {
  const parentPostId = String(c.req.query("parent_post_id") ?? "").trim();
  if (!parentPostId) return c.text("missing parent_post_id", 400);
  const settings = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0-edit");
  if (!chosen) return c.text("No available token", 503);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
  const post = await getMediaPost(cookie, settings.grok, parentPostId);
  return c.json({
    parent_post_id: parentPostId,
    media_url: post.mediaUrl ?? "",
    thumbnail_image_url: post.thumbnailImageUrl ?? "",
    source_image_url: post.mediaUrl || post.thumbnailImageUrl || "",
    mime_type: post.mimeType ?? "",
    original_post_id: post.originalPostId ?? "",
    original_ref_type: post.originalRefType ?? "",
  });
});

publicRoutes.post("/imagine/edit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return runPublicEdit(c.req.url, c.req.header("Authorization") ?? null, body, body.stream === true);
});

publicRoutes.post("/imagine/workbench/edit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return runPublicEdit(c.req.url, c.req.header("Authorization") ?? null, body, body.stream === true);
});

publicRoutes.get("/imagine/sse", async (c) => {
  const authInfo = await authenticateQueryToken(
    c.env,
    c.req.query("public_key") ?? c.req.query("api_key") ?? c.req.query("admin_token") ?? null,
  );
  if (!authInfo) return c.text("Unauthorized", 401);
  const task = await getImagineTaskSession(c.env, String(c.req.query("task_id") ?? "").trim());
  if (!task) return c.text("Task not found", 404);
  const settings = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
  if (!chosen) return c.text("No available token", 503);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
  const encoder = new TextEncoder();
  const upstream = streamImagineWs({
    cookie,
    prompt: task.prompt,
    aspect_ratio: task.aspectRatio,
    n: IMAGINE_BATCH_SIZE,
    enable_nsfw: task.nsfw,
    timeout: Math.max(10, Number(settings.grok.stream_idle_timeout ?? 120) || 120),
    blocked_seconds: Math.max(5, Number(settings.grok.image_ws_blocked_seconds ?? 15) || 15),
    final_min_bytes: Math.max(1, Number(settings.grok.image_ws_final_min_bytes ?? 100000) || 100000),
    medium_min_bytes: Math.max(1, Number(settings.grok.image_ws_medium_min_bytes ?? 30000) || 30000),
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const item of upstream) {
        if (item.type === "error") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: item.error, code: item.error_code })}\n\n`));
          continue;
        }
        const type = item.is_final ? "image_generation.completed" : "image_generation.partial_image";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, image_id: item.image_id, b64_json: item.blob, stage: item.stage, url: item.url })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" } });
});

publicRoutes.get("/imagine/ws", async (c) => {
  const authInfo = await authenticateQueryToken(
    c.env,
    c.req.query("public_key") ?? c.req.query("api_key") ?? c.req.query("admin_token") ?? null,
  );
  if (!authInfo) return c.text("Unauthorized", 401);
  const task = await getImagineTaskSession(c.env, String(c.req.query("task_id") ?? "").trim());
  if (!task) return c.text("Task not found", 404);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("Expected websocket", 426);

  const settings = await getSettings(c.env);
  const chosen = await selectBestToken(c.env.DB, "grok-imagine-1.0");
  if (!chosen) return c.text("No available token", 503);
  const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
  const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let stopped = false;
  server.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data || "{}")) as { type?: string };
      if (payload.type === "stop") stopped = true;
    } catch {}
  });
  void (async () => {
    server.send(JSON.stringify({ type: "status", status: "running", run_id: task.taskId }));
    for await (const item of streamImagineWs({
      cookie,
      prompt: task.prompt,
      aspect_ratio: task.aspectRatio,
      n: IMAGINE_BATCH_SIZE,
      enable_nsfw: task.nsfw,
      timeout: Math.max(10, Number(settings.grok.stream_idle_timeout ?? 120) || 120),
      blocked_seconds: Math.max(5, Number(settings.grok.image_ws_blocked_seconds ?? 15) || 15),
      final_min_bytes: Math.max(1, Number(settings.grok.image_ws_final_min_bytes ?? 100000) || 100000),
      medium_min_bytes: Math.max(1, Number(settings.grok.image_ws_medium_min_bytes ?? 30000) || 30000),
    })) {
      if (stopped) break;
      server.send(JSON.stringify(item.type === "error"
        ? { type: "error", message: item.error, code: item.error_code }
        : { type: item.is_final ? "image_generation.completed" : "image_generation.partial_image", image_id: item.image_id, b64_json: item.blob, stage: item.stage, url: item.url }));
    }
    server.send(JSON.stringify({ type: "status", status: "stopped", run_id: task.taskId }));
    try { server.close(1000, "done"); } catch {}
  })();
  return new Response(null, { status: 101, webSocket: client });
});

publicRoutes.route("/", publicVideoRoutes);

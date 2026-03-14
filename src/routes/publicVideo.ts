import { Hono } from "hono";
import type { Env } from "../env";
import { requireApiAuth, type ApiAuthInfo } from "../auth";
import {
  createOpenAiVideoTask,
  getOpenAiVideoTask,
  updateOpenAiVideoTaskStatus,
} from "../repo/openaiVideoTasks";
import { listCacheRowsByType } from "../repo/cache";
import { getSettings, normalizeCfCookie } from "../settings";
import { parseVideoExtendResult, requestVideoExtend } from "../grok/videoExtend";
import { selectBestToken } from "../repo/tokens";

type PublicVideoVars = { apiAuth: ApiAuthInfo };

function authHeaders(c: any): HeadersInit | undefined {
  const auth = c.req.header("Authorization") ?? null;
  return auth ? { Authorization: auth } : undefined;
}

function toVideoViewUrl(key: string): string {
  const name = key.startsWith("video/") ? key.slice("video/".length) : key;
  return `/images/${name}`;
}

async function runVideoExtendTask(env: Env, taskId: string, body: Record<string, unknown>): Promise<void> {
  const settings = await getSettings(env);
  const chosen = await selectBestToken(env.DB, "grok-imagine-1.0-video");
  if (!chosen) {
    await updateOpenAiVideoTaskStatus(env.DB, { id: taskId, status: "failed", errorMessage: "No available token" });
    return;
  }

  await updateOpenAiVideoTaskStatus(env.DB, { id: taskId, status: "in_progress" });
  try {
    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}` : `sso-rw=${chosen.token};sso=${chosen.token}`;
    const result = await parseVideoExtendResult(await requestVideoExtend({
      prompt: String(body.prompt ?? "").trim(),
      referenceId: String(body.extend_post_id ?? "").trim(),
      startTime: Number(body.video_extension_start_time ?? 0) || 0,
      ratio: String(body.aspect_ratio ?? "2:3").trim() || "2:3",
      length: Math.trunc(Number(body.video_length ?? 10) || 10),
      resolution: String(body.resolution_name ?? "480p").trim() === "720p" ? "720p" : "480p",
      cookie,
      settings: settings.grok,
    }));
    await updateOpenAiVideoTaskStatus(env.DB, {
      id: taskId,
      status: "completed",
      assetUrl: result.videoUrl,
    });
  } catch (error) {
    await updateOpenAiVideoTaskStatus(env.DB, {
      id: taskId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export const publicVideoRoutes = new Hono<{ Bindings: Env; Variables: PublicVideoVars }>();

publicVideoRoutes.use("/video/start", requireApiAuth);
publicVideoRoutes.use("/video/stop", requireApiAuth);
publicVideoRoutes.use("/video/cache/list", requireApiAuth);

publicVideoRoutes.post("/video/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const concurrent = Math.max(1, Math.min(3, Math.trunc(Number(body.concurrent ?? body.n ?? 1) || 1)));

  if (body.is_video_extension === true) {
    const taskIds: string[] = [];
    for (let index = 0; index < concurrent; index += 1) {
      const taskId = `vid_${crypto.randomUUID().replace(/-/g, "")}`;
      taskIds.push(taskId);
      await createOpenAiVideoTask(c.env.DB, {
        id: taskId,
        requestedModel: "grok-imagine-1.0-video",
        internalModel: "grok-imagine-1.0-video",
      });
      c.executionCtx.waitUntil(runVideoExtendTask(c.env, taskId, body));
    }
    return c.json({ task_ids: taskIds });
  }

  const taskIds: string[] = [];
  for (let index = 0; index < concurrent; index += 1) {
    const response = await fetch(new Request(new URL("/v1/videos", c.req.url).toString(), {
      method: "POST",
      headers: {
        ...(authHeaders(c) ?? {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: body.prompt,
        model: "grok-imagine-1.0-video",
        image_url: body.image_url,
        seconds: body.video_length,
        size: body.resolution_name === "720p" ? "1792x1024" : "1024x1024",
      }),
    }));
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return new Response(detail || "video_start_failed", { status: response.status });
    }
    const payload = await response.json() as { id?: string };
    if (payload.id) taskIds.push(payload.id);
  }
  return c.json({ task_ids: taskIds });
});

publicVideoRoutes.post("/video/stop", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { task_ids?: unknown };
  const taskIds = Array.isArray(body.task_ids) ? body.task_ids : [];
  await Promise.all(
    taskIds
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((taskId) =>
        updateOpenAiVideoTaskStatus(c.env.DB, {
          id: taskId.trim(),
          status: "failed",
          errorMessage: "cancelled",
        })),
  );
  return c.json({ status: "success" });
});

publicVideoRoutes.get("/video/sse", async (c) => {
  const taskId = String(c.req.query("task_id") ?? "").trim();
  if (!taskId) return c.text("missing task_id", 400);

  const encoder = new TextEncoder();
  const origin = new URL(c.req.url).origin;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      while (true) {
        const task = await getOpenAiVideoTask(c.env.DB, taskId);
        if (!task) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "task_not_found" })}\n\n`));
          break;
        }
        if (task.status === "failed") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: task.error_message || "video_failed" })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          break;
        }
        if (task.status === "completed" && task.asset_url) {
          const content = `${origin}/v1/videos/${task.id}/content`;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

publicVideoRoutes.get("/video/cache/list", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const pageSize = Math.max(1, Math.min(100, Number(c.req.query("page_size") ?? 20)));
  const { items, total } = await listCacheRowsByType(c.env.DB, "video", pageSize, (page - 1) * pageSize);
  return c.json({
    total,
    items: items.map((item) => ({
      name: item.key.startsWith("video/") ? item.key.slice("video/".length) : item.key,
      size_bytes: item.size,
      mtime_ms: item.last_access_at || item.created_at,
      view_url: toVideoViewUrl(item.key),
    })),
  });
});

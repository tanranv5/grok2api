import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { requireApiAuth, type ApiAuthInfo } from "../auth";
import { addRequestLog } from "../repo/logs";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import { getSettings, normalizeCfCookie } from "../settings";
import { parseVideoExtendResult, requestVideoExtend } from "../grok/videoExtend";

type VideoVars = { apiAuth: ApiAuthInfo };

type VideoExtendBody = {
  prompt?: unknown;
  reference_id?: unknown;
  start_time?: unknown;
  ratio?: unknown;
  length?: unknown;
  resolution?: unknown;
};

const VIDEO_MODEL = "grok-imagine-1.0-video";
const VALID_RATIOS = new Set(["16:9", "9:16", "3:2", "2:3", "1:1"]);
const VALID_RESOLUTIONS = new Set(["480p", "720p"]);

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

function jsonError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function normalizeBody(body: VideoExtendBody) {
  const prompt = String(body.prompt ?? "").trim();
  const referenceId = String(body.reference_id ?? "").trim();
  const startTime = toNumber(body.start_time);
  const ratio = String(body.ratio ?? "2:3").trim();
  const length = Math.trunc(toNumber(body.length ?? 6));
  const resolution = String(body.resolution ?? "480p").trim() as "480p" | "720p";
  return { prompt, referenceId, startTime, ratio, length, resolution };
}

export const videoRoutes = new Hono<{ Bindings: Env; Variables: VideoVars }>();

videoRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

videoRoutes.use("/*", requireApiAuth);

videoRoutes.post("/video/extend", async (c) => {
  const startedAt = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";

  try {
    const rawBody = (await c.req.json()) as VideoExtendBody;
    const body = normalizeBody(rawBody);
    if (!body.prompt) return c.json(jsonError("Missing 'prompt'", "missing_prompt"), 400);
    if (!body.referenceId) return c.json(jsonError("Missing 'reference_id'", "missing_reference_id"), 400);
    if (!Number.isFinite(body.startTime) || body.startTime < 0) {
      return c.json(jsonError("Invalid 'start_time'", "invalid_start_time"), 400);
    }
    if (!VALID_RATIOS.has(body.ratio)) return c.json(jsonError("Invalid 'ratio'", "invalid_ratio"), 400);
    if (body.length < 1 || body.length > 30) return c.json(jsonError("Invalid 'length'", "invalid_length"), 400);
    if (!VALID_RESOLUTIONS.has(body.resolution)) {
      return c.json(jsonError("Invalid 'resolution'", "invalid_resolution"), 400);
    }

    const settings = await getSettings(c.env);
    const chosen = await selectBestToken(c.env.DB, VIDEO_MODEL);
    if (!chosen) return c.json(jsonError("No available token", "NO_AVAILABLE_TOKEN"), 503);

    const cf = normalizeCfCookie(settings.grok.cf_clearance ?? "");
    const cookie = cf
      ? `sso-rw=${chosen.token};sso=${chosen.token};${cf}`
      : `sso-rw=${chosen.token};sso=${chosen.token}`;

    const upstream = await requestVideoExtend({
      prompt: body.prompt,
      referenceId: body.referenceId,
      startTime: body.startTime,
      ratio: body.ratio,
      length: body.length,
      resolution: body.resolution,
      cookie,
      settings: settings.grok,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      await recordTokenFailure(c.env.DB, chosen.token, upstream.status, text.slice(0, 200));
      await applyCooldown(c.env.DB, chosen.token, upstream.status);
      return c.json(jsonError(`Upstream ${upstream.status}: ${text.slice(0, 200)}`, "upstream_error"), 502);
    }

    const result = await parseVideoExtendResult(upstream);
    const duration = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    await addRequestLog(c.env.DB, {
      ip,
      model: VIDEO_MODEL,
      duration,
      status: 200,
      key_name: keyName,
      token_suffix: chosen.token.slice(-6),
      error: "",
    });

    return c.json({
      id: `video_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      object: "video",
      created_at: Math.floor(Date.now() / 1000),
      completed_at: Math.floor(Date.now() / 1000),
      status: "completed",
      prompt: body.prompt,
      reference_id: body.referenceId,
      start_time: body.startTime,
      ratio: body.ratio,
      length: body.length,
      resolution: body.resolution,
      url: result.videoUrl,
      ...(result.thumbnailUrl ? { thumbnail_url: result.thumbnailUrl } : {}),
    });
  } catch (error) {
    const duration = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    await addRequestLog(c.env.DB, {
      ip,
      model: VIDEO_MODEL,
      duration,
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(jsonError(error instanceof Error ? error.message : "Internal error", "internal_error"), 500);
  }
});

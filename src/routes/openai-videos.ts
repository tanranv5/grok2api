import type { Hono } from "hono";
import type { Env } from "../env";
import type { ApiAuthInfo } from "../auth";
import { addRequestLog } from "../repo/logs";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import {
  createOpenAiVideoTask,
  getOpenAiVideoTask,
  updateOpenAiVideoTaskStatus,
} from "../repo/openaiVideoTasks";
import { buildConversationPayload, sendConversationRequest } from "../grok/conversation";
import { createMediaPost } from "../grok/create";
import { getModelInfo } from "../grok/models";
import { uploadImage } from "../grok/upload";
import { getSettings, normalizeCfCookie } from "../settings";
import { arrayBufferToBase64 } from "../utils/base64";

type OpenAiRouteApp = Hono<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }>;
type VideoResolution = "480p" | "720p";
type VideoAspectRatio = "16:9" | "9:16" | "3:2" | "2:3" | "1:1";

interface VideoConfig {
  aspectRatio: VideoAspectRatio;
  videoLength: 6 | 10 | 15;
  resolutionName: VideoResolution;
}

interface CreateVideoRequest {
  prompt: string;
  requestedModel: string;
  inputReference: string | null;
  config: VideoConfig;
}

const DEFAULT_VIDEO_MODEL = "grok-imagine-1.0-video";
const DEFAULT_VIDEO_CONFIG: Readonly<VideoConfig> = {
  aspectRatio: "3:2",
  videoLength: 6,
  resolutionName: "480p",
};
const VIDEO_DURATION_MAP: Readonly<Record<string, 6 | 10 | 15>> = {
  "4": 6,
  "8": 10,
  "12": 15,
};
const VIDEO_SIZE_MAP: Readonly<Record<string, VideoConfig>> = {
  "1280x720": { aspectRatio: "16:9", videoLength: 6, resolutionName: "720p" },
  "720x1280": { aspectRatio: "9:16", videoLength: 6, resolutionName: "720p" },
  "1792x1024": { aspectRatio: "3:2", videoLength: 6, resolutionName: "720p" },
  "1024x1792": { aspectRatio: "2:3", videoLength: 6, resolutionName: "720p" },
  "1024x1024": { aspectRatio: "1:1", videoLength: 6, resolutionName: "480p" },
};

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function getClientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "0.0.0.0";
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const item of bytes) binary += String.fromCharCode(item);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const url = new URL(raw);
    return `u_${base64UrlEncode(url.toString())}`;
  } catch {
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncode(path)}`;
  }
}

function toProxyUrl(origin: string, rawUrl: string): string {
  return `${origin}/images/${encodeAssetPath(rawUrl)}`;
}

async function fileToDataUrl(file: File): Promise<string> {
  const maxBytes = 50 * 1024 * 1024;
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (file.size <= 0) throw new Error("empty_file");
  if (file.size > maxBytes) throw new Error("file_too_large");
  const mime = (file.type || "").toLowerCase() === "image/jpg" ? "image/jpeg" : (file.type || "").toLowerCase();
  if (!allowedTypes.has(mime)) throw new Error("invalid_image_type");
  const b64 = arrayBufferToBase64(await file.arrayBuffer());
  return `data:${mime};base64,${b64}`;
}

function normalizeRequestedVideoModel(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("invalid_model");
  const requested = raw.trim();
  if (!requested) throw new Error("invalid_model");
  return requested;
}

function toInternalVideoModel(requestedModel: string): string {
  void requestedModel;
  return DEFAULT_VIDEO_MODEL;
}

function parseVideoLength(raw: unknown): 6 | 10 | 15 {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_VIDEO_CONFIG.videoLength;
  const mapped = VIDEO_DURATION_MAP[String(raw).trim()];
  return mapped ?? DEFAULT_VIDEO_CONFIG.videoLength;
}

function parseVideoSize(raw: unknown): Pick<VideoConfig, "aspectRatio" | "resolutionName"> {
  if (typeof raw !== "string") {
    return {
      aspectRatio: DEFAULT_VIDEO_CONFIG.aspectRatio,
      resolutionName: DEFAULT_VIDEO_CONFIG.resolutionName,
    };
  }
  const normalized = raw.trim().toLowerCase();
  const mapped = VIDEO_SIZE_MAP[normalized];
  if (!mapped) {
    return {
      aspectRatio: DEFAULT_VIDEO_CONFIG.aspectRatio,
      resolutionName: DEFAULT_VIDEO_CONFIG.resolutionName,
    };
  }
  return { aspectRatio: mapped.aspectRatio, resolutionName: mapped.resolutionName };
}

function parseVideoResult(text: string): { videoUrl: string | null; errorMessage: string | null } {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const errorValue = data.error;
    if (typeof errorValue === "object" && errorValue !== null) {
      const message = (errorValue as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return { videoUrl: null, errorMessage: message.trim() };
      }
    }
    const result = data.result;
    if (typeof result !== "object" || result === null) continue;
    const response = (result as { response?: unknown }).response;
    if (typeof response !== "object" || response === null) continue;
    const video = (response as { streamingVideoGenerationResponse?: unknown }).streamingVideoGenerationResponse;
    if (typeof video !== "object" || video === null) continue;
    const progress = (video as { progress?: unknown }).progress;
    const videoUrl = (video as { videoUrl?: unknown }).videoUrl;
    if (progress === 100 && typeof videoUrl === "string" && videoUrl.trim()) {
      return { videoUrl: videoUrl.trim(), errorMessage: null };
    }
  }
  return { videoUrl: null, errorMessage: "No video url in response" };
}

async function parseCreateVideoRequest(request: Request): Promise<CreateVideoRequest> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const prompt = String(form.get("prompt") || "").trim();
    const requestedModel = normalizeRequestedVideoModel(form.get("model") || "sora-2");
    const inputReferenceValue = form.get("input_reference");
    const inputReference = inputReferenceValue instanceof File ? await fileToDataUrl(inputReferenceValue) : null;
    const length = parseVideoLength(form.get("seconds"));
    const sizeConfig = parseVideoSize(form.get("size"));
    return {
      prompt,
      requestedModel,
      inputReference,
      config: { ...sizeConfig, videoLength: length },
    };
  }

  const body = await request.json() as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const requestedModel = normalizeRequestedVideoModel(body.model ?? "sora-2");
  const imageUrl = typeof body.image_url === "string" ? body.image_url.trim() : "";
  const length = parseVideoLength(body.seconds);
  const sizeConfig = parseVideoSize(body.size);
  return {
    prompt,
    requestedModel,
    inputReference: imageUrl || null,
    config: { ...sizeConfig, videoLength: length },
  };
}

function buildCookie(jwt: string, cfClearance: string): string {
  return cfClearance ? `sso-rw=${jwt};sso=${jwt};${cfClearance}` : `sso-rw=${jwt};sso=${jwt}`;
}

async function runOpenAiVideoTask(args: {
  env: Env;
  taskId: string;
  internalModel: string;
  prompt: string;
  inputReference: string | null;
  config: VideoConfig;
}): Promise<void> {
  const settingsBundle = await getSettings(args.env);
  const chosen = await selectBestToken(args.env.DB, args.internalModel);
  if (!chosen) {
    await updateOpenAiVideoTaskStatus(args.env.DB, {
      id: args.taskId,
      status: "failed",
      errorMessage: "No available token",
    });
    return;
  }

  await updateOpenAiVideoTaskStatus(args.env.DB, { id: args.taskId, status: "in_progress" });

  const jwt = chosen.token;
  const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
  const cookie = buildCookie(jwt, cf);

  try {
    const mediaUrl = args.inputReference
      ? `https://assets.grok.com/${(await uploadImage(args.inputReference, cookie, settingsBundle.grok)).fileUri.replace(/^\/+/, "")}`
      : null;
    const post = mediaUrl
      ? await createMediaPost({ mediaType: "MEDIA_POST_TYPE_IMAGE", mediaUrl }, cookie, settingsBundle.grok)
      : await createMediaPost({ mediaType: "MEDIA_POST_TYPE_VIDEO", prompt: args.prompt }, cookie, settingsBundle.grok);

    const { payload, referer } = buildConversationPayload({
      requestModel: args.internalModel,
      content: args.prompt,
      imgIds: [],
      imgUris: mediaUrl ? [mediaUrl] : [],
      postId: post.postId,
      videoConfig: {
        aspect_ratio: args.config.aspectRatio,
        video_length: args.config.videoLength,
        resolution_name: args.config.resolutionName,
        preset: "normal",
      },
      settings: settingsBundle.grok,
    });

    const upstream = await sendConversationRequest({
      payload,
      cookie,
      settings: settingsBundle.grok,
      ...(referer ? { referer } : {}),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      await recordTokenFailure(args.env.DB, jwt, upstream.status, text.slice(0, 200));
      await applyCooldown(args.env.DB, jwt, upstream.status);
      throw new Error(`Upstream ${upstream.status}: ${text.slice(0, 200)}`);
    }

    const parsed = parseVideoResult(await upstream.text());
    if (!parsed.videoUrl) {
      throw new Error(parsed.errorMessage || "No video url in response");
    }

    await updateOpenAiVideoTaskStatus(args.env.DB, {
      id: args.taskId,
      status: "completed",
      assetUrl: parsed.videoUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordTokenFailure(args.env.DB, jwt, 500, message);
    await applyCooldown(args.env.DB, jwt, 500);
    await updateOpenAiVideoTaskStatus(args.env.DB, {
      id: args.taskId,
      status: "failed",
      errorMessage: message,
    });
  }
}

export function registerOpenAiVideoRoutes(openAiRoutes: OpenAiRouteApp): void {
  openAiRoutes.post("/videos", async (c) => {
    const startedAt = Date.now();
    const origin = new URL(c.req.url).origin;
    const apiAuth = c.get("apiAuth");
    const clientIp = getClientIp(c.req.raw);

    let requestBody: CreateVideoRequest;
    try {
      requestBody = await parseCreateVideoRequest(c.req.raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(openAiError(message || "Invalid request", message || "invalid_request"), 400);
    }

    if (!requestBody.prompt) {
      return c.json(openAiError("Prompt is required", "missing_prompt"), 400);
    }

    const internalModel = toInternalVideoModel(requestBody.requestedModel);
    const modelInfo = getModelInfo(internalModel);
    if (!modelInfo?.is_video_model) {
      return c.json(openAiError(`Model '${requestBody.requestedModel}' not supported`, "model_not_supported"), 400);
    }

    const taskId = `vid_${crypto.randomUUID().replace(/-/g, "")}`;
    await createOpenAiVideoTask(c.env.DB, {
      id: taskId,
      requestedModel: requestBody.requestedModel,
      internalModel,
    });

    c.executionCtx.waitUntil(
      runOpenAiVideoTask({
        env: c.env,
        taskId,
        internalModel,
        prompt: requestBody.prompt,
        inputReference: requestBody.inputReference,
        config: requestBody.config,
      }),
    );

    await addRequestLog(c.env.DB, {
      ip: clientIp,
      model: requestBody.requestedModel,
      duration: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      status: 200,
      key_name: apiAuth.name,
      token_suffix: "",
      error: "",
    });

    return c.json({
      id: taskId,
      object: "video",
      created_at: Math.floor(Date.now() / 1000),
      status: "queued",
      model: requestBody.requestedModel,
    });
  });

  openAiRoutes.get("/videos/:videoId", async (c) => {
    const task = await getOpenAiVideoTask(c.env.DB, c.req.param("videoId"));
    if (!task) {
      return c.json(openAiError("Video task not found", "video_not_found"), 404);
    }

    if (task.status === "failed") {
      return c.json({
        id: task.id,
        object: "video",
        status: task.status,
        model: task.requested_model,
        error: { message: task.error_message || "Video generation failed" },
      });
    }

    return c.json({
      id: task.id,
      object: "video",
      status: task.status,
      model: task.requested_model,
    });
  });

  openAiRoutes.get("/videos/:videoId/content", async (c) => {
    const task = await getOpenAiVideoTask(c.env.DB, c.req.param("videoId"));
    if (!task) {
      return c.json(openAiError("Video task not found", "video_not_found"), 404);
    }
    if (task.status !== "completed" || !task.asset_url) {
      return c.json(openAiError("Video task is not completed", "video_not_ready"), 409);
    }
    return c.redirect(toProxyUrl(new URL(c.req.url).origin, task.asset_url), 307);
  });
}

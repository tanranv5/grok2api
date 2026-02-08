import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { requireApiAuth } from "../auth";
import { getSettings, normalizeCfCookie } from "../settings";
import { isValidModel, MODEL_CONFIG } from "../grok/models";
import { extractContent, buildConversationPayload, sendConversationRequest } from "../grok/conversation";
import { uploadImage } from "../grok/upload";
import { createMediaPost, createPost } from "../grok/create";
import { createOpenAiStreamFromGrokNdjson, parseOpenAiFromGrokNdjson } from "../grok/processor";
import { addRequestLog } from "../repo/logs";
import { applyCooldown, recordTokenFailure, selectBestToken } from "../repo/tokens";
import type { ApiAuthInfo } from "../auth";
import { arrayBufferToBase64 } from "../utils/base64";
import { streamImagineWs } from "../grok/image_ws";

function openAiError(message: string, code: string): Record<string, unknown> {
  return { error: { message, type: "invalid_request_error", code } };
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  const normalized = msg.toLowerCase();
  const keywords = [
    "connection reset",
    "recv failure",
    "connection refused",
    "connection closed",
    "connection error",
    "econnreset",
    "econnrefused",
    "etimedout",
    "timeout",
    "timed out",
    "network is unreachable",
    "fetch failed",
    "tls",
    "ssl",
    "eof",
  ];
  return keywords.some((k) => normalized.includes(k));
}

function validateVideoConfig(input: any): string | null {
  if (!input) return null;
  const aspect = input.aspect_ratio;
  const length = input.video_length;
  const resolution = input.resolution_name;
  if (aspect && !["2:3", "3:2", "1:1", "9:16", "16:9"].includes(String(aspect))) {
    return "invalid_aspect_ratio";
  }
  if (length !== undefined && ![6, 10, 15].includes(Number(length))) {
    return "invalid_video_length";
  }
  if (resolution && !["480p", "720p"].includes(String(resolution))) {
    return "invalid_resolution";
  }
  return null;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stripBase64Prefix(input: string): string {
  if (!input) return "";
  const idx = input.indexOf(",");
  if (idx === -1) return input;
  const head = input.slice(0, idx);
  if (head.toLowerCase().includes("base64")) return input.slice(idx + 1);
  return input;
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `u_${base64UrlEncode(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncode(p)}`;
  }
}

function toImgProxyUrl(globalCfg: { base_url?: string }, origin: string, rawPath: string): string {
  const baseUrl = (globalCfg.base_url ?? "").trim() || origin;
  return `${baseUrl}/images/${rawPath}`;
}

function normalizeGeneratedAssetUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s || s === "/") continue;
    out.push(s);
  }
  return out;
}

function normalizeImageResponseFormat(raw: unknown, fallback: "url" | "b64_json"): "url" | "b64_json" {
  const val = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!val) return fallback;
  if (val === "base64") return "b64_json";
  return val === "b64_json" ? "b64_json" : "url";
}

function resolveAspectRatio(size: string | undefined): string {
  const s = String(size || "").toLowerCase();
  if (["16:9", "9:16", "1:1", "2:3", "3:2"].includes(s)) return s;
  const map: Record<string, string> = {
    "1024x1024": "1:1",
    "512x512": "1:1",
    "1024x576": "16:9",
    "1280x720": "16:9",
    "1536x864": "16:9",
    "576x1024": "9:16",
    "720x1280": "9:16",
    "864x1536": "9:16",
    "1024x1536": "2:3",
    "512x768": "2:3",
    "768x1024": "2:3",
    "1536x1024": "3:2",
    "768x512": "3:2",
    "1024x768": "3:2",
  };
  return map[s] || "2:3";
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type WsCollectedImage = { url: string; blob: string; blob_size: number; is_final: boolean };

function pickBestImage(existing: WsCollectedImage | undefined, incoming: WsCollectedImage): WsCollectedImage {
  if (!existing) return incoming;
  if (incoming.is_final && !existing.is_final) return incoming;
  if (existing.is_final && !incoming.is_final) return existing;
  if (incoming.blob_size > existing.blob_size) return incoming;
  return existing;
}

function buildImageEditPayload(args: {
  modelName: string;
  prompt: string;
  imageUrls: string[];
  parentPostId?: string;
  temporary: boolean;
  imageCount: number;
}): Record<string, unknown> {
  const modelConfigOverride: Record<string, unknown> = {
    modelMap: {
      imageEditModel: "imagine",
      imageEditModelConfig: {
        imageReferences: args.imageUrls,
      },
    },
  };
  if (args.parentPostId) {
    (modelConfigOverride.modelMap as any).imageEditModelConfig.parentPostId = args.parentPostId;
  }

  return {
    temporary: args.temporary,
    modelName: args.modelName,
    message: args.prompt,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: Math.max(1, Math.min(2, args.imageCount)),
    forceConcise: false,
    toolOverrides: { imageGen: true },
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    disableTextFollowUps: true,
    responseMetadata: { modelConfigOverride },
    disableMemory: false,
    forceSideBySide: false,
  };
}

function parseImageUrlsFromNdjson(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const err = (data as any).error;
    if (err?.message) throw new Error(String(err.message));
    const grok = (data as any).result?.response;
    if (!grok) continue;
    const modelResp = grok.modelResponse;
    if (!modelResp) continue;
    if (typeof modelResp.error === "string" && modelResp.error) throw new Error(modelResp.error);
    const urls = normalizeGeneratedAssetUrls(modelResp.generatedImageUrls);
    if (urls.length) return urls;
  }
  return [];
}

async function fileToDataUrl(file: File): Promise<{ dataUrl: string; mime: string }> {
  const maxBytes = 50 * 1024 * 1024;
  if (file.size <= 0) throw new Error("empty_file");
  if (file.size > maxBytes) throw new Error("file_too_large");
  let mime = (file.type || "").toLowerCase();
  if (mime === "image/jpg") mime = "image/jpeg";
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(mime)) throw new Error("invalid_image_type");
  const buf = await file.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  return { dataUrl: `data:${mime};base64,${b64}`, mime };
}

function normalizeAssetUrl(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  const path = s.startsWith("/") ? s : `/${s}`;
  return `https://assets.grok.com${path}`;
}

async function fetchBase64FromUrl(url: string): Promise<string> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) return "";
  const contentType = resp.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buf = await resp.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  return contentType.startsWith("image/") ? b64 : "";
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const item = queue.shift() as T;
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

export const openAiRoutes = new Hono<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }>();

openAiRoutes.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

openAiRoutes.use("/*", requireApiAuth);

openAiRoutes.get("/models", async (c) => {
  const ts = Math.floor(Date.now() / 1000);
  const data = Object.entries(MODEL_CONFIG).map(([id, cfg]) => ({
    id,
    object: "model",
    created: ts,
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  }));
  return c.json({ object: "list", data });
});

openAiRoutes.get("/models/:modelId", async (c) => {
  const modelId = c.req.param("modelId");
  if (!isValidModel(modelId)) return c.json(openAiError(`Model '${modelId}' not found`, "model_not_found"), 404);
  const cfg = MODEL_CONFIG[modelId]!;
  const ts = Math.floor(Date.now() / 1000);
  return c.json({
    id: modelId,
    object: "model",
    created: ts,
    owned_by: "x-ai",
    display_name: cfg.display_name,
    description: cfg.description,
    raw_model_path: cfg.raw_model_path,
    default_temperature: cfg.default_temperature,
    default_max_output_tokens: cfg.default_max_output_tokens,
    supported_max_output_tokens: cfg.supported_max_output_tokens,
    default_top_p: cfg.default_top_p,
  });
});

openAiRoutes.post("/chat/completions", async (c) => {
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";

  const origin = new URL(c.req.url).origin;

  let requestedModel = "";
  try {
    const body = (await c.req.json()) as {
      model?: string;
      messages?: any[];
      stream?: boolean;
      n?: number;
      video_config?: {
        aspect_ratio?: string;
        video_length?: number;
        resolution_name?: string;
        preset?: string;
      };
    };

    requestedModel = String(body.model ?? "");
    if (!requestedModel) return c.json(openAiError("Missing 'model'", "missing_model"), 400);
    if (!Array.isArray(body.messages)) return c.json(openAiError("Missing 'messages'", "missing_messages"), 400);
    if (!isValidModel(requestedModel))
      return c.json(openAiError(`Model '${requestedModel}' not supported`, "model_not_supported"), 400);
    const videoConfigError = validateVideoConfig(body.video_config);
    if (videoConfigError) {
      return c.json(openAiError(`Invalid video_config: ${videoConfigError}`, videoConfigError), 400);
    }

    const settingsBundle = await getSettings(c.env);

    const retryCodes = Array.isArray(settingsBundle.grok.retry_status_codes)
      ? settingsBundle.grok.retry_status_codes
      : [401, 429];

    const stream = Boolean(body.stream);
    const nRaw = body.n;
    if (nRaw !== undefined) {
      const parsed = Number(nRaw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json(openAiError("Invalid 'n', must be a positive integer", "invalid_n"), 400);
      }
    }
    const imageCount = Math.max(1, Number(body.n ?? 1) || 1);
    const maxRetry = Math.max(1, Number(settingsBundle.grok.max_retry ?? 3) || 3);
    const backoffBase = Math.max(0, Number(settingsBundle.grok.retry_backoff_base ?? 1) || 1);
    const backoffFactor = Math.max(1, Number(settingsBundle.grok.retry_backoff_factor ?? 2) || 2);
    const backoffMax = Math.max(0, Number(settingsBundle.grok.retry_backoff_max ?? 30) || 30);
    const retryOnNetworkError = settingsBundle.grok.retry_on_network_error !== false;
    const retryBudget = Math.max(0, Number(settingsBundle.grok.retry_budget ?? 0) || 0);
    let lastErr: string | null = null;
    const backoffMs = (attempt: number) =>
      Math.min(backoffMax, backoffBase * Math.pow(backoffFactor, attempt)) * 1000;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      if (retryBudget > 0 && (Date.now() - start) / 1000 >= retryBudget) {
        lastErr = "Retry budget exceeded";
        break;
      }
      const chosen = await selectBestToken(c.env.DB, requestedModel);
      if (!chosen) return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);

      const jwt = chosen.token;
      const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
      const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

      const { content, images } = extractContent(body.messages as any);
      let cfg = MODEL_CONFIG[requestedModel]!;
      const isVideoModel = Boolean(cfg.is_video_model);
      const imgInputs = isVideoModel && images.length > 1 ? images.slice(0, 1) : images;
      let normalizedContent = content;
      const hasImages = imgInputs.length > 0;
      if (cfg.is_image_model) {
        const trimmed = normalizedContent.trim();
        if (trimmed && !trimmed.toLowerCase().startsWith("image generation:")) {
          normalizedContent = `Image Generation:${normalizedContent}`;
        }
      }

      try {
        const uploads = await mapLimit(imgInputs, 5, (u) => uploadImage(u, cookie, settingsBundle.grok));
        const imgIds = uploads.map((u) => u.fileId).filter(Boolean);
        const imgUris = uploads.map((u) => u.fileUri).filter(Boolean);

        let postId: string | undefined;
        if (isVideoModel) {
          if (imgUris.length) {
            const post = await createPost(imgUris[0]!, cookie, settingsBundle.grok);
            postId = post.postId || undefined;
          } else {
            const post = await createMediaPost(
              { mediaType: "MEDIA_POST_TYPE_VIDEO", prompt: normalizedContent },
              cookie,
              settingsBundle.grok,
            );
            postId = post.postId || undefined;
          }
        }

        if (hasImages && !isVideoModel) {
          const editModel = "grok-imagine-1.0-edit";
          if (!MODEL_CONFIG[editModel]) return c.json(openAiError("Image edit model missing", "model_not_supported"), 400);
          requestedModel = editModel;
          cfg = MODEL_CONFIG[editModel]!;

          const imageUrls = imgUris.filter(Boolean).map(normalizeAssetUrl);
          let parentPostId = "";
          const firstImageUrl = imageUrls[0];
          if (firstImageUrl) {
            try {
              const post = await createMediaPost(
                { mediaType: "MEDIA_POST_TYPE_IMAGE", mediaUrl: firstImageUrl },
                cookie,
                settingsBundle.grok,
              );
              parentPostId = post.postId || "";
            } catch {
              parentPostId = "";
            }
          }

          const payload = buildImageEditPayload({
            modelName: cfg.grok_model[0],
            prompt: normalizedContent,
            imageUrls,
            ...(parentPostId ? { parentPostId } : {}),
            temporary: settingsBundle.grok.temporary ?? true,
            imageCount,
          });

          const upstream = await sendConversationRequest({
            payload,
            cookie,
            settings: settingsBundle.grok,
            referer: "https://grok.com/imagine",
          });

          if (!upstream.ok) {
            const txt = await upstream.text().catch(() => "");
            lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
            await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
            await applyCooldown(c.env.DB, jwt, upstream.status);
            if (retryCodes.includes(upstream.status) && attempt < maxRetry - 1) {
              const delay = backoffMs(attempt);
              if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
              await sleep(delay);
              continue;
            }
            break;
          }

          if (stream) {
            const sse = createOpenAiStreamFromGrokNdjson(upstream, {
              cookie,
              settings: settingsBundle.grok,
              global: settingsBundle.global,
              origin,
              isVideoModel: false,
              onFinish: async ({ status, duration }) => {
                await addRequestLog(c.env.DB, {
                  ip,
                  model: requestedModel,
                  duration: Number(duration.toFixed(2)),
                  status,
                  key_name: keyName,
                  token_suffix: jwt.slice(-6),
                  error: status === 200 ? "" : "stream_error",
                });
              },
            });

            return new Response(sse, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }

          const json = await parseOpenAiFromGrokNdjson(upstream, {
            cookie,
            settings: settingsBundle.grok,
            global: settingsBundle.global,
            origin,
            requestedModel,
          });

          const duration = (Date.now() - start) / 1000;
          await addRequestLog(c.env.DB, {
            ip,
            model: requestedModel,
            duration: Number(duration.toFixed(2)),
            status: 200,
            key_name: keyName,
            token_suffix: jwt.slice(-6),
            error: "",
          });

          return c.json(json);
        }

        const { payload, referer } = buildConversationPayload({
          requestModel: requestedModel,
          content: normalizedContent,
          imgIds,
          imgUris,
          ...(postId ? { postId } : {}),
          ...(isVideoModel && body.video_config ? { videoConfig: body.video_config } : {}),
          settings: settingsBundle.grok,
          imageCount,
        });

        const upstream = await sendConversationRequest({
          payload,
          cookie,
          settings: settingsBundle.grok,
          ...(referer ? { referer } : {}),
        });

        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => "");
          lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
          await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
          await applyCooldown(c.env.DB, jwt, upstream.status);
          if (retryCodes.includes(upstream.status) && attempt < maxRetry - 1) {
            const delay = backoffMs(attempt);
            if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
            await sleep(delay);
            continue;
          }
          break;
        }

        if (stream) {
          const sse = createOpenAiStreamFromGrokNdjson(upstream, {
            cookie,
            settings: settingsBundle.grok,
            global: settingsBundle.global,
            origin,
            isVideoModel,
            onFinish: async ({ status, duration }) => {
              await addRequestLog(c.env.DB, {
                ip,
                model: requestedModel,
                duration: Number(duration.toFixed(2)),
                status,
                key_name: keyName,
                token_suffix: jwt.slice(-6),
                error: status === 200 ? "" : "stream_error",
              });
            },
          });

          return new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        const json = await parseOpenAiFromGrokNdjson(upstream, {
          cookie,
          settings: settingsBundle.grok,
          global: settingsBundle.global,
          origin,
          requestedModel,
        });

        const duration = (Date.now() - start) / 1000;
        await addRequestLog(c.env.DB, {
          ip,
          model: requestedModel,
          duration: Number(duration.toFixed(2)),
          status: 200,
          key_name: keyName,
          token_suffix: jwt.slice(-6),
          error: "",
        });

        return c.json(json);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        await recordTokenFailure(c.env.DB, jwt, 500, msg);
        await applyCooldown(c.env.DB, jwt, 500);
        if (retryOnNetworkError && isNetworkError(e) && attempt < maxRetry - 1) {
          const delay = backoffMs(attempt);
          if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: lastErr ?? "unknown_error",
    });

    return c.json(openAiError(lastErr ?? "Upstream error", "upstream_error"), 500);
  } catch (e) {
    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel || "unknown",
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: e instanceof Error ? e.message : String(e),
    });
    return c.json(openAiError("Internal error", "internal_error"), 500);
  }
});

openAiRoutes.post("/images/generations", async (c) => {
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";
  const origin = new URL(c.req.url).origin;

  let requestedModel = "grok-imagine-1.0";
  try {
    const body = (await c.req.json()) as {
      prompt?: string;
      model?: string;
      n?: number;
      size?: string;
      response_format?: string;
      stream?: boolean;
    };

    const prompt = String(body.prompt ?? "").trim();
    requestedModel = String(body.model ?? "grok-imagine-1.0");
    const n = Math.max(1, Number(body.n ?? 1) || 1);
    const stream = Boolean(body.stream);

    if (!prompt) return c.json(openAiError("Missing 'prompt'", "missing_prompt"), 400);
    if (n < 1 || n > 10) return c.json(openAiError("Invalid 'n'", "invalid_n"), 400);
    if (!isValidModel(requestedModel))
      return c.json(openAiError(`Model '${requestedModel}' not supported`, "model_not_supported"), 400);
    const cfg = MODEL_CONFIG[requestedModel]!;
    if (!cfg.is_image_model || requestedModel !== "grok-imagine-1.0") {
      return c.json(openAiError("Model must be grok-imagine-1.0", "model_not_supported"), 400);
    }
    const settingsBundle = await getSettings(c.env);
    const defaultFormat = settingsBundle.global.image_mode === "base64" ? "b64_json" : "url";
    const responseFormat = normalizeImageResponseFormat(body.response_format, defaultFormat);
    if (stream && responseFormat !== "b64_json") {
      return c.json(
        openAiError("Streaming only supports response_format=b64_json/base64", "invalid_response_format"),
        400,
      );
    }
    if (stream && settingsBundle.grok.image_ws === false) {
      return c.json(openAiError("Streaming is disabled", "stream_disabled"), 400);
    }
    const retryCodes = Array.isArray(settingsBundle.grok.retry_status_codes)
      ? settingsBundle.grok.retry_status_codes
      : [401, 429];
    const maxRetry = Math.max(1, Number(settingsBundle.grok.max_retry ?? 3) || 3);
    const backoffBase = Math.max(0, Number(settingsBundle.grok.retry_backoff_base ?? 1) || 1);
    const backoffFactor = Math.max(1, Number(settingsBundle.grok.retry_backoff_factor ?? 2) || 2);
    const backoffMax = Math.max(0, Number(settingsBundle.grok.retry_backoff_max ?? 30) || 30);
    const retryBudget = Math.max(0, Number(settingsBundle.grok.retry_budget ?? 0) || 0);
    const retryOnNetworkError = settingsBundle.grok.retry_on_network_error !== false;
    const backoffMs = (attempt: number) =>
      Math.min(backoffMax, backoffBase * Math.pow(backoffFactor, attempt)) * 1000;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let lastErr: string | null = null;
    for (let attempt = 0; attempt < maxRetry; attempt++) {
      if (retryBudget > 0 && (Date.now() - start) / 1000 >= retryBudget) {
        lastErr = "Retry budget exceeded";
        break;
      }

      const chosen = await selectBestToken(c.env.DB, requestedModel);
      if (!chosen) return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);
      const jwt = chosen.token;
      const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
      const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

      try {
        if (stream && settingsBundle.grok.image_ws !== false) {
          const aspectRatio = resolveAspectRatio(body.size);
          const wsStream = streamImagineWs({
            cookie,
            prompt,
            aspect_ratio: aspectRatio,
            n: Math.min(2, n),
            enable_nsfw: settingsBundle.grok.image_ws_nsfw !== false,
            timeout: Math.max(10, Number(settingsBundle.grok.stream_idle_timeout ?? 120) || 120),
            blocked_seconds: Math.max(5, Number(settingsBundle.grok.image_ws_blocked_seconds ?? 15) || 15),
            final_min_bytes: Math.max(1, Number(settingsBundle.grok.image_ws_final_min_bytes ?? 100000) || 100000),
            medium_min_bytes: Math.max(1, Number(settingsBundle.grok.image_ws_medium_min_bytes ?? 30000) || 30000),
          });

          const encoder = new TextEncoder();
          const sse = new ReadableStream<Uint8Array>({
            async start(controller) {
              const images = new Map<string, any>();
              const indexMap = new Map<string, number>();
              const partialMap = new Map<string, number>();
              let targetId: string | null = null;

              try {
                for await (const item of wsStream) {
                  if (item.type === "error") {
                    controller.enqueue(
                      encoder.encode(
                        sseEvent("error", {
                          error: { message: item.error, type: "server_error", code: item.error_code },
                        }),
                      ),
                    );
                    controller.close();
                    return;
                  }

                  const imageId = item.image_id;
                  if (!imageId) continue;
                  images.set(imageId, item);

                  let index: number | null = null;
                  if (n === 1) {
                    if (!targetId) targetId = imageId;
                    index = imageId === targetId ? 0 : null;
                  } else {
                    if (indexMap.has(imageId)) index = indexMap.get(imageId)!;
                    else if (indexMap.size < n) {
                      index = indexMap.size;
                      indexMap.set(imageId, index);
                    }
                  }
                  if (index == null) continue;

                  if (item.stage !== "final") {
                    const partialB64 = stripBase64Prefix(item.blob || "");
                    if (!partialB64) continue;
                    const prev = partialMap.get(imageId) ?? 0;
                    const next = item.stage === "medium" ? Math.max(prev, 1) : prev;
                    partialMap.set(imageId, next);
                    controller.enqueue(
                      encoder.encode(
                        sseEvent("image_generation.partial_image", {
                          type: "image_generation.partial_image",
                          b64_json: partialB64,
                          created_at: Math.floor(Date.now() / 1000),
                          size: body.size ?? "1024x1024",
                          index,
                          partial_image_index: next,
                        }),
                      ),
                    );
                  }
                }

                const selected: Array<{ id: string; item: any }> = [];
                if (n === 1) {
                  if (targetId && images.has(targetId)) selected.push({ id: targetId, item: images.get(targetId) });
                } else {
                  for (const [id, idx] of indexMap.entries()) {
                    if (images.has(id)) selected.push({ id, item: images.get(id) });
                  }
                }

                for (const entry of selected) {
                  const out = stripBase64Prefix(entry.item.blob || "");
                  if (!out) continue;
                  const index = n === 1 ? 0 : (indexMap.get(entry.id) ?? 0);
                  controller.enqueue(
                    encoder.encode(
                      sseEvent("image_generation.completed", {
                        type: "image_generation.completed",
                        b64_json: out,
                        created_at: Math.floor(Date.now() / 1000),
                        size: body.size ?? "1024x1024",
                        index,
                        usage: {
                          total_tokens: 0,
                          input_tokens: 0,
                          output_tokens: 0,
                          input_tokens_details: { text_tokens: 0, image_tokens: 0 },
                        },
                      }),
                    ),
                  );
                }
              } finally {
                controller.close();
              }
            },
          });

          return new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        if (settingsBundle.grok.image_ws !== false) {
          const aspectRatio = resolveAspectRatio(body.size);
          const expectedPerCall = 6;
          const callsNeeded = Math.max(1, Math.ceil(n / expectedPerCall));
          const images = new Map<string, WsCollectedImage>();

          for (let i = 0; i < callsNeeded; i++) {
            const remaining = n - i * expectedPerCall;
            const target = Math.min(expectedPerCall, remaining);
            const wsStream = streamImagineWs({
              cookie,
              prompt,
              aspect_ratio: aspectRatio,
              n: target,
              enable_nsfw: settingsBundle.grok.image_ws_nsfw !== false,
              timeout: Math.max(10, Number(settingsBundle.grok.stream_idle_timeout ?? 120) || 120),
              blocked_seconds: Math.max(5, Number(settingsBundle.grok.image_ws_blocked_seconds ?? 15) || 15),
              final_min_bytes: Math.max(1, Number(settingsBundle.grok.image_ws_final_min_bytes ?? 100000) || 100000),
              medium_min_bytes: Math.max(1, Number(settingsBundle.grok.image_ws_medium_min_bytes ?? 30000) || 30000),
            });

            for await (const item of wsStream) {
              if (item.type === "error") throw new Error(item.error || "image_ws_error");
              const url = normalizeAssetUrl(item.url || "");
              if (!url) continue;
              const blob = stripBase64Prefix(item.blob || "");
              const collected: WsCollectedImage = {
                url,
                blob,
                blob_size: item.blob_size || blob.length,
                is_final: Boolean(item.is_final),
              };
              const existing = images.get(item.image_id);
              images.set(item.image_id, pickBestImage(existing, collected));
            }
          }

          const sorted = Array.from(images.values()).sort((a, b) => {
            if (a.is_final !== b.is_final) return a.is_final ? -1 : 1;
            return b.blob_size - a.blob_size;
          });

          const selected = sorted.slice(0, n);
          while (selected.length < n) selected.push({ url: "", blob: "", blob_size: 0, is_final: false });

          const data = selected.map((img) => {
            if (responseFormat === "url") {
              if (!img.url) return { url: "error" };
              const encoded = encodeAssetPath(img.url);
              return { url: toImgProxyUrl(settingsBundle.global, origin, encoded) };
            }
            return { b64_json: img.blob || "error" };
          });

          const duration = (Date.now() - start) / 1000;
          await addRequestLog(c.env.DB, {
            ip,
            model: requestedModel,
            duration: Number(duration.toFixed(2)),
            status: 200,
            key_name: keyName,
            token_suffix: jwt.slice(-6),
            error: "",
          });

          return c.json({
            created: Math.floor(Date.now() / 1000),
            data,
            usage: {
              total_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              input_tokens_details: { text_tokens: 0, image_tokens: 0 },
            },
          });
        }

        const { payload } = buildConversationPayload({
          requestModel: requestedModel,
          content: prompt,
          imgIds: [],
          imgUris: [],
          settings: settingsBundle.grok,
          imageCount: n,
        });

        const upstream = await sendConversationRequest({
          payload,
          cookie,
          settings: settingsBundle.grok,
        });

        if (!upstream.ok) {
          const txt = await upstream.text().catch(() => "");
          lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
          await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
          await applyCooldown(c.env.DB, jwt, upstream.status);
          if (retryCodes.includes(upstream.status) && attempt < maxRetry - 1) {
            const delay = backoffMs(attempt);
            if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
            await sleep(delay);
            continue;
          }
          break;
        }

        const text = await upstream.text();
        const urls = parseImageUrlsFromNdjson(text);
        if (!urls.length) throw new Error("No image urls in response");

        const allUrls = urls.map((u) => normalizeAssetUrl(u));
        const selected = allUrls.slice(0, n);
        while (selected.length < n) selected.push("error");

        const items = await mapLimit(selected, 3, async (u) => {
          if (u === "error") return { error: true, value: "" };
          if (responseFormat === "url") {
            const encoded = encodeAssetPath(u);
            return { error: false, value: toImgProxyUrl(settingsBundle.global, origin, encoded) };
          }
          const b64 = await fetchBase64FromUrl(u);
          return { error: false, value: b64 || "error" };
        });

        const data = items.map((d) => (responseFormat === "url" ? { url: d.value } : { b64_json: d.value }));

        const duration = (Date.now() - start) / 1000;
        await addRequestLog(c.env.DB, {
          ip,
          model: requestedModel,
          duration: Number(duration.toFixed(2)),
          status: 200,
          key_name: keyName,
          token_suffix: jwt.slice(-6),
          error: "",
        });

        return c.json({
          created: Math.floor(Date.now() / 1000),
          data,
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            input_tokens_details: { text_tokens: 0, image_tokens: 0 },
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastErr = msg;
        await recordTokenFailure(c.env.DB, jwt, 500, msg);
        await applyCooldown(c.env.DB, jwt, 500);
        if (retryOnNetworkError && isNetworkError(e) && attempt < maxRetry - 1) {
          const delay = backoffMs(attempt);
          if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel,
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: lastErr ?? "unknown_error",
    });

    return c.json(openAiError(lastErr ?? "Upstream error", "upstream_error"), 500);
  } catch (e) {
    const duration = (Date.now() - start) / 1000;
    await addRequestLog(c.env.DB, {
      ip,
      model: requestedModel || "unknown",
      duration: Number(duration.toFixed(2)),
      status: 500,
      key_name: keyName,
      token_suffix: "",
      error: e instanceof Error ? e.message : String(e),
    });
    return c.json(openAiError("Internal error", "internal_error"), 500);
  }
});

openAiRoutes.post("/images/edits", async (c) => {
  const start = Date.now();
  const ip = getClientIp(c.req.raw);
  const keyName = c.get("apiAuth").name ?? "Unknown";
  const origin = new URL(c.req.url).origin;

  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json(openAiError("Only multipart/form-data is supported", "invalid_content_type"), 400);
  }

  const form = await c.req.formData();
  const prompt = String(form.get("prompt") ?? "").trim();
  const model = String(form.get("model") ?? "grok-imagine-1.0-edit").trim();
  const nRaw = form.get("n");
  const n = nRaw == null ? 1 : Math.floor(Number(nRaw));
  const responseFormatRaw = form.get("response_format");
  const streamRaw = form.get("stream");
  const stream = streamRaw === "true" || streamRaw === "1";

  if (!prompt) return c.json(openAiError("Missing 'prompt'", "missing_prompt"), 400);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    return c.json(openAiError("Invalid 'n', must be between 1 and 10", "invalid_n"), 400);
  }
  if (stream) {
    return c.json(openAiError("Streaming is not supported for image edits", "stream_not_supported"), 400);
  }

  if (!isValidModel(model)) {
    return c.json(openAiError(`Model '${model}' not supported`, "model_not_supported"), 400);
  }
  const cfg = MODEL_CONFIG[model]!;
  if (!cfg.is_image_model || model !== "grok-imagine-1.0-edit") {
    return c.json(openAiError("Model must be grok-imagine-1.0-edit", "model_not_supported"), 400);
  }

  const images = form.getAll("image").filter((v) => v instanceof File) as File[];
  if (!images.length) return c.json(openAiError("Missing 'image' file", "missing_image"), 400);

  const settingsBundle = await getSettings(c.env);
  const defaultFormat = settingsBundle.global.image_mode === "base64" ? "b64_json" : "url";
  const responseFormat = normalizeImageResponseFormat(responseFormatRaw, defaultFormat);

  const retryCodes = Array.isArray(settingsBundle.grok.retry_status_codes)
    ? settingsBundle.grok.retry_status_codes
    : [401, 429];
  const maxRetry = Math.max(1, Number(settingsBundle.grok.max_retry ?? 3) || 3);
  const backoffBase = Math.max(0, Number(settingsBundle.grok.retry_backoff_base ?? 1) || 1);
  const backoffFactor = Math.max(1, Number(settingsBundle.grok.retry_backoff_factor ?? 2) || 2);
  const backoffMax = Math.max(0, Number(settingsBundle.grok.retry_backoff_max ?? 30) || 30);
  const retryOnNetworkError = settingsBundle.grok.retry_on_network_error !== false;
  const retryBudget = Math.max(0, Number(settingsBundle.grok.retry_budget ?? 0) || 0);
  const backoffMs = (attempt: number) =>
    Math.min(backoffMax, backoffBase * Math.pow(backoffFactor, attempt)) * 1000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let lastErr: string | null = null;

  for (let attempt = 0; attempt < maxRetry; attempt++) {
    if (retryBudget > 0 && (Date.now() - start) / 1000 >= retryBudget) {
      lastErr = "Retry budget exceeded";
      break;
    }
    const chosen = await selectBestToken(c.env.DB, model);
    if (!chosen) return c.json(openAiError("No available token", "NO_AVAILABLE_TOKEN"), 503);

    const jwt = chosen.token;
    const cf = normalizeCfCookie(settingsBundle.grok.cf_clearance ?? "");
    const cookie = cf ? `sso-rw=${jwt};sso=${jwt};${cf}` : `sso-rw=${jwt};sso=${jwt}`;

    try {
      const dataUrls: string[] = [];
      for (const file of images) {
        const { dataUrl } = await fileToDataUrl(file);
        dataUrls.push(dataUrl);
      }

      const uploads = await mapLimit(dataUrls, 4, (u) => uploadImage(u, cookie, settingsBundle.grok));
      const imageUrls = uploads
        .map((u) => u.fileUri)
        .filter(Boolean)
        .map(normalizeAssetUrl);

      if (!imageUrls.length) throw new Error("Image upload failed");

      let parentPostId = "";
      const firstImageUrl = imageUrls[0];
      if (firstImageUrl) {
        try {
          const post = await createMediaPost(
            { mediaType: "MEDIA_POST_TYPE_IMAGE", mediaUrl: firstImageUrl },
            cookie,
            settingsBundle.grok,
          );
          parentPostId = post.postId || "";
        } catch {
          parentPostId = "";
        }
      }

      const payload = buildImageEditPayload({
        modelName: cfg.grok_model[0],
        prompt,
        imageUrls,
        ...(parentPostId ? { parentPostId } : {}),
        temporary: settingsBundle.grok.temporary ?? true,
        imageCount: n,
      });

      const upstream = await sendConversationRequest({
        payload,
        cookie,
        settings: settingsBundle.grok,
        referer: "https://grok.com/imagine",
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => "");
        lastErr = `Upstream ${upstream.status}: ${txt.slice(0, 200)}`;
        await recordTokenFailure(c.env.DB, jwt, upstream.status, txt.slice(0, 200));
        await applyCooldown(c.env.DB, jwt, upstream.status);
        if (retryCodes.includes(upstream.status) && attempt < maxRetry - 1) {
          const delay = backoffMs(attempt);
          if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
          await sleep(delay);
          continue;
        }
        break;
      }

      const text = await upstream.text();
      const urls = parseImageUrlsFromNdjson(text);
      if (!urls.length) throw new Error("No image urls in response");

      const allUrls = urls.map((u) => normalizeAssetUrl(u));
      const selected = allUrls.slice(0, n);
      while (selected.length < n) selected.push("error");

      const data = await mapLimit(selected, 3, async (u) => {
        if (u === "error") return { error: true, value: "" };
        if (responseFormat === "url") {
          const encoded = encodeAssetPath(u);
          return { error: false, value: toImgProxyUrl(settingsBundle.global, origin, encoded) };
        }
        const b64 = await fetchBase64FromUrl(u);
        return { error: false, value: b64 || "error" };
      });

      const items = data.map((d) => {
        if (responseFormat === "url") return { url: d.value };
        return { b64_json: d.value };
      });

      const duration = (Date.now() - start) / 1000;
      await addRequestLog(c.env.DB, {
        ip,
        model,
        duration: Number(duration.toFixed(2)),
        status: 200,
        key_name: keyName,
        token_suffix: jwt.slice(-6),
        error: "",
      });

      return c.json({
        created: Math.floor(Date.now() / 1000),
        data: items,
        usage: {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          input_tokens_details: { text_tokens: 0, image_tokens: 0 },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;
      await recordTokenFailure(c.env.DB, jwt, 500, msg);
      await applyCooldown(c.env.DB, jwt, 500);
      if (retryOnNetworkError && isNetworkError(e) && attempt < maxRetry - 1) {
        const delay = backoffMs(attempt);
        if (retryBudget > 0 && (Date.now() - start + delay) / 1000 > retryBudget) break;
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  const duration = (Date.now() - start) / 1000;
  await addRequestLog(c.env.DB, {
    ip,
    model,
    duration: Number(duration.toFixed(2)),
    status: 500,
    key_name: keyName,
    token_suffix: "",
    error: lastErr ?? "unknown_error",
  });

  return c.json(openAiError(lastErr ?? "Upstream error", "upstream_error"), 500);
});

openAiRoutes.options("/*", (c) => c.body(null, 204));

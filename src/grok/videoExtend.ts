import type { GrokSettings } from "../settings";
import { sendConversationRequest } from "./conversation";

export interface VideoExtendArgs {
  prompt: string;
  referenceId: string;
  startTime: number;
  ratio: string;
  length: number;
  resolution: "480p" | "720p";
  cookie: string;
  settings: GrokSettings;
}

export interface VideoExtendResult {
  videoUrl: string;
  thumbnailUrl?: string;
}

export async function requestVideoExtend(args: VideoExtendArgs): Promise<Response> {
  const payload = {
    temporary: args.settings.temporary ?? true,
    modelName: "grok-3",
    message: `${args.prompt} --mode=custom`.trim(),
    toolOverrides: { videoGen: true },
    enableSideBySide: true,
    responseMetadata: {
      experiments: [],
      modelConfigOverride: {
        modelMap: {
          videoGenModelConfig: {
            isVideoExtension: true,
            videoExtensionStartTime: args.startTime,
            extendPostId: args.referenceId,
            stitchWithExtendPostId: true,
            originalPrompt: args.prompt,
            originalPostId: args.referenceId,
            originalRefType: "ORIGINAL_REF_TYPE_VIDEO_EXTENSION",
            mode: "custom",
            aspectRatio: args.ratio,
            videoLength: args.length,
            resolutionName: args.resolution,
            parentPostId: args.referenceId,
            isVideoEdit: false,
          },
        },
      },
    },
  };

  return sendConversationRequest({
    payload,
    cookie: args.cookie,
    settings: args.settings,
    referer: "https://grok.com/imagine",
  });
}

export async function parseVideoExtendResult(response: Response): Promise<VideoExtendResult> {
  const text = await response.text();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let lastError = "";

  for (const line of lines) {
    let data: any = null;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }

    if (data?.error?.message) lastError = String(data.error.message);
    const videoResp = data?.result?.response?.streamingVideoGenerationResponse;
    if (!videoResp?.videoUrl || typeof videoResp.videoUrl !== "string") continue;
    return {
      videoUrl: videoResp.videoUrl,
      ...(typeof videoResp.thumbnailImageUrl === "string" && videoResp.thumbnailImageUrl
        ? { thumbnailUrl: videoResp.thumbnailImageUrl }
        : {}),
    };
  }

  throw new Error(lastError || "Video extension failed: missing video URL");
}

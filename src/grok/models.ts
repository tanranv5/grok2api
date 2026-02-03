import modelData from "../../shared/models.json";

export interface ModelInfo {
  grok_model: [string, string];
  rate_limit_model: string;
  display_name: string;
  description: string;
  raw_model_path: string;
  default_temperature: number;
  default_max_output_tokens: number;
  supported_max_output_tokens: number;
  default_top_p: number;
  is_video_model?: boolean;
}

type SharedModel = {
  id: string;
  grok_model: string;
  model_mode: string;
  rate_limit_model?: string;
  display_name: string;
  description?: string;
  raw_model_path?: string;
  default_temperature?: number;
  default_max_output_tokens?: number;
  supported_max_output_tokens?: number;
  default_top_p?: number;
  is_video?: boolean;
};

const shared = modelData as { aliases?: Record<string, string>; models?: SharedModel[] };
const ALIASES = shared.aliases ?? {};

export const MODEL_CONFIG: Record<string, ModelInfo> = {};

for (const item of shared.models ?? []) {
  MODEL_CONFIG[item.id] = {
    grok_model: [item.grok_model, item.model_mode || "MODEL_MODE_FAST"],
    rate_limit_model: item.rate_limit_model ?? item.grok_model,
    display_name: item.display_name,
    description: item.description ?? "",
    raw_model_path: item.raw_model_path ?? "",
    default_temperature: item.default_temperature ?? 1.0,
    default_max_output_tokens: item.default_max_output_tokens ?? 8192,
    supported_max_output_tokens: item.supported_max_output_tokens ?? 131072,
    default_top_p: item.default_top_p ?? 0.95,
    is_video_model: Boolean(item.is_video),
  };
}

export function normalizeModel(model: string): string {
  return ALIASES[model] ?? model;
}

export function isValidModel(model: string): boolean {
  return Boolean(MODEL_CONFIG[normalizeModel(model)]);
}

export function getModelInfo(model: string): ModelInfo | null {
  return MODEL_CONFIG[normalizeModel(model)] ?? null;
}

export function toGrokModel(model: string): { grokModel: string; mode: string; isVideoModel: boolean } {
  const cfg = MODEL_CONFIG[normalizeModel(model)];
  if (!cfg) return { grokModel: model, mode: "MODEL_MODE_FAST", isVideoModel: false };
  return { grokModel: cfg.grok_model[0], mode: cfg.grok_model[1], isVideoModel: Boolean(cfg.is_video_model) };
}

export function toRateLimitModel(model: string): string {
  return MODEL_CONFIG[normalizeModel(model)]?.rate_limit_model ?? model;
}

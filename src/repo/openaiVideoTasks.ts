import type { Env } from "../env";
import { dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

export type OpenAiVideoTaskStatus = "queued" | "in_progress" | "completed" | "failed";

export interface OpenAiVideoTaskRow {
  id: string;
  requested_model: string;
  internal_model: string;
  status: OpenAiVideoTaskStatus;
  asset_url: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export async function createOpenAiVideoTask(
  db: Env["DB"],
  input: { id: string; requestedModel: string; internalModel: string },
): Promise<void> {
  const timestamp = nowMs();
  await dbRun(
    db,
    `INSERT INTO openai_video_tasks(
      id, requested_model, internal_model, status, asset_url, error_message, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?)`,
    [input.id, input.requestedModel, input.internalModel, "queued", null, null, timestamp, timestamp],
  );
}

export async function updateOpenAiVideoTaskStatus(
  db: Env["DB"],
  input: { id: string; status: OpenAiVideoTaskStatus; assetUrl?: string; errorMessage?: string },
): Promise<void> {
  await dbRun(
    db,
    `UPDATE openai_video_tasks
     SET status = ?, asset_url = ?, error_message = ?, updated_at = ?
     WHERE id = ?`,
    [input.status, input.assetUrl ?? null, input.errorMessage ?? null, nowMs(), input.id],
  );
}

export async function getOpenAiVideoTask(
  db: Env["DB"],
  id: string,
): Promise<OpenAiVideoTaskRow | null> {
  return dbFirst<OpenAiVideoTaskRow>(
    db,
    `SELECT id, requested_model, internal_model, status, asset_url, error_message, created_at, updated_at
     FROM openai_video_tasks
     WHERE id = ?`,
    [id],
  );
}

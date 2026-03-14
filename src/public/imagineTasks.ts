import type { Env } from "../env";

const TASK_PREFIX = "public:imagine:";
const TASK_TTL_SECONDS = 60 * 30;

export interface ImagineTaskSession {
  taskId: string;
  prompt: string;
  aspectRatio: string;
  nsfw: boolean;
  createdAt: number;
}

function taskKey(taskId: string): string {
  return `${TASK_PREFIX}${taskId}`;
}

export async function createImagineTaskSession(
  env: Env,
  input: { prompt: string; aspectRatio: string; nsfw: boolean },
): Promise<ImagineTaskSession> {
  const session: ImagineTaskSession = {
    taskId: crypto.randomUUID(),
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    nsfw: input.nsfw,
    createdAt: Date.now(),
  };
  await env.KV_CACHE.put(taskKey(session.taskId), JSON.stringify(session), {
    expirationTtl: TASK_TTL_SECONDS,
  });
  return session;
}

export async function getImagineTaskSession(
  env: Env,
  taskId: string,
): Promise<ImagineTaskSession | null> {
  const raw = await env.KV_CACHE.get(taskKey(taskId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImagineTaskSession>;
    if (!parsed.taskId || !parsed.prompt || !parsed.aspectRatio) return null;
    return {
      taskId: parsed.taskId,
      prompt: parsed.prompt,
      aspectRatio: parsed.aspectRatio,
      nsfw: parsed.nsfw !== false,
      createdAt: Number(parsed.createdAt ?? Date.now()),
    };
  } catch {
    return null;
  }
}

export async function deleteImagineTaskSessions(env: Env, taskIds: string[]): Promise<number> {
  const normalized = Array.from(
    new Set(taskIds.map((item) => item.trim()).filter((item) => item.length > 0)),
  );
  await Promise.all(normalized.map((taskId) => env.KV_CACHE.delete(taskKey(taskId))));
  return normalized.length;
}

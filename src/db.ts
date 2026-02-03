import type { Env } from "./env";

export async function dbFirst<T>(
  db: Env["DB"],
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const stmt = db.prepare(sql).bind(...params);
  const row = await stmt.first<T>();
  return row ?? null;
}

export async function dbAll<T>(
  db: Env["DB"],
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const stmt = db.prepare(sql).bind(...params);
  const res = await stmt.all<T>();
  return res.results ?? [];
}

export async function dbRun(
  db: Env["DB"],
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const stmt = db.prepare(sql).bind(...params);
  await stmt.run();
}


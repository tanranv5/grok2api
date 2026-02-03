import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";
import { generateApiKey } from "../utils/crypto";
import { nowMs } from "../utils/time";

export interface ApiKeyRow {
  key: string;
  name: string;
  created_at: number;
  is_active: number;
}

export async function listApiKeys(db: Env["DB"]): Promise<ApiKeyRow[]> {
  return dbAll<ApiKeyRow>(db, "SELECT key, name, created_at, is_active FROM api_keys ORDER BY created_at DESC");
}

export async function addApiKey(db: Env["DB"], name: string): Promise<ApiKeyRow> {
  const key = generateApiKey();
  const created_at = Math.floor(nowMs() / 1000);
  await dbRun(
    db,
    "INSERT INTO api_keys(key,name,created_at,is_active) VALUES(?,?,?,1)",
    [key, name, created_at],
  );
  return { key, name, created_at, is_active: 1 };
}

export async function batchAddApiKeys(
  db: Env["DB"],
  name_prefix: string,
  count: number,
): Promise<ApiKeyRow[]> {
  const created_at = Math.floor(nowMs() / 1000);
  const rows: ApiKeyRow[] = [];
  for (let i = 1; i <= count; i++) {
    const name = count > 1 ? `${name_prefix}-${i}` : name_prefix;
    const key = generateApiKey();
    rows.push({ key, name, created_at, is_active: 1 });
  }
  const batch = db.batch(
    rows.map((r) => db.prepare("INSERT INTO api_keys(key,name,created_at,is_active) VALUES(?,?,?,1)").bind(r.key, r.name, r.created_at)),
  );
  await batch;
  return rows;
}

export async function deleteApiKey(db: Env["DB"], key: string): Promise<boolean> {
  const existing = await dbFirst<{ key: string }>(db, "SELECT key FROM api_keys WHERE key = ?", [key]);
  if (!existing) return false;
  await dbRun(db, "DELETE FROM api_keys WHERE key = ?", [key]);
  return true;
}

export async function batchDeleteApiKeys(db: Env["DB"], keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const before = await dbFirst<{ c: number }>(db, `SELECT COUNT(1) as c FROM api_keys WHERE key IN (${placeholders})`, keys);
  await dbRun(db, `DELETE FROM api_keys WHERE key IN (${placeholders})`, keys);
  return before?.c ?? 0;
}

export async function updateApiKeyStatus(db: Env["DB"], key: string, is_active: boolean): Promise<boolean> {
  const existing = await dbFirst<{ key: string }>(db, "SELECT key FROM api_keys WHERE key = ?", [key]);
  if (!existing) return false;
  await dbRun(db, "UPDATE api_keys SET is_active = ? WHERE key = ?", [is_active ? 1 : 0, key]);
  return true;
}

export async function batchUpdateApiKeyStatus(
  db: Env["DB"],
  keys: string[],
  is_active: boolean,
): Promise<number> {
  if (!keys.length) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const before = await dbFirst<{ c: number }>(db, `SELECT COUNT(1) as c FROM api_keys WHERE key IN (${placeholders})`, keys);
  await dbRun(db, `UPDATE api_keys SET is_active = ? WHERE key IN (${placeholders})`, [is_active ? 1 : 0, ...keys]);
  return before?.c ?? 0;
}

export async function updateApiKeyName(db: Env["DB"], key: string, name: string): Promise<boolean> {
  const existing = await dbFirst<{ key: string }>(db, "SELECT key FROM api_keys WHERE key = ?", [key]);
  if (!existing) return false;
  await dbRun(db, "UPDATE api_keys SET name = ? WHERE key = ?", [name, key]);
  return true;
}

export async function validateApiKey(db: Env["DB"], key: string): Promise<{ key: string; name: string } | null> {
  const row = await dbFirst<{ key: string; name: string; is_active: number }>(
    db,
    "SELECT key, name, is_active FROM api_keys WHERE key = ?",
    [key],
  );
  if (!row) return null;
  if (!row.is_active) return null;
  return { key: row.key, name: row.name };
}


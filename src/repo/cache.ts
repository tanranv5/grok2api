import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";

export type CacheType = "image" | "video";

export interface CacheRow {
  key: string;
  type: CacheType;
  size: number;
  content_type: string | null;
  created_at: number;
  last_access_at: number;
  expires_at: number | null;
}

export async function upsertCacheRow(db: Env["DB"], row: CacheRow): Promise<void> {
  await dbRun(
    db,
    `INSERT INTO kv_cache(key,type,size,content_type,created_at,last_access_at,expires_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       type=excluded.type,
       size=excluded.size,
       content_type=excluded.content_type,
       last_access_at=excluded.last_access_at,
       expires_at=excluded.expires_at`,
    [row.key, row.type, row.size, row.content_type, row.created_at, row.last_access_at, row.expires_at],
  );
}

export async function touchCacheRow(db: Env["DB"], key: string, at: number): Promise<void> {
  await dbRun(db, "UPDATE kv_cache SET last_access_at = ? WHERE key = ?", [at, key]);
}

export async function deleteCacheRow(db: Env["DB"], key: string): Promise<void> {
  await dbRun(db, "DELETE FROM kv_cache WHERE key = ?", [key]);
}

export async function deleteCacheRows(db: Env["DB"], keys: string[]): Promise<void> {
  if (!keys.length) return;
  const placeholders = keys.map(() => "?").join(",");
  await dbRun(db, `DELETE FROM kv_cache WHERE key IN (${placeholders})`, keys);
}

export async function getCacheSizeBytes(db: Env["DB"]): Promise<{ image: number; video: number; total: number }> {
  const rows = await dbAll<{ type: CacheType; bytes: number }>(db, "SELECT type, COALESCE(SUM(size),0) as bytes FROM kv_cache GROUP BY type");
  let image = 0;
  let video = 0;
  for (const r of rows) {
    if (r.type === "image") image = r.bytes;
    if (r.type === "video") video = r.bytes;
  }
  return { image, video, total: image + video };
}

export async function listCacheRowsByType(
  db: Env["DB"],
  type: CacheType,
  limit: number,
  offset: number,
): Promise<{ total: number; items: CacheRow[] }> {
  const totalRow = await dbFirst<{ c: number }>(db, "SELECT COUNT(1) as c FROM kv_cache WHERE type = ?", [type]);
  const items = await dbAll<CacheRow>(
    db,
    "SELECT key,type,size,content_type,created_at,last_access_at,expires_at FROM kv_cache WHERE type = ? ORDER BY last_access_at DESC LIMIT ? OFFSET ?",
    [type, limit, offset],
  );
  return { total: totalRow?.c ?? 0, items };
}

export async function listOldestRows(
  db: Env["DB"],
  type: CacheType | null,
  beforeMs: number | null,
  limit: number,
): Promise<Pick<CacheRow, "key" | "type" | "size" | "last_access_at">[]> {
  if (type && beforeMs !== null) {
    return dbAll(db, "SELECT key,type,size,last_access_at FROM kv_cache WHERE type=? AND last_access_at < ? ORDER BY last_access_at ASC LIMIT ?", [type, beforeMs, limit]);
  }
  if (type) {
    return dbAll(db, "SELECT key,type,size,last_access_at FROM kv_cache WHERE type=? ORDER BY last_access_at ASC LIMIT ?", [type, limit]);
  }
  if (beforeMs !== null) {
    return dbAll(db, "SELECT key,type,size,last_access_at FROM kv_cache WHERE last_access_at < ? ORDER BY last_access_at ASC LIMIT ?", [beforeMs, limit]);
  }
  return dbAll(db, "SELECT key,type,size,last_access_at FROM kv_cache ORDER BY last_access_at ASC LIMIT ?", [limit]);
}


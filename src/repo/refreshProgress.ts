import type { Env } from "../env";
import { dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

export interface RefreshProgress {
  running: boolean;
  current: number;
  total: number;
  success: number;
  failed: number;
  updated_at: number;
}

export async function getRefreshProgress(db: Env["DB"]): Promise<RefreshProgress> {
  const row = await dbFirst<{
    running: number;
    current: number;
    total: number;
    success: number;
    failed: number;
    updated_at: number;
  }>(
    db,
    "SELECT running, current, total, success, failed, updated_at FROM token_refresh_progress WHERE id = 1",
  );
  if (!row) {
    const now = nowMs();
    await dbRun(
      db,
      "INSERT OR REPLACE INTO token_refresh_progress(id,running,current,total,success,failed,updated_at) VALUES(1,0,0,0,0,0,?)",
      [now],
    );
    return { running: false, current: 0, total: 0, success: 0, failed: 0, updated_at: now };
  }
  return {
    running: row.running === 1,
    current: row.current,
    total: row.total,
    success: row.success,
    failed: row.failed,
    updated_at: row.updated_at,
  };
}

export async function setRefreshProgress(db: Env["DB"], p: Partial<RefreshProgress>): Promise<void> {
  const now = nowMs();
  const current = await getRefreshProgress(db);
  const next: RefreshProgress = {
    ...current,
    ...p,
    updated_at: now,
  };
  await dbRun(
    db,
    "UPDATE token_refresh_progress SET running=?, current=?, total=?, success=?, failed=?, updated_at=? WHERE id = 1",
    [next.running ? 1 : 0, next.current, next.total, next.success, next.failed, next.updated_at],
  );
}


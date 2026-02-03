import type { Env } from "../env";
import { dbFirst, dbRun } from "../db";
import { generateSessionToken } from "../utils/crypto";
import { nowMs } from "../utils/time";

const DEFAULT_EXPIRE_HOURS = 8;

export async function createAdminSession(db: Env["DB"], expireHours = DEFAULT_EXPIRE_HOURS): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = nowMs() + expireHours * 60 * 60 * 1000;
  await dbRun(db, "INSERT INTO admin_sessions(token, expires_at) VALUES(?,?)", [token, expiresAt]);
  return token;
}

export async function deleteAdminSession(db: Env["DB"], token: string): Promise<void> {
  await dbRun(db, "DELETE FROM admin_sessions WHERE token = ?", [token]);
}

export async function verifyAdminSession(db: Env["DB"], token: string): Promise<boolean> {
  const now = nowMs();
  await dbRun(db, "DELETE FROM admin_sessions WHERE expires_at <= ?", [now]);
  const row = await dbFirst<{ token: string }>(
    db,
    "SELECT token FROM admin_sessions WHERE token = ? AND expires_at > ?",
    [token, now],
  );
  return Boolean(row);
}


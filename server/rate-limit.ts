import { createHash } from "node:crypto";
import { pool, requireThat } from "./db";
// Only enable behind a proxy that overwrites X-Real-IP. Never trust X-Forwarded-For.
export function clientIdentity(headers: Headers) {
  return process.env.TRUST_PROXY === "true"
    ? (headers.get("x-real-ip") || "direct").slice(0, 128)
    : "direct";
}
export async function rateLimit(
  scope: string,
  identity: string,
  maximum: number,
  seconds = 60,
) {
  const key = createHash("sha256").update(identity).digest("hex");
  const row = (
    await pool.query(
      `INSERT INTO rate_limits(scope,identity_hash,window_start,attempts,expires_at)
    VALUES($1,$2,now(),1,now()+$3*interval '1 second') ON CONFLICT(scope,identity_hash) DO UPDATE SET
    attempts=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.attempts+1 END,
    window_start=CASE WHEN rate_limits.expires_at<=now() THEN now() ELSE rate_limits.window_start END,
    expires_at=CASE WHEN rate_limits.expires_at<=now() THEN now()+$3*interval '1 second' ELSE rate_limits.expires_at END
    RETURNING attempts`,
      [scope, key, seconds],
    )
  ).rows[0];
  requireThat(row.attempts <= maximum, "请求频繁，请稍后再试", 429);
}

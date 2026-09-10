import { randomUUID } from "node:crypto";
import { type DB, transaction, requireThat } from "./db";
export type JobLease = { id: string; lease_token: string };
export async function assertJobLease(db: DB, lease?: JobLease) {
  if (!lease) return;
  const owned = await db.query(
    "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND leased_at>now()-interval '5 minutes' FOR UPDATE",
    [lease.id, lease.lease_token],
  );
  requireThat(owned.rowCount, "任务租约已过期", 409);
}
export async function claimJob() {
  return transaction(async (db) => {
    // Crashes exhaust the same finite retry budget as explicit failures.
    const expired = await db.query(
      "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,lease_token=NULL,available_at=now() WHERE state='running' AND leased_at<now()-interval '5 minutes' RETURNING *",
    );
    for (const job of expired.rows.filter((j) => j.state === "failed")) {
      if (job.kind === "assessment")
        await db.query(
          "UPDATE assessments SET status='failed',error='任务执行超时，可重新生成' WHERE session_id=$1 AND version=$2",
          [job.session_id, job.version],
        );
      if (job.kind === "recording")
        await db.query(
          "UPDATE recording_assets SET status='failed' WHERE session_id=$1",
          [job.session_id],
        );
    }
    const row = (
      await db.query(
        "SELECT * FROM jobs WHERE state='pending' AND available_at<=now() AND attempts<3 AND (kind<>'assessment' OR NOT EXISTS(SELECT 1 FROM jobs preceding WHERE preceding.session_id=jobs.session_id AND preceding.kind='transcription' AND preceding.state IN ('pending','running'))) ORDER BY CASE kind WHEN 'summary' THEN 1 WHEN 'transcription' THEN 2 WHEN 'assessment' THEN 3 ELSE 4 END,available_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!row) return null;
    return (
      await db.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,leased_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
        [row.id, randomUUID()],
      )
    ).rows[0];
  });
}

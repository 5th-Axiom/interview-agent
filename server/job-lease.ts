import { randomUUID } from "node:crypto";
import { type DB, transaction, requireThat, pool } from "./db";
export type JobLease = {
  id: string;
  lease_token: string;
  signal?: AbortSignal;
};
export async function assertJobLease(db: DB, lease?: JobLease) {
  if (!lease) return;
  lease.signal?.throwIfAborted();
  // Every domain writer uses sessions -> jobs -> domain rows, including lease validation.
  await db.query(
    "SELECT id FROM sessions WHERE id=(SELECT session_id FROM jobs WHERE id=$1) FOR UPDATE",
    [lease.id],
  );
  const owned = await db.query(
    "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' AND leased_at>now()-interval '5 minutes' FOR UPDATE",
    [lease.id, lease.lease_token],
  );
  requireThat(owned.rowCount, "任务租约已过期", 409);
}
export async function claimJob(
  kinds = ["summary", "utterance", "transcription", "assessment", "recording"],
) {
  return transaction(async (db) => {
    // Crashes exhaust the same finite retry budget as explicit failures.
    const owners = (
      await db.query(`SELECT s.id FROM sessions s WHERE EXISTS(
      SELECT 1 FROM jobs j WHERE j.session_id=s.id AND j.state='running' AND j.leased_at<=now()-interval '5 minutes')
      FOR UPDATE OF s SKIP LOCKED LIMIT 20`)
    ).rows;
    for (const owner of owners) {
      const expired = await db.query(
        `UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
        lease_token=NULL,available_at=now() WHERE session_id=$1 AND state='running'
        AND leased_at<=now()-interval '5 minutes' RETURNING *`,
        [owner.id],
      );
      for (const job of expired.rows)
        if (job.state === "failed") await failDomain(db, job);
    }
    const row = (
      await db.query(
        "SELECT * FROM jobs WHERE state='pending' AND available_at<=now() AND attempts<3 AND kind=ANY($1::text[]) AND (kind<>'assessment' OR NOT EXISTS(SELECT 1 FROM jobs preceding WHERE preceding.session_id=jobs.session_id AND preceding.kind='transcription' AND preceding.state IN ('pending','running'))) ORDER BY CASE kind WHEN 'utterance' THEN 0 WHEN 'summary' THEN 1 WHEN 'transcription' THEN 2 WHEN 'assessment' THEN 3 ELSE 4 END,available_at FOR UPDATE SKIP LOCKED LIMIT 1",
        [kinds],
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

export async function renewJob(lease: JobLease) {
  return !!(
    await pool.query(
      "UPDATE jobs SET leased_at=now() WHERE id=$1 AND state='running' AND lease_token=$2 AND leased_at>now()-interval '5 minutes' RETURNING id",
      [lease.id, lease.lease_token],
    )
  ).rowCount;
}
async function failDomain(db: DB, job: any) {
  if (job.kind === "assessment")
    await db.query(
      "UPDATE assessments SET status='failed',error='生成失败，可修改要求后重新生成' WHERE session_id=$1 AND version=$2",
      [job.session_id, job.version],
    );
  if (job.kind === "recording")
    await db.query(
      "UPDATE recording_assets SET status='failed' WHERE session_id=$1",
      [job.session_id],
    );
}
export async function failJob(job: JobLease, error: unknown) {
  return transaction(async (db) => {
    await assertJobLease(db, job);
    const row = (
      await db.query(
        "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error=$2,available_at=now()+interval '10 seconds'*attempts WHERE id=$1 AND lease_token=$3 RETURNING *",
        [
          job.id,
          error instanceof Error ? error.name : "unknown",
          job.lease_token,
        ],
      )
    ).rows[0];
    if (row?.state === "failed") await failDomain(db, row);
  });
}
export async function completeJob(job: JobLease) {
  await transaction(async (db) => {
    await assertJobLease(db, job);
    await db.query(
      "UPDATE jobs SET state='done' WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease_token],
    );
  });
}

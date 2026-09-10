import { validateEnvironment } from "./config";
import { pool, transaction } from "./db";
import { claimJob } from "./job-lease";
import { endSession, stopActivity } from "./business";
import {
  summarize,
  assess,
  assembleRecording,
  recoverTranscription,
} from "./jobs";
validateEnvironment();
let stopped = false,
  sweeping = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await transaction(async (db) => {
      const due = (
        await db.query(
          "SELECT id FROM sessions WHERE status<>'ended' AND deadline_at<=now() FOR UPDATE SKIP LOCKED LIMIT 50",
        )
      ).rows;
      for (const s of due) await endSession(db, s.id, "timeout");
      const stale = (
        await db.query(
          "SELECT id FROM sessions WHERE status='active' AND heartbeat_at<now()-interval '15 seconds' FOR UPDATE SKIP LOCKED LIMIT 50",
        )
      ).rows;
      for (const s of stale) {
        await stopActivity(db, s.id, "heartbeat_timeout");
        await db.query(
          "UPDATE sessions SET status='recovery',version=version+1 WHERE id=$1",
          [s.id],
        );
      }
    });
  } catch {
    console.error("deadline_sweep_failed");
  } finally {
    sweeping = false;
  }
}
// Deadline supervision is independent from slow model or recording jobs.
const timer = setInterval(() => void sweep(), 1000);
await sweep();
console.log("Worker started");
while (!stopped) {
  try {
    const job = await claimJob();
    if (job) {
      const lease = setInterval(
        () =>
          void pool
            .query(
              "UPDATE jobs SET leased_at=now() WHERE id=$1 AND state='running' AND lease_token=$2",
              [job.id, job.lease_token],
            )
            .catch(() => {}),
        30000,
      );
      try {
        if (job.kind === "summary") await summarize(job.session_id, job);
        else if (job.kind === "transcription")
          await recoverTranscription(job.session_id, job);
        else if (job.kind === "assessment")
          await assess(job.session_id, job.version, job);
        else await assembleRecording(job.session_id, job);
        await pool.query(
          "UPDATE jobs SET state='done' WHERE id=$1 AND lease_token=$2",
          [job.id, job.lease_token],
        );
      } catch (e) {
        const failed = await pool.query(
          "UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error=$2,available_at=now()+interval '10 seconds'*attempts WHERE id=$1 AND lease_token=$3 RETURNING state",
          [job.id, e instanceof Error ? e.name : "unknown", job.lease_token],
        );
        if (failed.rows[0]?.state === "failed" && job.kind === "assessment")
          await pool.query(
            "UPDATE assessments SET status='failed',error='生成失败，可修改要求后重新生成' WHERE session_id=$1 AND version=$2",
            [job.session_id, job.version],
          );
        if (failed.rows[0]?.state === "failed" && job.kind === "recording")
          await pool.query(
            "UPDATE recording_assets SET status='failed' WHERE session_id=$1",
            [job.session_id],
          );
        console.error("job_failed", job.kind);
      } finally {
        clearInterval(lease);
      }
    }
  } catch (e) {
    console.error(
      "worker_cycle_failed",
      e instanceof Error ? e.name : "unknown",
    );
  }
  await new Promise((r) => setTimeout(r, 1000));
}
clearInterval(timer);
while (sweeping) await new Promise((r) => setTimeout(r, 20));
await pool.end();

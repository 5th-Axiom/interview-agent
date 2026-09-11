import { archiveAudio } from "./audio-store";
import { validateEnvironment } from "./config";
import { pool, transaction } from "./db";
import { claimJob, renewJob, failJob, completeJob } from "./job-lease";
import { endSession, stopActivity } from "./business";
import {
  summarize,
  summarizeUtterance,
  assess,
  assembleRecording,
  recoverTranscription,
} from "./jobs";
validateEnvironment();
let archiving = false;
const archiveTimer = setInterval(() => {
  if (archiving) return;
  archiving = true;
  void archiveAudio()
    .catch(() => console.error("audio_archive_failed"))
    .finally(() => {
      archiving = false;
    });
}, 250);
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
      await db.query(
        "DELETE FROM rate_limits WHERE expires_at<now()-interval '1 hour'",
      );
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
async function run(kinds: string[]) {
  while (!stopped) {
    try {
      const job = await claimJob(kinds);
      if (job) {
        const abort = new AbortController();
        job.signal = abort.signal;
        const lease = setInterval(
          () =>
            void renewJob(job)
              .then((ok) => {
                if (!ok) abort.abort();
              })
              .catch(() => abort.abort()),
          30000,
        );
        try {
          if (job.kind === "summary") await summarize(job.session_id, job);
          else if (job.kind === "utterance")
            await summarizeUtterance(job.session_id, job.version, job);
          else if (job.kind === "transcription")
            await recoverTranscription(job.session_id, job);
          else if (job.kind === "assessment")
            await assess(job.session_id, job.version, job);
          else await assembleRecording(job.session_id, job);
          await completeJob(job);
        } catch (e) {
          await failJob(job, e).catch(() =>
            console.error("job_failure_commit_failed", job.kind),
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
}
await Promise.all([
  run(["summary", "utterance"]),
  run(["assessment"]),
  run(["transcription", "recording"]),
]);
clearInterval(timer);
clearInterval(archiveTimer);
while (sweeping || archiving) await new Promise((r) => setTimeout(r, 20));
await pool.end();

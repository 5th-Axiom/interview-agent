import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "../server/db";
import { feedbackSchema } from "../shared/contracts";
import { assertJobLease } from "../server/job-lease";
import { enqueue, append } from "../server/business";
import { contextEvents } from "../server/context";
import { saveAudioTail } from "../server/audio-tail";
const sid = randomUUID(),
  uid = randomUUID(),
  org = `lease-${randomUUID()}`;
const ready = (async () => {
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
  await pool.query("INSERT INTO users VALUES($1::uuid,$1::text,'测试')", [uid]);
  await pool.query(
    "INSERT INTO sessions(id,user_id,entry_id,status,started_at,deadline_at,ended_at,epoch) VALUES($1,$2,$3,'ended',now()-interval '5 seconds',now()+interval '55 minutes',now(),4)",
    [sid, uid, org],
  );
})();
after(() => pool.end());
test("feedback enforces 500 Unicode characters, known tags, and a meaningful submission", () => {
  assert(feedbackSchema.safeParse({ text: "文".repeat(500) }).success);
  assert(feedbackSchema.safeParse({ text: "😀".repeat(500) }).success);
  assert(!feedbackSchema.safeParse({ text: "文".repeat(501) }).success);
  assert(!feedbackSchema.safeParse({ text: "  " }).success);
  assert(!feedbackSchema.safeParse({ tags: ["伪造标签"] }).success);
  assert(feedbackSchema.safeParse({ skipped: true }).success);
});
test("completed no-op summary can be queued again, and expired worker cannot write under a new lease", async () => {
  await ready;
  await transaction((db) => enqueue(db, "summary", sid, 1));
  const job = (
    await pool.query(
      "UPDATE jobs SET state='done' WHERE session_id=$1 RETURNING *",
      [sid],
    )
  ).rows[0];
  await transaction((db) => enqueue(db, "summary", sid, 1));
  assert.equal(
    (await pool.query("SELECT state FROM jobs WHERE id=$1", [job.id])).rows[0]
      .state,
    "pending",
  );
  const old = randomUUID(),
    current = randomUUID();
  await pool.query(
    "UPDATE jobs SET state='running',lease_token=$2,leased_at=now() WHERE id=$1",
    [job.id, old],
  );
  await transaction((db) =>
    assertJobLease(db, { id: job.id, lease_token: old }),
  );
  await pool.query("UPDATE jobs SET lease_token=$2 WHERE id=$1", [
    job.id,
    current,
  ]);
  await assert.rejects(
    transaction(async (db) => {
      await assertJobLease(db, { id: job.id, lease_token: old });
      await append(db, sid, { kind: "should-not-write" });
    }),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM events WHERE session_id=$1 AND kind='should-not-write'",
        [sid],
      )
    ).rowCount,
    0,
  );
});
test("playback evidence is tied to a sentence, not every sentence in one response", () => {
  const a = randomUUID(),
    b = randomUUID(),
    chunk = randomUUID();
  const events = contextEvents([
    { event_id: a, kind: "generated", text: "一句", metadata: {} },
    { event_id: b, kind: "generated", text: "另一句", metadata: {} },
    {
      kind: "playback",
      metadata: {
        event_id: a,
        chunk_id: chunk,
        played_ms: 100,
        duration_ms: 500,
      },
    },
    {
      kind: "playback",
      metadata: {
        event_id: a,
        chunk_id: chunk,
        played_ms: 300,
        duration_ms: 500,
      },
    },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].metadata.playback.confirmed_ms, 300);
  assert.match(events[1].metadata.playback.note, /没有播放确认/);
});
test("audio tail accepts only the owner, previous epoch and ended capture window", async () => {
  await ready;
  const body = { epoch: 3, audio: [], played: [] };
  assert.deepEqual(
    await saveAudioTail({ user_id: uid, org_id: null }, sid, body),
    { audio: [], played: [] },
  );
  await assert.rejects(
    saveAudioTail({ user_id: randomUUID(), org_id: null }, sid, body),
  );
  await assert.rejects(
    saveAudioTail({ user_id: uid, org_id: null }, sid, { ...body, epoch: 2 }),
  );
  await assert.rejects(
    saveAudioTail({ user_id: uid, org_id: null }, sid, {
      ...body,
      audio: [
        {
          type: "audio",
          epoch: 3,
          chunk_no: randomUUID(),
          pcm: Buffer.alloc(6400).toString("base64"),
          start_ms: 100000,
          duration_ms: 200,
        },
      ],
    }),
  );
});

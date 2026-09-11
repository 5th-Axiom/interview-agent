import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "../server/db";
import {
  append,
  enqueue,
  snapshot,
  bootstrap,
  control,
} from "../server/business";
import { assertJobLease, renewJob, failJob } from "../server/job-lease";
import { saveAudioTail } from "../server/audio-tail";
import {
  savePlayback,
  playbackReceipt,
  stageAssistant,
} from "../server/audio-store";
import { uncoveredAudio } from "../server/jobs";
import { rateLimit, clientIdentity } from "../server/rate-limit";
import { TurnCoordinator } from "../server/turn-coordinator";
import { conversationView } from "../server/conversation-view";
import { estimateTokens, contextPressure } from "../server/context-budget";
import { AsyncQueue } from "../shared/async-queue";
import { TaskLane } from "../shared/task-lane";
import { responseData, RequestError } from "../shared/http";
import { mutate } from "../features/interview/api";
import { spokenText } from "../server/spoken-output";
const uid = randomUUID(),
  sid = randomUUID(),
  org = "remediation-" + randomUUID();
const ready = (async () => {
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
  await pool.query("INSERT INTO users VALUES($1::uuid,$1::text,'fixture')", [
    uid,
  ]);
  await pool.query(
    `INSERT INTO sessions(id,user_id,entry_id,status,started_at,deadline_at,assessment_prompt,test_mode,runtime_config)
    VALUES($1,$2,$3,'active',now(),now()+interval '1 hour','PRIVATE ASSESSMENT INSTRUCTION',true,'{"protocol":2}')`,
    [sid, uid, org],
  );
})();
after(() => pool.end());
const actor = { user_id: uid, org_id: null };
test("assistant audio is durable before delivery; playback event failure rolls back progress, retry commits once", async () => {
  await ready;
  const eid = randomUUID(),
    rid = randomUUID();
  await transaction((db) =>
    append(db, sid, {
      event_id: eid,
      kind: "generated",
      speaker: "assistant",
      text: "一个问题",
      response_id: rid,
    }),
  );
  const ch = await stageAssistant(
    sid,
    0,
    rid,
    eid,
    Buffer.alloc(7680),
    () => true,
  );
  assert(ch);
  assert.equal(
    (
      await pool.query(
        "SELECT octet_length(pcm) AS n FROM audio_outbox WHERE chunk_id=$1",
        [ch.id],
      )
    ).rows[0].n,
    7680,
  );
  const packet = {
    chunk_id: ch.id,
    response_id: rid,
    epoch: 0,
    played_ms: 160,
    receipt: playbackReceipt(ch),
  };
  const session = (
    await pool.query("SELECT * FROM sessions WHERE id=$1", [sid])
  ).rows[0];
  await pool.query(
    `CREATE FUNCTION reject_playback_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id='${sid}' AND NEW.kind='playback' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER reject_playback_fixture BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_playback_fixture()",
  );
  try {
    await assert.rejects(
      transaction((db) => savePlayback(db, session, packet)),
    );
    assert.equal(
      (await pool.query("SELECT played_ms FROM chunks WHERE id=$1", [ch.id]))
        .rows[0].played_ms,
      0,
    );
  } finally {
    await pool.query("DROP TRIGGER reject_playback_fixture ON events");
    await pool.query("DROP FUNCTION reject_playback_fixture()");
  }
  await transaction((db) => savePlayback(db, session, packet));
  await transaction((db) => savePlayback(db, session, packet));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND kind='playback'",
        [sid],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await transaction((db) =>
        savePlayback(db, session, { ...packet, played_ms: 10 }),
      )
    ).played_ms,
    160,
  );
  await assert.rejects(
    transaction((db) =>
      savePlayback(db, session, { ...packet, receipt: "f".repeat(64) }),
    ),
  );
  assert.equal(
    await stageAssistant(sid, 99, rid, eid, Buffer.alloc(7680), () => true),
    null,
  );
  const tail = await stageAssistant(
    sid,
    0,
    rid,
    eid,
    Buffer.alloc(14400),
    () => true,
  );
  assert(tail);
  await pool.query(
    "INSERT INTO voice_connections(session_id,epoch,retired_at) VALUES($1,0,now()),($1,1,NULL)",
    [sid],
  );
  await pool.query("UPDATE sessions SET epoch=1 WHERE id=$1", [sid]);
  await saveAudioTail(
    actor,
    sid,
    {
      epoch: 1,
      played: [
        {
          type: "played",
          epoch: 0,
          source_epoch: 0,
          chunk_id: tail.id,
          response_id: rid,
          played_ms: 150,
          receipt: playbackReceipt(tail),
        },
      ],
    },
    true,
  );
  assert.equal(
    (await pool.query("SELECT played_ms FROM chunks WHERE id=$1", [tail.id]))
      .rows[0].played_ms,
    150,
  );
});
test("session then job lock order allows enqueue while a stale job waits; expired lease cannot renew", async () => {
  await ready;
  await transaction((db) => enqueue(db, "summary", sid, 99));
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,leased_at=now() WHERE session_id=$1 AND version=99 RETURNING *",
      [sid, randomUUID()],
    )
  ).rows[0];
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='600ms'");
  await client.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [sid]);
  const checking = transaction((db) => assertJobLease(db, job));
  try {
    await new Promise((r) => setTimeout(r, 40));
    await enqueue(client, "summary", sid, 99);
    await client.query("COMMIT");
    await checking;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  await pool.query(
    "UPDATE jobs SET leased_at=now()-interval '6 minutes' WHERE id=$1",
    [job.id],
  );
  assert.equal(await renewJob(job), false);
  await assert.rejects(transaction((db) => assertJobLease(db, job)));
});
test("worker failure cannot commit job failed while leaving assessment running", async () => {
  await ready;
  await pool.query(
    "INSERT INTO assessments(session_id,version,prompt,event_cutoff,status) VALUES($1,88,'fixture',0,'running')",
    [sid],
  );
  await transaction((db) => enqueue(db, "assessment", sid, 88));
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=3,lease_token=$2,leased_at=now() WHERE session_id=$1 AND version=88 RETURNING *",
      [sid, randomUUID()],
    )
  ).rows[0];
  await pool.query(
    `CREATE FUNCTION reject_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id='${sid}' AND NEW.version=88 AND NEW.status='failed' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    "CREATE TRIGGER reject_failure_fixture BEFORE UPDATE ON assessments FOR EACH ROW EXECUTE FUNCTION reject_failure_fixture()",
  );
  try {
    await assert.rejects(failJob(job, new Error("fixture")));
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE id=$1", [job.id])).rows[0]
        .state,
      "running",
    );
  } finally {
    await pool.query("DROP TRIGGER reject_failure_fixture ON assessments");
    await pool.query("DROP FUNCTION reject_failure_fixture()");
  }
  await failJob(job, new Error("fixture"));
  assert.equal(
    (
      await pool.query(
        "SELECT status FROM assessments WHERE session_id=$1 AND version=88",
        [sid],
      )
    ).rows[0].status,
    "failed",
  );
});
test("coverage tracks holes independently; later transcription does not hide an earlier missing chunk", async () => {
  await ready;
  const chunks = [randomUUID(), randomUUID(), randomUUID()],
    eid = randomUUID();
  await transaction((db) =>
    append(db, sid, {
      event_id: eid,
      kind: "utterance",
      speaker: "user",
      text: "later answer",
      metadata: { audio_through_ms: 10000 },
    }),
  );
  for (let i = 0; i < chunks.length; i++)
    await pool.query(
      "INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,epoch) VALUES($1::uuid,$2,'user',$1::text,$1,'fixture',$3,200,16000,0)",
      [chunks[i], sid, i * 200],
    );
  for (const chunk of [chunks[0], chunks[2]])
    await pool.query("INSERT INTO audio_coverage VALUES($1,$2,$3)", [
      sid,
      chunk,
      eid,
    ]);
  assert.deepEqual(
    (await uncoveredAudio(sid)).map((c) => c.id),
    [chunks[1]],
  );
});
test("candidate DTO excludes assessment instructions and stale HTTP controls are rejected", async () => {
  await ready;
  assert(
    !JSON.stringify((await snapshot(actor, sid)).session).includes(
      "PRIVATE ASSESSMENT",
    ),
  );
  assert(
    !JSON.stringify((await bootstrap(actor, org)).session).includes(
      "PRIVATE ASSESSMENT",
    ),
  );
  await assert.rejects(transaction((db) => control(db, actor, sid, "pause")));
  await assert.rejects(
    transaction((db) => control(db, actor, sid, "pause", 0, undefined, 99)),
  );
});
test("rate limit survives many other identities, and untrusted forwarding headers do not bypass it", async () => {
  const scope = randomUUID();
  for (let i = 0; i < 2; i++) await rateLimit(scope, "limited", 2);
  await pool.query(
    "INSERT INTO rate_limits SELECT $1,'fixture-'||n,now(),1,now()+interval '60 seconds' FROM generate_series(1,2001) n",
    [scope],
  );
  await assert.rejects(rateLimit(scope, "limited", 2));
  await rateLimit(scope, "legitimate", 2);
  const prior = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(
      clientIdentity(
        new Headers({ "x-forwarded-for": "spoof", "x-real-ip": "spoof" }),
      ),
      "direct",
    );
  } finally {
    if (prior === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prior;
  }
});
test("one input revision creates one reply; completion and noise never create or cancel extra questions", () => {
  const c = new TurnCoordinator(),
    opening = c.begin("opening")!;
  assert(opening);
  c.transition(opening, "completed");
  assert.equal(c.cancel("noise"), null);
  assert.equal(c.begin("opening"), null);
  const input = { id: randomUUID(), eventId: randomUUID(), revision: 0 };
  const reply = c.begin("user_turn", input)!;
  assert.equal(c.begin("user_turn", input), null);
  const correction = c.begin("user_turn", { ...input, revision: 1 })!;
  assert(!c.isCurrent(reply));
  assert(reply.controller.signal.aborted);
  assert(c.isCurrent(correction));
});
test("partial speech is not a heard assistant turn; corrected input keeps logical order", () => {
  const events = [
    {
      event_id: "a",
      seq: 1,
      kind: "utterance",
      text: "old",
      metadata: { input_turn_id: "a" },
    },
    {
      event_id: "q",
      seq: 2,
      kind: "generated",
      text: "question",
      metadata: { tts_complete: true },
    },
    {
      event_id: "b",
      seq: 3,
      kind: "utterance",
      text: "new answer",
      metadata: { input_turn_id: "b" },
    },
    {
      event_id: "r",
      seq: 4,
      kind: "utterance",
      text: "correction",
      metadata: { input_turn_id: "a", revision_of: "a" },
    },
  ];
  const view = conversationView(events, [
    { event_id: "q", duration_ms: 1000, played_ms: 400 },
  ]);
  assert.equal(view.lastQuestion.playback, "partial");
  assert.deepEqual(
    view.turns.map((t) => t.content),
    ["correction", "new answer"],
  );
  assert.equal(view.latestInput.content, "new answer");
});
test("storage backlog cannot delay controls, and abort releases bounded producer", async () => {
  const storage = new TaskLane(8),
    controls = new TaskLane(4);
  let release!: () => void;
  const held = storage.run(8, () => new Promise<void>((r) => (release = r)));
  await Promise.resolve();
  await assert.rejects(storage.run(1, async () => {}));
  assert.equal(await controls.run(1, async () => 42), 42);
  release();
  await held;
  const q = new AsyncQueue<string>(4, (t) => t.length),
    abort = new AbortController();
  await q.push("full");
  const blocked = q.push("next", abort.signal);
  abort.abort();
  await assert.rejects(blocked);
  q.close();
});
test("HTML error retains HTTP status; manual retry after unknown outcome reuses original command UUID", async () => {
  await assert.rejects(
    responseData(new Response("<html>limited</html>", { status: 429 })),
    (e) => e instanceof RequestError && e.status === 429,
  );
  const previous = globalThis.fetch,
    ids: string[] = [];
  let count = 0;
  globalThis.fetch = async (_url, init) => {
    ids.push(JSON.parse(init!.body as string).request_id);
    if (++count <= 2) throw new TypeError("disconnected");
    return Response.json({ ok: true });
  };
  try {
    await assert.rejects(
      mutate("fixture/manual-review", { text: "same input" }),
    );
    await mutate("fixture/manual-review", { text: "same input" });
    assert.equal(new Set(ids).size, 1);
    await mutate("fixture/manual-review", { text: "same input" });
    assert.notEqual(ids.at(-1), ids[0]);
  } finally {
    globalThis.fetch = previous;
  }
});
test("budget includes CJK, tools and output reserve; spoken contract rejects internal planning", () => {
  assert(estimateTokens("中文".repeat(100)) > estimateTokens("ab".repeat(100)));
  const p = {
    model: "test",
    base: "",
    contextWindow: 1000,
    maxInput: 900,
    outputReserve: 200,
    safetyMargin: 100,
  };
  assert.equal(contextPressure(700, p), "blocked");
  assert.equal(contextPressure(500, p), "summarize");
  assert.throws(() => spokenText("我需要调用 request_end_confirmation 工具。"));
  assert.equal(
    spokenText("你当时是怎么定位问题的？"),
    "你当时是怎么定位问题的？",
  );
});

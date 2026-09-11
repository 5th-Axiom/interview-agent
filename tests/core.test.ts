import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "../server/db";
import {
  start,
  control,
  endSession,
  command,
  append,
  access,
  expire,
} from "../server/business";
import {
  GenerationGate,
  DurableQueue,
  TranscriptAccumulator,
  validateSources,
} from "../shared/voice-state";
import { summarize, assess } from "../server/jobs";
import { signTicket, verifyTicket, login, sendCode } from "../server/auth";
import { validateEnvironment } from "../server/config";
const org = `test-${randomUUID()}`;
let uid: string, role: string, version: string;
async function fixture() {
  uid = randomUUID();
  role = randomUUID();
  version = randomUUID();
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
  await pool.query("INSERT INTO users VALUES($1,$2,$3)", [
    uid,
    uid,
    "138****0000",
  ]);
  await pool.query(
    "INSERT INTO roles(id,org_id,name,prompt) VALUES($1,$2,$3,$4)",
    [role, org, "前端工程师", "自然面试"],
  );
  await pool.query(
    "INSERT INTO role_versions(id,role_id,name,description,prompt) VALUES($1,$2,$3,$4,$5)",
    [version, role, "前端工程师", "", "自然面试"],
  );
  await pool.query(
    "UPDATE roles SET status='published',published_version=$2 WHERE id=$1",
    [role, version],
  );
}
const ready = fixture();
after(() => pool.end());
test("generation cancellation rejects all stale callbacks", () => {
  const gate = new GenerationGate();
  const a = gate.begin();
  assert(a.current());
  const b = gate.begin();
  assert(a.signal.aborted);
  assert(!a.current());
  assert(b.current());
  gate.cancel();
  assert(!b.current());
});
test("fixed save batches retain new events and only remove acknowledged ids", () => {
  const q = new DurableQueue<{ event_id: string; text: string }>(3);
  q.add({ event_id: "a", text: "中文 mixed English" });
  const batch = q.batch();
  q.add({ event_id: "b", text: "补充" });
  assert.equal(batch.length, 1);
  assert.equal(q.batch().length, 2);
  q.acknowledge(["a"]);
  assert.equal(q.batch()[0].text, "补充");
  q.acknowledge(["missing"]);
  assert.equal(q.size, 1);
  q.add({ event_id: "c", text: "第三条" });
  q.add({ event_id: "d", text: "第四条" });
  assert.throws(() => q.add({ event_id: "e", text: "溢出" }));
});
test("ASR revision, duplicate packets and rotation preserve distinct repeated speech", () => {
  const a = new TranscriptAccumulator();
  assert(a.update("connection1", "1", 1, "React 项目"));
  assert(!a.update("connection1", "1", 1, "重复包"));
  assert(a.update("connection1", "1", 2, "React 与 TypeScript 项目"));
  a.update("connection2", "1", 1, "React 与 TypeScript 项目");
  assert.equal(a.text(), "React 与 TypeScript 项目 React 与 TypeScript 项目");
});
test("forged and expired relay tickets are rejected", async () => {
  const token = await signTicket({
    purpose: "relay",
    session_id: randomUUID(),
  });
  assert.equal((await verifyTicket(token)).purpose, "relay");
  await assert.rejects(verifyTicket(token + "x"));
  await assert.rejects(
    verifyTicket(await signTicket({ purpose: "relay" }, -1)),
  );
});
test("production refuses fixed OTP and development mode", () => {
  const before = {
    NODE_ENV: process.env.NODE_ENV,
    APP_ENV: process.env.APP_ENV,
  };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      APP_ENV: "production",
    });
    assert.throws(validateEnvironment, /Unsafe/);
  } finally {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
test("session lifecycle, isolation, atomic retry redemption and idempotency", async () => {
  await ready;
  const actor = { user_id: uid, org_id: null };
  const starts = await Promise.all(
    Array.from({ length: 6 }, () =>
      transaction((db) => start(db, actor, org, role)),
    ),
  );
  const first = starts[0];
  assert(starts.every((s) => s.id === first.id));
  assert.equal(
    new Date(first.deadline_at).getTime() -
      new Date(first.started_at).getTime(),
    3600000,
  );
  await assert.rejects(
    transaction((db) =>
      access(db, { user_id: randomUUID(), org_id: null }, first.id),
    ),
    /无权/,
  );
  await assert.rejects(
    transaction((db) => control(db, actor, first.id, "pause", -1)),
    /状态已变化/,
  );
  const eid = randomUUID();
  await transaction(async (db) => {
    await append(db, first.id, {
      event_id: eid,
      kind: "utterance",
      speaker: "user",
      text: "负责 React 项目",
    });
    await append(db, first.id, {
      event_id: eid,
      kind: "utterance",
      speaker: "user",
      text: "负责 React 项目",
    });
  });
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM events WHERE session_id=$1 AND event_id=$2",
        [first.id, eid],
      )
    ).rowCount,
    1,
  );
  const switched = await transaction((db) =>
    control(db, actor, first.id, "role", first.version, role),
  );
  assert.equal(
    new Date(switched.deadline_at).getTime(),
    new Date(first.deadline_at).getTime(),
  );
  assert.equal(
    (
      await pool.query("SELECT * FROM role_segments WHERE session_id=$1", [
        first.id,
      ])
    ).rowCount,
    2,
  );
  await transaction((db) => endSession(db, first.id, "manual"));
  await transaction((db) => endSession(db, first.id, "timeout"));
  const assessmentDelay = (
    await pool.query(
      "SELECT EXTRACT(EPOCH FROM(j.available_at-s.ended_at)) AS seconds FROM jobs j JOIN sessions s ON s.id=j.session_id WHERE s.id=$1 AND j.kind='assessment'",
      [first.id],
    )
  ).rows[0];
  assert(
    Number(assessmentDelay.seconds) >= 30,
    "assessment must wait for the audio tail window",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM jobs WHERE session_id=$1 AND kind='assessment'",
        [first.id],
      )
    ).rowCount,
    1,
  );
  await assert.rejects(
    transaction((db) => start(db, actor, org, role)),
    /再次面试/,
  );
  const grant = randomUUID();
  await pool.query(
    "INSERT INTO retry_requests(id,session_id,reason,status) VALUES($1,$2,'设备中断','approved')",
    [grant, first.id],
  );
  const next = await Promise.all(
    Array.from({ length: 8 }, () =>
      transaction((db) => start(db, actor, org, role)),
    ),
  );
  assert(next.every((s) => s.id === next[0].id));
  assert.notEqual(next[0].id, first.id);
  assert.equal(
    (
      await pool.query("SELECT used_by FROM retry_requests WHERE id=$1", [
        grant,
      ])
    ).rows[0].used_by,
    next[0].id,
  );
  const request = randomUUID();
  let n = 0;
  const action = () =>
    command(actor, request, { action: "check" }, async () => ({ n: ++n }));
  assert.deepEqual(await Promise.all([action(), action()]), [
    { n: 1 },
    { n: 1 },
  ]);
  await assert.rejects(
    command(actor, request, { action: "different" }, async () => ({})),
    /不同操作/,
  );
  await pool.query(
    "UPDATE sessions SET deadline_at=now()-interval '1 second',status='paused' WHERE id=$1",
    [next[0].id],
  );
  const expired = await transaction(async (db) =>
    expire(db, await access(db, actor, next[0].id, true)),
  );
  assert.equal(expired.status, "ended");
  assert.equal(expired.end_reason, "timeout");
});
test("three rolling compactions keep referenced facts and all original events", async () => {
  await ready;
  const user = randomUUID();
  await pool.query("INSERT INTO users VALUES($1::uuid,$1::text,$2)", [
    user,
    "测试",
  ]);
  const session = await transaction((db) =>
    start(db, { user_id: user, org_id: null }, org, role),
  );
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 9; i++)
      await transaction((db) =>
        append(db, session.id, {
          kind: "utterance",
          speaker: "user",
          text: `事实 ${round}-${i}：项目是 React，不是 Vue，吞吐量为 ${100 + i}`,
        }),
      );
    await summarize(session.id);
  }
  const snapshots = (
    await pool.query(
      "SELECT * FROM snapshots WHERE session_id=$1 ORDER BY version",
      [session.id],
    )
  ).rows;
  assert.equal(snapshots.length, 3);
  assert(snapshots[2].covered_seq > snapshots[1].covered_seq);
  const events = (
    await pool.query("SELECT * FROM events WHERE session_id=$1", [session.id])
  ).rows;
  assert.equal(events.filter((e) => e.kind === "utterance").length, 27);
  assert(
    validateSources(
      snapshots[2].content.items,
      new Set(events.map((e) => e.event_id)),
    ),
  );
  assert(
    snapshots[2].content.items.some((i: any) => i.text.includes("事实 0-0")),
  );
  assert(
    !validateSources(
      [{ sources: ["forged"] }],
      new Set(events.map((e) => e.event_id)),
    ),
  );
});
test("assessment uses original evidence and does not overwrite human reviews", async () => {
  await ready;
  const user = randomUUID();
  await pool.query("INSERT INTO users VALUES($1::uuid,$1::text,$2)", [
    user,
    "测试",
  ]);
  const s = await transaction((db) =>
    start(db, { user_id: user, org_id: null }, org, role),
  );
  await transaction((db) =>
    append(db, s.id, {
      kind: "utterance",
      speaker: "user",
      text: "我负责后端服务的可靠性。",
    }),
  );
  await transaction((db) => endSession(db, s.id, "manual"));
  await pool.query("INSERT INTO human_reviews VALUES($1,$2,$3,$4)", [
    randomUUID(),
    s.id,
    org,
    "请安排人工技术面",
  ]);
  await assess(s.id, 1);
  const a = (
    await pool.query("SELECT * FROM assessments WHERE session_id=$1", [s.id])
  ).rows[0];
  assert.equal(a.status, "ready");
  assert(a.result.items[0].sources.length);
  assert.equal(
    (
      await pool.query("SELECT text FROM human_reviews WHERE session_id=$1", [
        s.id,
      ])
    ).rows[0].text,
    "请安排人工技术面",
  );
});

test("OTP resend cooldown, attempt limit, and successful one-time consumption", async () => {
  const phone = `otp-${randomUUID()}`;
  await sendCode(phone);
  await assert.rejects(sendCode(phone), /60/);
  for (let i = 0; i < 5; i++)
    await assert.rejects(login(phone, "000000"), /验证码/);
  await assert.rejects(login(phone, "123456"), /验证码/);
  const second = `otp-${randomUUID()}`;
  await sendCode(second);
  const token = await login(second, "123456");
  assert(token.length >= 32);
  await assert.rejects(login(second, "123456"), /验证码/);
});

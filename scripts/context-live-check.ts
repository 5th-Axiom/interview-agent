import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pool, transaction } from "../server/db";
import { append, selectRole } from "../server/business";
import { summarize } from "../server/jobs";
import { buildContext } from "../server/context";
import { streamModel } from "../server/model";
import { testMode } from "../server/config";
if (testMode)
  throw new Error("Real-provider check requires DEV_TEST_MODE=false");
const org = `context-live-${randomUUID()}`,
  uid = randomUUID(),
  role = randomUUID(),
  version = randomUUID(),
  sid = randomUUID();
try {
  await transaction(async (db) => {
    await db.query("INSERT INTO organizations VALUES($1,$1)", [org]);
    await db.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
    await db.query("INSERT INTO users VALUES($1,$2,'合成上下文验证')", [
      uid,
      uid,
    ]);
    await db.query(
      "INSERT INTO roles(id,org_id,name,prompt) VALUES($1,$2,'合成上下文验证','中文面试，每次一个问题。')",
      [role, org],
    );
    await db.query(
      "INSERT INTO role_versions(id,role_id,name,description,prompt) VALUES($1,$2,'合成上下文验证','','中文面试，每次一个问题。')",
      [version, role],
    );
    await db.query(
      "INSERT INTO sessions(id,user_id,entry_id,mode,status,started_at,deadline_at,test_mode) VALUES($1,$2,$3,'preview','recovery',now(),now()+interval '1 hour',false)",
      [sid, uid, org],
    );
    await selectRole(db, sid, version);
  });
  const facts = [
    [
      "我负责前端页面首屏优化，基线是1800ms，初步结果是900ms。",
      "我使用 React 和 TypeScript，职责是测量与方案落地。",
    ],
    [
      "更正之前的优化结果：最终首屏是850ms，900ms只是中间结果。",
      "请保留这条纠正，最终数字是850ms。",
    ],
    [
      "还没讨论缓存失效策略，希望接着谈这个话题。",
      "不要把我的团队成果都算成个人贡献，需要再核实分工。",
    ],
  ];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++)
      await transaction((db) =>
        append(db, sid, {
          kind: "utterance",
          speaker: "user",
          text: facts[round][i % 2],
        }),
      );
    await summarize(sid);
  }
  const session = (
    await pool.query("SELECT snapshot_version FROM sessions WHERE id=$1", [sid])
  ).rows[0];
  assert.equal(session.snapshot_version, 3);
  const context = await buildContext(sid);
  const all = context.map((m) => m.content).join("\n");
  assert.match(all, /850/);
  assert.match(all, /1800/);
  assert.match(all, /缓存/);
  const total = (
    await pool.query(
      "SELECT count(*)::int AS n FROM events WHERE session_id=$1",
      [sid],
    )
  ).rows[0].n;
  assert.equal(total, 31);
  let selected = false;
  for await (const part of streamModel(
    [
      {
        role: "system",
        content: `仅帮助选岗。岗位清单：[{"id":"${role}","name":"前端工程师"}]。意图明确时调用select_role。`,
      },
      { role: "user", content: "我确定选择前端工程师。" },
    ],
    AbortSignal.timeout(20000),
    false,
    { selection: true },
  ))
    if (
      part.type === "tool" &&
      part.name === "select_role" &&
      part.arguments.role_id === role
    )
      selected = true;
  assert(selected, "real LLM select_role function call");
  let uncertain = false;
  for await (const part of streamModel(
    [
      {
        role: "system",
        content: `解析岗位选择。可选列表 [{"id":"${role}","name":"前端工程师"}]。只有明确选择时返回 id，不确定就返回 role_id:null 和澄清问题 message，不能猜测。`,
      },
      { role: "user", content: "我还没有决定，先给我介绍一下岗位。" },
    ],
    AbortSignal.timeout(20000),
    false,
    { selection: true },
  ))
    if (
      part.type === "tool" &&
      part.name === "select_role" &&
      part.arguments.role_id === null
    )
      uncertain = true;
  assert(uncertain, "ambiguous intent must not choose a role");
  const report = {
    result: "PASS",
    session: sid,
    summaryVersions: 3,
    originalEvents: total,
    checks: [
      "original facts",
      "correction to 850ms",
      "pending topic",
      "source validation",
      "real function tool",
    ],
  };
  await writeFile(
    ".local/context-live-check.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Context provider check failed",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

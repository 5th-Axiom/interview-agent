import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/[...path]/route";
import { pool } from "../server/db";
import { hash } from "../server/auth";
import { append } from "../server/business";
import { buildContext } from "../server/context";
import {
  findPromptTemplate,
  promptTemplates,
  templateRoleDraft,
} from "../features/admin/prompt-templates";

const org = `preview-test-${randomUUID()}`;
const token = randomUUID();
const ready = (async () => {
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,NULL,$2,now()+interval '1 hour')",
    [hash(token), org],
  );
})();
after(() => pool.end());

async function request(
  path: string,
  body?: Record<string, unknown>,
  expected = 200,
) {
  await ready;
  const req = new NextRequest(`${process.env.APP_URL}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: `interview_admin=${token}`,
      "X-Interview-Client": "admin",
    },
    body: body
      ? JSON.stringify({ request_id: randomUUID(), ...body })
      : undefined,
  });
  const response = await (body ? POST(req) : GET(req));
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${path}: ${data.error ?? response.status}`,
  );
  return data;
}

test("preview freezes current unsaved prompt, retries once, and never changes saved or published content", async () => {
  const saved = {
    name: "试聊配置回归",
    description: "",
    prompt: "已发布：询问缓存设计",
  };
  const role = await request("roles/new/publish", saved);
  const before = (await request("roles")).find((r: any) => r.id === role.id);
  const draft = {
    ...saved,
    prompt: "未保存：只询问数据库索引设计",
    role_id: role.id,
    request_id: randomUUID(),
  };
  const first = await request("preview", draft);
  const repeated = await request("preview", draft);
  assert.equal(repeated.id, first.id);
  assert.equal(first.mode, "preview");
  const context = await buildContext(first.id);
  assert(context.some((message) => message.content.includes(draft.prompt)));
  assert(!context.some((message) => message.content.includes(saved.prompt)));
  const after = (await request("roles")).find((r: any) => r.id === role.id);
  assert.equal(after.prompt, before.prompt);
  assert.equal(after.revision, before.revision);
  assert.equal(after.published_version, before.published_version);

  await append(pool, first.id, {
    kind: "utterance",
    speaker: "user",
    text: "上一场试聊的独立回答",
  });
  const second = await request("preview", {
    ...draft,
    prompt: "最新编辑：只询问事务隔离",
    request_id: randomUUID(),
  });
  assert.notEqual(second.id, first.id);
  const nextContext = await buildContext(second.id);
  assert(
    nextContext.some((message) =>
      message.content.includes("最新编辑：只询问事务隔离"),
    ),
  );
  assert(
    !nextContext.some((message) =>
      message.content.includes("上一场试聊的独立回答"),
    ),
  );
  const records = await request("records");
  assert(!records.items.some((s: any) => [first.id, second.id].includes(s.id)));
});

test("ending a preview uses current version and safely retries after the response is lost", async () => {
  const s = await request("preview", {
    name: "结束试聊回归",
    prompt: "简短面试",
  });
  await pool.query(
    "UPDATE sessions SET status='active',active_since=now(),version=version+2,epoch=epoch+1 WHERE id=$1",
    [s.id],
  );
  await request(`sessions/${s.id}/control`, { action: "end" }, 409);
  await request(
    `sessions/${s.id}/control`,
    { action: "end", expected_version: s.version, expected_epoch: s.epoch },
    409,
  );
  const { session } = await request(`sessions/${s.id}`);
  assert(session.active_since);
  const end = {
    action: "end",
    expected_version: session.version,
    expected_epoch: session.epoch,
    request_id: randomUUID(),
  };
  const ended = await request(`sessions/${s.id}/control`, end);
  assert.equal(ended.status, "ended");
  assert.deepEqual(await request(`sessions/${s.id}/control`, end), ended);
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM events WHERE session_id=$1 AND kind='ended'",
        [s.id],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM assessments WHERE session_id=$1", [s.id]))
      .rowCount,
    0,
  );
});

test("preview rejects an inaccessible role and preserves role save conflict protection", async () => {
  await request(
    "preview",
    { role_id: randomUUID(), name: "不存在", prompt: "检查权限" },
    404,
  );
  const data = { name: "保存冲突回归", prompt: "最初内容" };
  const role = await request("roles/new", data);
  await request(`roles/${role.id}`, {
    ...data,
    prompt: "其他编辑已保存",
    expected_revision: role.revision,
  });
  await request(
    `roles/${role.id}`,
    { ...data, expected_revision: role.revision },
    409,
  );
  assert.equal(
    (await request("roles")).find((r: any) => r.id === role.id).prompt,
    "其他编辑已保存",
  );
});

test("a template can be saved and then edited for preview without replacing its saved version", async () => {
  const template = findPromptTemplate("frontend-fixed")!;
  const draft = templateRoleDraft(template);
  const role = await request("roles/new", draft);
  const customQuestion = "请介绍你负责过的星桥前端项目。";
  const originalQuestion =
    "请简要介绍你最近的一段工作或项目经历，以及你主要负责的部分。";
  assert(draft.prompt.includes(originalQuestion));
  const edited = draft.prompt.replace(originalQuestion, customQuestion);
  const preview = await request("preview", {
    ...draft,
    role_id: role.id,
    prompt: edited,
  });
  const context = await buildContext(preview.id);
  assert(context.some((message) => message.content.includes(edited)));
  assert(
    !context.some((message) => message.content.includes(originalQuestion)),
  );
  const saved = (await request("roles")).find((r: any) => r.id === role.id);
  assert.equal(saved.prompt, draft.prompt);
  assert.equal(saved.published_version, null);
  await request(`sessions/${preview.id}/control`, {
    action: "end",
    expected_version: preview.version,
    expected_epoch: preview.epoch,
  });
});

test("all interview styles reach preview as literal Prompt text without a structured plan", async () => {
  for (const template of promptTemplates) {
    const preview = await request("preview", templateRoleDraft(template));
    const context = await buildContext(preview.id);
    assert(
      context.some((message) => message.content.includes(template.prompt)),
      template.id,
    );
    await request(`sessions/${preview.id}/control`, {
      action: "end",
      expected_version: preview.version,
      expected_epoch: preview.epoch,
    });
  }
  const freeform =
    "直接讨论候选人提到的一个经验。\n不设题单、阶段、时长或固定格式；信息充分后邀请对方提问并自然结束。";
  const preview = await request("preview", {
    name: "自由 Prompt 回归",
    prompt: freeform,
  });
  const context = await buildContext(preview.id);
  assert(context.some((message) => message.content.includes(freeform)));
  await request(`sessions/${preview.id}/control`, {
    action: "end",
    expected_version: preview.version,
    expected_epoch: preview.epoch,
  });
});

test("preview history is readable immediately after ending and follows transcript revisions and late recovery", async () => {
  const s = await request("preview", {
    name: "即时记录回归",
    prompt: "询问项目",
  });
  const question = await append(pool, s.id, {
    kind: "generated",
    speaker: "assistant",
    text: "请介绍项目。",
    metadata: { tts_complete: true },
  });
  const answer = await append(pool, s.id, {
    kind: "utterance",
    speaker: "user",
    text: "我做了三年。",
  });
  const followup = await append(pool, s.id, {
    kind: "generated",
    speaker: "assistant",
    text: "你负责什么？",
  });
  const revised = await append(pool, s.id, {
    kind: "utterance",
    speaker: "user",
    text: "我做了四年。",
    metadata: {
      revision_of: answer.event_id,
      input_turn_id: answer.event_id,
      revision: 1,
    },
  });
  await pool.query(
    "INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,epoch,event_id,played_ms) VALUES($1::uuid,$2,'assistant',$1::text,$1::text,'fixture',0,1000,24000,1,$3,500)",
    [randomUUID(), s.id, question.event_id],
  );
  await request(`sessions/${s.id}/control`, {
    action: "end",
    expected_version: s.version,
    expected_epoch: s.epoch,
  });
  const history = await request(`sessions/${s.id}/preview-history`);
  assert.equal(history.session.status, "ended");
  assert.equal(history.transcription_status, "pending");
  assert.deepEqual(
    history.turns.map((t: any) => t.event_id),
    [question.event_id, revised.event_id, followup.event_id],
  );
  assert.equal(history.turns[0].playback, "partial");
  assert.equal(history.turns[0].text, question.text);
  assert.equal(history.turns[1].text, revised.text);
  assert.equal(history.turns[2].playback, "unheard");
  assert(!JSON.stringify(history).includes(answer.text));
  assert(!("runtime_config" in history.session));
  await pool.query(
    "UPDATE chunks SET played_ms=duration_ms WHERE session_id=$1",
    [s.id],
  );
  const recovered = await append(pool, s.id, {
    kind: "transcription_recovery",
    speaker: "user",
    text: "刚才还补充了一点。",
  });
  await pool.query(
    "UPDATE jobs SET state='done' WHERE session_id=$1 AND kind='transcription'",
    [s.id],
  );
  const updated = await request(`sessions/${s.id}/preview-history`);
  assert.equal(updated.turns[0].playback, "heard");
  assert.equal(updated.turns.at(-1).event_id, recovered.event_id);
  assert.equal(updated.turns.at(-1).recovered, true);
  assert.equal(updated.transcription_status, "done");
  assert(!(await request("records")).items.some((r: any) => r.id === s.id));
});

test("preview history is isolated by session and organization and unavailable to candidates", async () => {
  const first = await request("preview", {
    name: "历史隔离一",
    prompt: "询问经历",
  });
  await append(pool, first.id, {
    kind: "utterance",
    speaker: "user",
    text: "只属于上一场试聊。",
  });
  const second = await request("preview", {
    name: "历史隔离二",
    prompt: "询问经历",
  });
  assert.deepEqual(
    (await request(`sessions/${second.id}/preview-history`)).turns,
    [],
  );
  const otherOrg = `other-${randomUUID()}`,
    otherToken = randomUUID(),
    candidateToken = randomUUID();
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [otherOrg]);
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,NULL,$2,now()+interval '1 hour')",
    [hash(otherToken), otherOrg],
  );
  const user = (
    await pool.query("SELECT user_id FROM sessions WHERE id=$1", [first.id])
  ).rows[0];
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,$2,NULL,now()+interval '1 hour')",
    [hash(candidateToken), user.user_id],
  );
  for (const [client, cookie] of [
    ["admin", `interview_admin=${otherToken}`],
    ["candidate", `interview_candidate=${candidateToken}`],
  ]) {
    const response = await GET(
      new NextRequest(
        `${process.env.APP_URL}/api/sessions/${first.id}/preview-history`,
        {
          headers: { Cookie: cookie, "X-Interview-Client": client },
        },
      ),
    );
    assert.equal(response.status, client === "admin" ? 404 : 403);
    assert(!JSON.stringify(await response.json()).includes("只属于上一场试聊"));
  }
  await pool.query("UPDATE sessions SET mode='formal' WHERE id=$1", [
    second.id,
  ]);
  await request(`sessions/${second.id}/preview-history`, undefined, 404);
});

test("preview history detects timeout completion without waiting for a relay event or background jobs", async () => {
  const s = await request("preview", {
    name: "到时记录回归",
    prompt: "询问经历",
  });
  await pool.query(
    "UPDATE sessions SET deadline_at=now()-interval '1 second' WHERE id=$1",
    [s.id],
  );
  const history = await request(`sessions/${s.id}/preview-history`);
  assert.equal(history.session.status, "ended");
  assert.equal(history.session.end_reason, "timeout");
  assert.equal(history.transcription_status, "pending");
  assert.deepEqual(history.turns, []);
});

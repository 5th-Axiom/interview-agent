import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../app/api/[...path]/route";
import { pool, ApiError } from "../server/db";
import { hash } from "../server/auth";
import { assistPrompt } from "../server/prompt-assistant";
import { promptAssistantSchema } from "../shared/prompt-assistant";

const draft = {
  action: "draft" as const,
  name: "前端工程师",
  description: "开发 React 应用并定位性能问题",
  goals: [{ name: "性能问题定位", priority: "high" as const }],
  style: "open" as const,
  notes: "重点问清个人贡献和如何验证改进效果",
};
const org = `prompt-helper-${randomUUID()}`;
const token = randomUUID();
const candidate = randomUUID();
const ready = (async () => {
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,NULL,$2,now()+interval '1 hour')",
    [hash(token), org],
  );
  const userId = randomUUID();
  await pool.query(
    "INSERT INTO users(id,phone_hash,phone_mask) VALUES($1,$2,'test-only')",
    [userId, hash(userId)],
  );
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,$2,NULL,now()+interval '1 hour')",
    [hash(candidate), userId],
  );
})();
after(() => pool.end());

async function request(
  body: unknown,
  client: "admin" | "candidate" | "anonymous" = "admin",
  origin?: string,
) {
  await ready;
  return POST(
    new NextRequest(`${process.env.APP_URL}/api/admin/prompt-assistant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Interview-Client": client === "anonymous" ? "admin" : client,
        ...(client === "anonymous"
          ? {}
          : {
              Cookie:
                client === "admin"
                  ? `interview_admin=${token}`
                  : `interview_candidate=${candidate}`,
            }),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

test("prompt assistance requires admin authentication and a permitted origin", async () => {
  assert.equal((await request(draft, "anonymous")).status, 401);
  assert.equal((await request(draft, "candidate")).status, 403);
  assert.equal(
    (await request(draft, "admin", "https://untrusted.example")).status,
    403,
  );
});

test("input limits reject empty goals, unknown style, excessive content and empty extraction source", async () => {
  for (const input of [
    { ...draft, goals: [] },
    { ...draft, goals: [{ name: "   ", priority: "high" }] },
    { ...draft, goals: Array(7).fill(draft.goals[0]) },
    { ...draft, style: "workflow" },
    { ...draft, notes: "a".repeat(3001) },
    { action: "goals", name: draft.name, description: " " },
  ]) {
    assert.equal(promptAssistantSchema.safeParse(input).success, false);
    assert.equal((await request(input)).status, 400);
  }
});

test("generation is explicitly simulated in tests and never writes role/session/published snapshots", async () => {
  await ready;
  const counts = () =>
    pool.query(
      `SELECT
    (SELECT count(*) FROM roles WHERE org_id=$1)::int AS roles,
    (SELECT count(*) FROM sessions s JOIN entries e ON e.id=s.entry_id WHERE e.org_id=$1)::int AS sessions,
    (SELECT count(*) FROM role_versions v JOIN roles r ON r.id=v.role_id WHERE r.org_id=$1)::int AS versions`,
      [org],
    );
  const before = (await counts()).rows;
  const goalsResponse = await request({
    action: "goals",
    name: draft.name,
    description: draft.description,
  });
  assert.equal(goalsResponse.status, 200);
  const goals = await goalsResponse.json();
  assert.equal(goals.testMode, true);
  assert(goals.goals.length > 0);
  const response = await request(draft);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.testMode, true);
  assert.match(result.prompt, /测试模式/);
  assert.match(result.prompt, /性能问题定位（重点）/);
  assert.match(result.prompt, /complete_interview/);
  assert.deepEqual((await counts()).rows, before);
});

test("provider request preserves confirmed goals and style; malformed output is a recoverable upstream error", async () => {
  let calls = 0;
  await assert.rejects(
    assistPrompt(draft, AbortSignal.timeout(2000), {
      simulate: false,
      generate: async (instruction, data, signal, purpose) => {
        calls++;
        assert.deepEqual(data, draft);
        assert.equal(purpose, "assessment");
        assert.equal(signal.aborted, false);
        assert.match(instruction, /open 是无固定阶段/);
        assert.match(instruction, /request_end_confirmation/);
        return { prompt: "不完整" };
      },
    }),
    (error: unknown) => error instanceof ApiError && error.status === 502,
  );
  assert.equal(calls, 1);
});

test("cancelling aborts the provider call and discards even a late successful result", async () => {
  const controller = new AbortController();
  await assert.rejects(
    assistPrompt(draft, controller.signal, {
      simulate: false,
      generate: async (_instruction, _data, signal) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        return { prompt: "这是一个延迟返回的生成结果。".repeat(20) };
      },
    }),
    (error: unknown) => error instanceof ApiError && error.status === 408,
  );
});

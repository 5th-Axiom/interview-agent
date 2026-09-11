import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = process.env.TEST_BASE_URL || "http://localhost:3100";
let cookie = "";
let adminCookie = "";
async function request(path, body, admin = false, expected = 200) {
  if (path.endsWith("/control") && body) {
    const { session } = await request(
      path.replace(/\/control$/, ""),
      undefined,
      admin,
    );
    body = {
      ...body,
      expected_version: session.version,
      expected_epoch: session.epoch,
    };
  }
  const res = await fetch(`${base}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: admin ? adminCookie : cookie,
      "X-Interview-Client": admin ? "admin" : "candidate",
    },
    body:
      body === undefined
        ? undefined
        : JSON.stringify({ request_id: randomUUID(), ...body }),
  });
  if (res.headers.get("set-cookie")) {
    if (admin) adminCookie = res.headers.get("set-cookie").split(";")[0];
    else cookie = res.headers.get("set-cookie").split(";")[0];
  }
  const value = await res.json();
  assert.equal(res.status, expected, `${path}: ${value.error ?? res.status}`);
  return value;
}
const phone = `edge-${Date.now()}`;
await request("auth/code", { phone });
await request("auth/login", { phone, code: "123456" });
const boot = await request("bootstrap?entry=demo");
const a = boot.roles[0],
  b = boot.roles[1];
const s = await request("sessions/start", { entry: "demo", role_id: a.id });
await request(`sessions/${s.id}/control`, { action: "role", role_id: b.id });
await request(`sessions/${s.id}/control`, { action: "end" });
await request(`sessions/${s.id}/feedback`, {}, false, 400);
await request(
  `sessions/${s.id}/feedback`,
  { text: "字".repeat(501) },
  false,
  400,
);
await request(`sessions/${s.id}/feedback`, {
  text: "不该被提交",
  rating: 5,
  tags: ["其他"],
  skipped: true,
});
let detail = await request(`sessions/${s.id}`);
assert.equal(detail.feedback.text, "");
assert.equal(detail.feedback.rating, null);
await request(`sessions/${s.id}/feedback`, { text: "重复修改" });
detail = await request(`sessions/${s.id}`);
assert.equal(detail.feedback.text, "");
const retry = await request(`sessions/${s.id}/retry`, { reason: "" });
assert.equal(retry.reason, "");
await request("auth/admin", { password: "local-recruiter" }, true);
const records = await request(`records?role=${a.id}`, undefined, true);
assert(records.items.some((r) => r.id === s.id));
assert.equal(records.page, 1);
await request("records?date=bad", undefined, true, 400);
await request(
  `sessions/${s.id}/assessment-prompt`,
  { prompt: "只观察有原始证据的项目经历", expected_prompt_version: 0 },
  true,
);
await request(
  `sessions/${s.id}/assessment-prompt`,
  { prompt: "过期修改", expected_prompt_version: 0 },
  true,
  409,
);
const roles = await request("roles", undefined, true),
  role = roles[0];
await request(
  `roles/${role.id}`,
  {
    name: role.name,
    description: role.description,
    prompt: role.prompt,
    expected_revision: role.revision + 99,
  },
  true,
  409,
);
const current = await request(`sessions/${s.id}`, undefined, true);
assert.equal(current.session.assessment_prompt_version, 1);
assert.equal(current.session.assessment_version, 1);
const beforePreview = (await request("roles", undefined, true)).length;
const preview = await request(
  "preview",
  { name: "未保存试聊", prompt: "仅用于试聊，简短开场", description: "" },
  true,
);
assert.equal((await request("roles", undefined, true)).length, beforePreview);
await request(`sessions/${preview.id}/control`, { action: "end" }, true);
console.log(
  JSON.stringify({
    result: "PASS",
    checks: [
      "feedback empty/500 limit",
      "skip discards contents",
      "feedback immutable retry",
      "optional retry reason",
      "historical role filter",
      "record pagination",
      "invalid date",
      "assessment settings CAS",
      "stale role save rejected",
      "unsaved preview does not create visible draft",
    ],
  }),
);

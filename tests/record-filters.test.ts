import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/[...path]/route";
import { pool, transaction } from "../server/db";
import { hash, phoneHash } from "../server/auth";
import { start } from "../server/business";

after(() => pool.end());

async function fixture() {
  const org = `records-${randomUUID()}`;
  const token = randomUUID(),
    role = randomUUID(),
    version = randomUUID();
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
  await pool.query(
    "INSERT INTO auth_sessions VALUES($1,NULL,$2,now()+interval '1 hour')",
    [hash(token), org],
  );
  await pool.query(
    "INSERT INTO roles(id,org_id,name,prompt) VALUES($1,$2,'筛选测试岗位','简短面试')",
    [role, org],
  );
  await pool.query(
    "INSERT INTO role_versions(id,role_id,name,description,prompt) VALUES($1,$2,'筛选测试岗位','','简短面试')",
    [version, role],
  );
  await pool.query(
    "UPDATE roles SET status='published',published_version=$2 WHERE id=$1",
    [role, version],
  );
  async function request(
    path: string,
    body?: Record<string, unknown>,
    expected = 200,
  ) {
    const req = new NextRequest(`${process.env.APP_URL}/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: `interview_admin=${token}`,
        "X-Interview-Client": "admin",
        "Content-Type": "application/json",
      },
      body: body
        ? JSON.stringify({ request_id: randomUUID(), ...body })
        : undefined,
    });
    const response = await (body ? POST(req) : GET(req));
    const data = await response.json();
    assert.equal(response.status, expected, data.error);
    return data;
  }
  async function record(
    status?: "pending" | "approved" | "rejected",
    options: {
      user?: string;
      created?: string;
      mode?: string;
      phone?: string;
      entry?: string;
    } = {},
  ) {
    const user = options.user ?? randomUUID(),
      id = randomUUID(),
      segment = randomUUID(),
      retryId = randomUUID();
    if (!options.user)
      await pool.query("INSERT INTO users VALUES($1,$2,'139****1234')", [
        user,
        options.phone ? phoneHash(options.phone) : user,
      ]);
    await pool.query(
      "INSERT INTO sessions(id,user_id,entry_id,mode,status,started_at,ended_at,end_reason,created_at,test_mode) VALUES($1,$2,$3,$4,'ended',$5,$5,'completed',$5,true)",
      [
        id,
        user,
        options.entry ?? org,
        options.mode ?? "formal",
        options.created ?? "2026-09-01T04:00:00Z",
      ],
    );
    await pool.query(
      "INSERT INTO role_segments(id,session_id,role_version_id,start_seq) VALUES($1,$2,$3,0)",
      [segment, id, version],
    );
    await pool.query("UPDATE sessions SET current_segment=$2 WHERE id=$1", [
      id,
      segment,
    ]);
    if (status)
      await pool.query(
        "INSERT INTO retry_requests(id,session_id,reason,status) VALUES($1,$2,'筛选测试',$3)",
        [retryId, id, status],
      );
    return { id, user, retryId };
  }
  return { org, role, request, record };
}

test("retry filters distinguish pending, approved unused and consumed eligibility", async () => {
  const f = await fixture();
  const pending = await f.record("pending"),
    available = await f.record("approved");
  await f.record("rejected");
  await f.record();
  await f.record("approved", { mode: "preview" });
  const used = await f.record("approved");
  const newer = await f.record(undefined, {
    user: used.user,
    created: "2026-09-02T04:00:00Z",
  });
  await pool.query("UPDATE retry_requests SET used_by=$2 WHERE id=$1", [
    used.retryId,
    newer.id,
  ]);
  // An approval on an old round must not advertise access to a newer round.
  const stale = await f.record("approved");
  await f.record(undefined, {
    user: stale.user,
    created: "2026-09-02T04:00:00Z",
  });
  const closedEntry = `${f.org}-closed`;
  await pool.query("INSERT INTO entries VALUES($1,$2,'已关闭测试入口',false)", [
    closedEntry,
    f.org,
  ]);
  await f.record("approved", { entry: closedEntry });
  const other = await fixture();
  await other.record("approved");

  assert.deepEqual(
    (await f.request("records?retry=available")).items.map((s: any) => s.id),
    [available.id],
  );
  assert.deepEqual(
    (await f.request("records?retry=pending")).items.map((s: any) => s.id),
    [pending.id],
  );
  const all = (await f.request("records")).items;
  assert(all.find((s: any) => s.id === available.id).retry_available);
  assert(all.find((s: any) => s.id === pending.id).pending);
  assert.equal(all.find((s: any) => s.id === used.id).retry_available, false);

  await f.request(`sessions/${pending.id}/retry-review`, {
    retry_id: pending.retryId,
    status: "approved",
  });
  assert.equal((await f.request("records?retry=pending")).items.length, 0);
  assert(
    (await f.request("records?retry=available")).items.some(
      (s: any) => s.id === pending.id,
    ),
  );
  await transaction((db) =>
    start(db, { user_id: pending.user, org_id: null }, f.org, f.role),
  );
  assert(
    !(await f.request("records?retry=available")).items.some(
      (s: any) => s.id === pending.id,
    ),
  );
});

test("retry filters combine with phone, role, state and Shanghai date before pagination", async () => {
  const f = await fixture();
  // Nonmatching recent rows must not hide eligible rows on later pages.
  for (let n = 0; n < 51; n++) {
    await f.record();
    await f.record("approved", { created: "2026-08-30T04:00:00Z" });
  }
  const first = await f.request("records?retry=available"),
    second = await f.request("records?retry=available&page=2");
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.items, ...second.items].map((s: any) => s.id)).size,
    51,
  );

  const phone = `139${String(Math.floor(Math.random() * 100000000)).padStart(8, "0")}`;
  const target = await f.record("approved", {
    phone,
    created: "2026-09-01T16:30:00Z",
  });
  const query = new URLSearchParams({
    retry: "available",
    phone,
    role: f.role,
    status: "completed",
    date: "2026-09-02",
  });
  assert.deepEqual(
    (await f.request(`records?${query}`)).items.map((s: any) => s.id),
    [target.id],
  );
  query.set("date", "2026-09-01");
  assert.deepEqual((await f.request(`records?${query}`)).items, []);
  query.set("date", "2026-09-02");
  query.set("role", randomUUID());
  assert.deepEqual((await f.request(`records?${query}`)).items, []);
  await f.request("records?retry=approved", undefined, 400);
});

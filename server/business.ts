import { freezeRuntime } from "./runtime-profile";
import { randomUUID } from "node:crypto";
import { DB, pool, transaction, requireThat } from "./db";
import { testMode } from "./config";
import { Actor, hash } from "./auth";
export const defaultAssessment =
  "根据面试原始记录整理能力观察、优势、需进一步确认的问题。每项观察引用真实 event_id。不推断敏感属性，不给录用结论。缺少证据时明确说明。";
export const actorKey = (a: Actor) => a.user_id ?? `org:${a.org_id}`;
export function admin(a: Actor) {
  requireThat(a.org_id, "需要招聘方权限", 403);
  return a.org_id;
}
export async function access(db: DB, a: Actor, id: string, lock = false) {
  const r = (
    await db.query(
      `SELECT s.*,e.org_id,rv.name FROM sessions s JOIN entries e ON e.id=s.entry_id LEFT JOIN role_segments rs ON rs.id=s.current_segment LEFT JOIN role_versions rv ON rv.id=rs.role_version_id WHERE s.id=$1 ${lock ? "FOR UPDATE OF s" : ""}`,
      [id],
    )
  ).rows[0];
  requireThat(
    r && (r.user_id === a.user_id || r.org_id === a.org_id),
    "记录不存在或无权访问",
    404,
  );
  return r;
}
export async function command<T>(
  a: Actor,
  request_id: string,
  body: unknown,
  fn: (db: DB) => Promise<T>,
): Promise<T> {
  return transaction(async (db) => {
    const actor = actorKey(a),
      digest = hash(JSON.stringify(body));
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      actor + request_id,
    ]);
    const old = (
      await db.query(
        "SELECT * FROM commands WHERE actor=$1 AND request_id=$2",
        [actor, request_id],
      )
    ).rows[0];
    if (old) {
      requireThat(old.digest === digest, "相同请求编号不能用于不同操作", 409);
      return old.result;
    }
    const result = await fn(db);
    await db.query("INSERT INTO commands VALUES($1,$2,$3,$4)", [
      actor,
      request_id,
      digest,
      JSON.stringify(result),
    ]);
    return result;
  });
}
export async function append(
  db: DB,
  id: string,
  data: {
    event_id?: string;
    kind: string;
    speaker?: string;
    text?: string;
    response_id?: string;
    epoch?: number;
    metadata?: unknown;
  },
) {
  const eid = data.event_id ?? randomUUID();
  await db.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [id]);
  const old = (
    await db.query("SELECT * FROM events WHERE session_id=$1 AND event_id=$2", [
      id,
      eid,
    ])
  ).rows[0];
  if (old) {
    requireThat(
      old.text === (data.text ?? "") && old.kind === data.kind,
      "事件编号与内容冲突",
      409,
    );
    return old;
  }
  const s = (
    await db.query(
      "UPDATE sessions SET seq=seq+1 WHERE id=$1 RETURNING seq,current_segment",
      [id],
    )
  ).rows[0];
  return (
    await db.query(
      "INSERT INTO events(session_id,seq,event_id,kind,speaker,text,segment_id,response_id,epoch,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [
        id,
        s.seq,
        eid,
        data.kind,
        data.speaker ?? "system",
        data.text ?? "",
        s.current_segment,
        data.response_id ?? null,
        data.epoch ?? null,
        JSON.stringify(data.metadata ?? {}),
      ],
    )
  ).rows[0];
}
export async function stopActivity(db: DB, id: string, reason: string) {
  await db.query(
    "UPDATE sessions SET active_ms=active_ms+CASE WHEN active_since IS NULL THEN 0 ELSE GREATEST(0,EXTRACT(EPOCH FROM (LEAST(now(),COALESCE(heartbeat_at+interval '15 seconds',now()),COALESCE(deadline_at,now()))-active_since))*1000)::bigint END,active_since=NULL WHERE id=$1",
    [id],
  );
  await db.query(
    "UPDATE activities SET ended_at=now(),reason=$2 WHERE session_id=$1 AND ended_at IS NULL",
    [id, reason],
  );
}
export async function enqueue(db: DB, kind: string, id: string, version = 0) {
  await db.query(
    "INSERT INTO jobs(id,kind,session_id,version) VALUES($1,$2,$3,$4) ON CONFLICT(kind,session_id,version) DO UPDATE SET state='pending',attempts=0,available_at=now(),lease_token=NULL WHERE EXCLUDED.kind='summary' AND jobs.state IN ('done','failed')",
    [randomUUID(), kind, id, version],
  );
  if (kind === "assessment")
    await db.query(
      "UPDATE jobs SET available_at=GREATEST(now(),(SELECT ended_at+interval '30 seconds' FROM sessions WHERE id=$1)) WHERE session_id=$1 AND kind='assessment' AND version=$2 AND state='pending'",
      [id, version],
    );
}
export async function endSession(db: DB, id: string, reason: string) {
  const s = (
    await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (s.status === "ended") return s;
  await stopActivity(db, id, reason);
  await append(db, id, { kind: "ended", metadata: { reason } });
  const row = (
    await db.query(
      "UPDATE sessions SET status='ended',ended_at=now(),end_reason=$2,version=version+1,epoch=epoch+1,assessment_version=assessment_version+1 WHERE id=$1 RETURNING *",
      [id, reason],
    )
  ).rows[0];
  if (s.mode === "formal") {
    await db.query(
      "INSERT INTO assessments(session_id,version,prompt,event_cutoff) VALUES($1,$2,$3,$4)",
      [
        id,
        row.assessment_version,
        s.assessment_prompt || defaultAssessment,
        row.seq,
      ],
    );
    await enqueue(db, "assessment", id, row.assessment_version);
  }
  await enqueue(db, "recording", id);
  await enqueue(db, "transcription", id);
  await db.query(
    "UPDATE jobs SET available_at=now()+interval '3 seconds' WHERE session_id=$1 AND kind IN ('recording','transcription') AND state='pending'",
    [id],
  );
  return row;
}
export async function expire(db: DB, s: any) {
  requireThat(s, "会话不存在", 404);
  if (
    s.status !== "ended" &&
    s.deadline_at &&
    new Date(s.deadline_at).getTime() <= Date.now()
  )
    return endSession(db, s.id, "timeout");
  return s;
}
export async function bootstrap(a: Actor, entry: string) {
  requireThat(a.user_id, "请使用候选人账号登录", 403);
  return transaction(async (db) => {
    const e = (
      await db.query("SELECT * FROM entries WHERE id=$1 AND open", [entry])
    ).rows[0];
    requireThat(e, "招聘入口已关闭", 404);
    await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [a.user_id]);
    let s = (
      await db.query(
        "SELECT * FROM sessions WHERE user_id=$1 AND entry_id=$2 AND mode='formal' ORDER BY created_at DESC LIMIT 1",
        [a.user_id, entry],
      )
    ).rows[0];
    if (s) s = await expire(db, s);
    let eligible = !s || s.status !== "ended";
    if (s?.status === "ended")
      eligible = !!(
        await db.query(
          "SELECT 1 FROM retry_requests WHERE session_id=$1 AND status='approved' AND used_by IS NULL",
          [s.id],
        )
      ).rowCount;
    return {
      entry: e,
      session: s ? publicSession(s) : null,
      eligible,
      roles: (
        await db.query(
          "SELECT r.id,v.name,v.description,r.status FROM roles r JOIN role_versions v ON v.id=r.published_version WHERE r.org_id=$1 AND r.status='published' ORDER BY v.name",
          [e.org_id],
        )
      ).rows,
    };
  });
}
export async function start(db: DB, a: Actor, entry: string, roleId: string) {
  requireThat(a.user_id, "请使用候选人账号登录", 403);
  await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [a.user_id]);
  const role = (
    await db.query(
      "SELECT r.* FROM roles r JOIN entries e ON e.org_id=r.org_id WHERE e.id=$1 AND e.open AND r.id=$2 AND r.status='published'",
      [entry, roleId],
    )
  ).rows[0];
  requireThat(role, "岗位暂不可用", 409);
  let prior = (
    await db.query(
      "SELECT * FROM sessions WHERE user_id=$1 AND entry_id=$2 AND mode='formal' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [a.user_id, entry],
    )
  ).rows[0];
  if (prior) prior = await expire(db, prior);
  if (prior && prior.status !== "ended") return prior;
  let grant;
  if (prior) {
    grant = (
      await db.query(
        "SELECT * FROM retry_requests WHERE session_id=$1 AND status='approved' AND used_by IS NULL FOR UPDATE",
        [prior.id],
      )
    ).rows[0];
    requireThat(grant, "需要招聘方通过再次面试申请", 403);
  }
  const id = randomUUID();
  await db.query(
    "INSERT INTO sessions(id,user_id,entry_id,status,started_at,deadline_at) VALUES($1,$2,$3,'recovery',now(),now()+interval '1 hour')",
    [id, a.user_id, entry],
  );
  await db.query(
    "UPDATE sessions SET test_mode=$2,runtime_config=$3 WHERE id=$1",
    [id, testMode, JSON.stringify(freezeRuntime())],
  );
  if (grant)
    await db.query("UPDATE retry_requests SET used_by=$2 WHERE id=$1", [
      grant.id,
      id,
    ]);
  return selectRole(db, id, role.published_version);
}
export async function selectRole(db: DB, id: string, version: string) {
  await stopActivity(db, id, "role");
  await db.query(
    "UPDATE voice_connections SET retired_at=COALESCE(retired_at,now()) WHERE session_id=$1 AND retired_at IS NULL",
    [id],
  );
  const segment = randomUUID();
  const s = (await db.query("SELECT seq FROM sessions WHERE id=$1", [id]))
    .rows[0];
  await db.query(
    "INSERT INTO role_segments(id,session_id,role_version_id,start_seq) VALUES($1,$2,$3,$4)",
    [segment, id, version, s.seq + 1],
  );
  await db.query(
    "UPDATE sessions SET current_segment=$2,status='recovery',heartbeat_at=NULL,epoch=epoch+1,version=version+1 WHERE id=$1",
    [id, segment],
  );
  await append(db, id, {
    kind: "role_selected",
    metadata: { role_version: version },
  });
  return (await db.query("SELECT * FROM sessions WHERE id=$1", [id])).rows[0];
}
export async function control(
  db: DB,
  a: Actor,
  id: string,
  action: string,
  version?: number,
  roleId?: string,
  expectedEpoch?: number,
) {
  let s = await access(db, a, id, true);
  s = await expire(db, s);
  if (s.status === "ended") return s;
  requireThat(
    s.user_id === a.user_id || (s.mode === "preview" && s.org_id === a.org_id),
    "无权控制会话",
    403,
  );
  requireThat(
    version === s.version &&
      (expectedEpoch === undefined || expectedEpoch === s.epoch),
    "会话状态已变化，请重试",
    409,
  );
  if (action === "end") return endSession(db, id, "manual");
  if (action === "role") {
    const role = (
      await db.query(
        "SELECT * FROM roles WHERE id=$1 AND org_id=$2 AND status='published'",
        [roleId, s.org_id],
      )
    ).rows[0];
    requireThat(role, "岗位不可用");
    return selectRole(db, id, role.published_version);
  }
  requireThat(["pause", "resume", "choose"].includes(action), "无效命令");
  await stopActivity(db, id, action);
  await append(db, id, { kind: action });
  await db.query(
    "UPDATE voice_connections SET retired_at=COALESCE(retired_at,now()) WHERE session_id=$1 AND epoch=$2",
    [id, s.epoch],
  );
  return (
    await db.query(
      "UPDATE sessions SET status=$2,version=version+1,epoch=epoch+1,heartbeat_at=NULL WHERE id=$1 RETURNING *",
      [id, action === "pause" ? "paused" : "recovery"],
    )
  ).rows[0];
}
export async function snapshot(a: Actor, id: string) {
  return transaction(async (db) => {
    const s = await expire(db, await access(db, a, id, true));
    const events = (
      await db.query(
        "SELECT e.*,v.name AS role_name FROM events e LEFT JOIN role_segments rs ON rs.id=e.segment_id LEFT JOIN role_versions v ON v.id=rs.role_version_id WHERE e.session_id=$1 ORDER BY e.seq",
        [id],
      )
    ).rows;
    return {
      session: a.org_id ? s : publicSession(s),
      events,
      retries: (
        await db.query(
          "SELECT * FROM retry_requests WHERE session_id=$1 ORDER BY created_at DESC",
          [id],
        )
      ).rows,
      feedback:
        (await db.query("SELECT * FROM feedback WHERE session_id=$1", [id]))
          .rows[0] ?? null,
      ...(a.org_id
        ? {
            telemetry: (
              await db.query(
                "SELECT id,epoch,stage,elapsed_ms,detail,created_at FROM voice_telemetry WHERE session_id=$1 ORDER BY id DESC LIMIT 500",
                [id],
              )
            ).rows.reverse(),
            runtime_config: s.runtime_config,
            responses: (
              await db.query(
                "SELECT * FROM response_runs WHERE session_id=$1 ORDER BY created_at",
                [id],
              )
            ).rows,
            assessments: (
              await db.query(
                "SELECT * FROM assessments WHERE session_id=$1 ORDER BY version DESC",
                [id],
              )
            ).rows,
            reviews: (
              await db.query(
                "SELECT * FROM human_reviews WHERE session_id=$1 ORDER BY created_at DESC",
                [id],
              )
            ).rows,
            recording:
              (
                await db.query(
                  "SELECT * FROM recording_assets WHERE session_id=$1",
                  [id],
                )
              ).rows[0] ?? null,
          }
        : {}),
    };
  });
}

export function publicSession(s: any) {
  const keys = [
    "id",
    "entry_id",
    "status",
    "mode",
    "current_segment",
    "started_at",
    "deadline_at",
    "ended_at",
    "end_reason",
    "active_ms",
    "active_since",
    "version",
    "epoch",
    "test_mode",
    "name",
    "created_at",
  ];
  return Object.fromEntries(keys.filter((k) => k in s).map((k) => [k, s[k]]));
}

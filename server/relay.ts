import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { validateEnvironment, testMode } from "./config";
import { verifyTicket } from "./auth";
import { pool, transaction, requireThat } from "./db";
import { append, stopActivity, endSession, expire, enqueue } from "./business";
import { clientEvent } from "../shared/contracts";
import { GenerationGate } from "../shared/voice-state";
import { buildContext } from "./context";
import { streamModel, synthesizeStream } from "./model";
import { LiveASR } from "./asr";
import { putObject, wav } from "./storage";
validateEnvironment();
const http = createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ service: "interview-relay", testMode }));
});
const wss = new WebSocketServer({ server: http, maxPayload: 150000 });
const clients = new Map<string, WebSocket>();
let draining = false;
wss.on("connection", (ws, req) => {
  if (
    draining ||
    wss.clients.size > 50 ||
    req.headers.origin !== new URL(process.env.APP_URL!).origin
  ) {
    ws.close(1008, "入口不允许");
    return;
  }
  let sid = "",
    epoch = 0,
    version = 0,
    responseId: string | null = null,
    asr: LiveASR | null = null,
    closed = false,
    going = false;
  let sessionTest = testMode;
  let interruptedAt = 0;
  let audioThrough = 0;
  let recovering = false;
  let ending: string | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let sequence = Promise.resolve();
  let queued = 0;
  let ingressBudget = 600000,
    ingressAt = Date.now();
  let generationTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPlayback = new Set<string>();
  const gate = new GenerationGate();
  const send = (data: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 2_000_000) {
        ws.close(1013, "连接积压");
        return;
      }
      ws.send(JSON.stringify({ ...data, epoch }));
    }
  };
  const initTimeout = setTimeout(() => ws.close(1008, "票据超时"), 10000);
  function cancel() {
    gate.cancel();
    ending = null;
    if (finishTimer) clearTimeout(finishTimer);
    if (generationTimer) clearTimeout(generationTimer);
    generationTimer = null;
    pendingPlayback.clear();
    if (responseId) send({ type: "cancel", response_id: responseId });
    responseId = null;
  }
  async function valid() {
    const s = (await pool.query("SELECT * FROM sessions WHERE id=$1", [sid]))
      .rows[0];
    return (
      s &&
      s.epoch === epoch &&
      s.status === "active" &&
      s.deadline_at.getTime() > Date.now()
    );
  }
  async function failure() {
    if (recovering || closed) return;
    recovering = true;
    cancel();
    asr?.close();
    asr = null;
    going = false;
    await transaction(async (db) => {
      const s = (
        await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [sid])
      ).rows[0];
      if (s?.epoch === epoch && s.status !== "ended") {
        await stopActivity(db, sid, "provider_error");
        await db.query(
          "UPDATE sessions SET status='recovery',version=version+1 WHERE id=$1",
          [sid],
        );
      }
    });
    send({
      type: "error",
      message: "语音连接中断，最后一句可能未保存，请点击继续并重述。",
    });
    recovering = false;
  }
  async function finish() {
    if (!ending || pendingPlayback.size) return;
    const reason = ending;
    ending = null;
    const didEnd = await transaction(async (db) => {
      const s = (
        await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [sid])
      ).rows[0];
      if (s.epoch === epoch && s.status === "active") {
        await endSession(db, sid, reason);
        return true;
      }
      return false;
    });
    if (didEnd) send({ type: "ended" });
  }
  async function generate() {
    cancel();
    const token = gate.begin();
    const rid = randomUUID();
    responseId = rid;
    if (!(await valid()) || !token.current()) return;
    const timer = setTimeout(() => {
      if (token.current()) void failure();
    }, 45000);
    send({ type: "thinking", response_id: rid });
    let sent = 0;
    try {
      const context = await buildContext(sid, token.signal);
      context.push({
        role: "user",
        content:
          "根据当前状态继续对话。若刚选岗，请开场；若暂停恢复，请接上当前问题。",
      });
      for await (const part of streamModel(
        context,
        token.signal,
        sessionTest,
      )) {
        if (!token.current() || closed || !(await valid())) break;
        if (part.type === "tool") {
          if (part.name === "complete_interview") {
            ending = "completed";
            finishTimer = setTimeout(() => {
              if (token.current()) {
                pendingPlayback.clear();
                void finish();
              }
            }, 20000);
          } else if (part.name === "request_end_confirmation")
            send({ type: "end_confirmation" });
          continue;
        }
        const text = part.text.trim();
        if (!text) continue;
        const event_id = randomUUID();
        await transaction(async (db) => {
          const s = (
            await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [
              sid,
            ])
          ).rows[0];
          if (s.epoch === epoch && token.current() && s.status === "active")
            await append(db, sid, {
              kind: "generated",
              speaker: "assistant",
              text,
              event_id,
              response_id: rid,
              epoch,
            });
        });
        if (!token.current()) break;
        for await (const pcm of synthesizeStream(
          text,
          token.signal,
          sessionTest,
        )) {
          while (pendingPlayback.size >= 8 && token.current()) {
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!token.current() || !(await valid())) break;
          const chunkId = randomUUID(),
            key = `${sid}/assistant/${chunkId}.wav`,
            duration = pcm.length / 48;
          await putObject(key, wav(pcm, 24000));
          if (!token.current()) break;
          await pool.query(
            "INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,response_id,epoch,event_id) SELECT $1::uuid,$2,'assistant',$1::text,$3,$4,GREATEST(0,EXTRACT(EPOCH FROM(now()-started_at))*1000)::bigint,$5,24000,$6,$7,$8::uuid FROM sessions WHERE id=$2 AND epoch=$7 AND status='active'",
            [
              chunkId,
              sid,
              key,
              createHash("sha256").update(pcm).digest("hex"),
              Math.round(duration),
              rid,
              epoch,
              event_id,
            ],
          );
          if (!token.current()) break;
          pendingPlayback.add(chunkId);
          send({
            type: "audio",
            response_id: rid,
            chunk_id: chunkId,
            event_id,
            text,
            pcm: pcm.toString("base64"),
            sample_rate: 24000,
            duration_ms: duration,
            testMode: sessionTest,
          });
          sent++;
        }
      }
      if (token.current()) {
        send({ type: "generation_done", response_id: rid });
        await finish();
        await transaction(async (db) => {
          const s = (
            await db.query(
              "SELECT seq,snapshot_version FROM sessions WHERE id=$1",
              [sid],
            )
          ).rows[0];
          if (s.seq > 24)
            await enqueue(db, "summary", sid, s.snapshot_version + 1);
        });
      }
    } catch (e) {
      if (token.current()) {
        console.error(
          "relay_generation_failed",
          e instanceof Error ? e.name : "unknown",
        );
        await failure();
      }
    } finally {
      clearTimeout(timer);
      if (token.current() && !sent)
        send({ type: "listening", response_id: rid });
    }
  }
  function schedule() {
    if (generationTimer) clearTimeout(generationTimer);
    generationTimer = setTimeout(() => {
      generationTimer = null;
      void generate();
    }, 350);
  }
  function interruptGeneration() {
    // VAD can arrive after a final transcript is saved but before its reply
    // starts. Cancelling that scheduled reply must also arm silence recovery.
    if (responseId || generationTimer || interruptedAt) {
      interruptedAt = Date.now();
      cancel();
    }
  }
  async function commitText(eid: string, text: string, revisionOf?: string) {
    if (!(await valid())) return;
    const existing = (
      await pool.query(
        "SELECT text FROM events WHERE session_id=$1 AND event_id=$2",
        [sid, eid],
      )
    ).rows[0];
    if (existing) {
      requireThat(existing.text === text, "事件编号内容冲突");
      send({ type: "saved", event_ids: [eid] });
      return;
    }
    interruptedAt = 0;
    cancel();
    const persisted = await transaction(async (db) => {
      const s = (
        await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [sid])
      ).rows[0];
      if (s.epoch !== epoch || s.status !== "active") return false;
      await append(db, sid, {
        kind: "utterance",
        speaker: "user",
        event_id: eid,
        text,
        epoch,
        metadata: {
          ...(revisionOf ? { revision_of: revisionOf } : {}),
          audio_through_ms: audioThrough,
        },
      });
      if (s.seq >= 24)
        await enqueue(db, "summary", sid, s.snapshot_version + 1);
      return true;
    });
    if (!persisted) return;
    send({ type: "saved", event_ids: [eid] });
    schedule();
  }
  async function go() {
    if (going) return;
    going = true;
    await transaction(async (db) => {
      const s = await expire(
        db,
        (await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [sid]))
          .rows[0],
      );
      requireThat(s.status !== "ended" && s.epoch === epoch, "会话已失效");
      await db.query(
        "UPDATE sessions SET status='active',active_since=COALESCE(active_since,now()),heartbeat_at=now(),version=version+1 WHERE id=$1",
        [sid],
      );
      await db.query(
        "INSERT INTO activities(session_id,epoch,started_at) VALUES($1,$2,now())",
        [sid, epoch],
      );
      await append(db, sid, { kind: "resume", epoch });
      version = s.version + 1;
    });
    if (!sessionTest) {
      asr?.close();
      asr = new LiveASR(
        (eid, text, revisionOf) => {
          sequence = sequence
            .then(() => commitText(eid, text, revisionOf))
            .catch(() => failure());
        },
        interruptGeneration,
        () => void failure(),
      );
      await asr.open();
    }
    send({ type: "active" });
    schedule();
  }
  ws.on("message", (raw) => {
    ingressBudget = Math.min(
      600000,
      ingressBudget + (Date.now() - ingressAt) * 96,
    );
    ingressAt = Date.now();
    const bytes = Array.isArray(raw)
      ? raw.reduce((n, b) => n + b.length, 0)
      : raw.byteLength;
    ingressBudget -= bytes;
    if (ingressBudget < 0) {
      ws.close(1008, "发送速率过高");
      return;
    }
    if (++queued > 60) {
      ws.close(1013, "音频队列已满");
      return;
    }
    sequence = sequence
      .then(async () => {
        const e = clientEvent.parse(JSON.parse(raw.toString()));
        if (e.type === "init") {
          requireThat(!sid, "重复初始化");
          const ticket = await verifyTicket(e.ticket);
          requireThat(
            ticket.purpose === "relay" && typeof ticket.session_id === "string",
            "无效票据",
            401,
          );
          const nextSid = String(ticket.session_id);
          await transaction(async (db) => {
            const s = await expire(
              db,
              (
                await db.query(
                  "SELECT * FROM sessions WHERE id=$1 FOR UPDATE",
                  [nextSid],
                )
              ).rows[0],
            );
            requireThat(
              s && s.user_id === ticket.user_id && s.status !== "ended",
              "会话不可连接",
              403,
            );
            requireThat(
              e.takeover ||
                !s.heartbeat_at ||
                Date.now() - s.heartbeat_at.getTime() > 15000,
              "已有页面正在面试，请显式接管",
              409,
            );
            await stopActivity(db, nextSid, "takeover");
            const row = (
              await db.query(
                "UPDATE sessions SET epoch=epoch+1,status='recovery',heartbeat_at=now(),version=version+1 WHERE id=$1 RETURNING *",
                [nextSid],
              )
            ).rows[0];
            sessionTest = row.test_mode;
            sid = nextSid;
            epoch = row.epoch;
            version = row.version;
          });
          clients.get(sid)?.close(4001, "另一页面已接管");
          clients.set(sid, ws);
          clearTimeout(initTimeout);
          send({ type: "ready", testMode: sessionTest });
          return;
        }
        requireThat(sid && e.epoch === epoch, "连接已失效", 409);
        if (e.type === "heartbeat") {
          await pool.query(
            "UPDATE sessions SET heartbeat_at=now() WHERE id=$1 AND epoch=$2 AND status<>'ended'",
            [sid, epoch],
          );
          return;
        }
        if (e.type === "go") {
          await go();
          return;
        }
        if (e.type === "interrupt") {
          if (!e.response_id || responseId === e.response_id) {
            interruptGeneration();
          }
          asr?.touch();
          return;
        }
        if (e.type === "text") {
          requireThat(sessionTest, "真实模式通过语音输入");
          await commitText(e.event_id, e.text);
          return;
        }
        if (e.type === "played") {
          const ch = (
            await pool.query(
              "UPDATE chunks SET played_ms=GREATEST(played_ms,LEAST(duration_ms,$5::int)),start_ms=COALESCE($6::bigint,start_ms) WHERE id=$1 AND session_id=$2 AND epoch=$3 AND response_id=$4 AND played_ms<$5 RETURNING *",
              [
                e.chunk_id,
                sid,
                epoch,
                e.response_id,
                Math.round(e.played_ms),
                e.started_ms === undefined ? null : Math.round(e.started_ms),
              ],
            )
          ).rows[0];
          if (ch) {
            await transaction(async (db) => {
              await append(db, sid, {
                kind: "playback",
                response_id: e.response_id,
                epoch,
                metadata: {
                  chunk_id: e.chunk_id,
                  event_id: ch.event_id,
                  played_ms: ch.played_ms,
                  duration_ms: ch.duration_ms,
                },
              });
            });
            if (ch.played_ms >= ch.duration_ms) pendingPlayback.delete(ch.id);
            await finish();
          }
          send({
            type: "playback_saved",
            chunk_id: e.chunk_id,
            played_ms: e.played_ms,
          });
          return;
        }
        if (e.type === "audio") {
          const pcm = Buffer.from(e.pcm, "base64");
          requireThat(
            pcm.length > 0 &&
              pcm.length % 2 === 0 &&
              Math.abs(pcm.length / 32 - e.duration_ms) < 2,
            "音频格式无效",
          );
          const elapsed = (
            await pool.query(
              "SELECT EXTRACT(EPOCH FROM(now()-started_at))*1000 AS ms FROM sessions WHERE id=$1",
              [sid],
            )
          ).rows[0]?.ms;
          requireThat(
            e.start_ms <= Number(elapsed) + 1000 &&
              (e.replay || e.start_ms >= Number(elapsed) - 10000),
            "音频采集时间无效",
          );
          const checksum = createHash("sha256").update(pcm).digest("hex");
          const old = (
            await pool.query(
              "SELECT checksum FROM chunks WHERE session_id=$1 AND track='user' AND chunk_no=$2",
              [sid, e.chunk_no],
            )
          ).rows[0];
          if (old) {
            requireThat(old.checksum === checksum, "音频编号冲突");
            send({ type: "audio_saved", chunk_no: e.chunk_no });
            return;
          }
          if (!(await valid())) return;
          const key = `${sid}/user/${e.chunk_no}.wav`;
          await putObject(key, wav(pcm));
          const persisted = await pool.query(
            "INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,epoch) SELECT $1::uuid,$2,'user',$1::text,$3,$4,$5,$6,16000,$7 FROM sessions WHERE id=$2 AND epoch=$7 AND status='active' ON CONFLICT DO NOTHING",
            [
              e.chunk_no,
              sid,
              key,
              checksum,
              Math.round(e.start_ms),
              Math.round(e.duration_ms),
              epoch,
            ],
          );
          if (!persisted.rowCount) return;
          send({ type: "audio_saved", chunk_no: e.chunk_no });
          if (!e.replay) {
            audioThrough = Math.max(audioThrough, e.start_ms + e.duration_ms);
            asr?.send(pcm);
          }
        }
      })
      .catch((e) => {
        send({
          type: "error",
          message:
            e instanceof Error && e.name === "ApiError"
              ? e.message
              : "连接处理失败，请重新连接",
        });
        if (!sid) ws.close(1008);
      })
      .finally(() => {
        queued--;
      });
  });
  const monitor = setInterval(async () => {
    if (!sid || closed) return;
    try {
      if (interruptedAt && Date.now() - interruptedAt > 5000 && going) {
        interruptedAt = 0;
        schedule();
      }
      const s = (await pool.query("SELECT * FROM sessions WHERE id=$1", [sid]))
        .rows[0];
      if (s.deadline_at.getTime() <= Date.now() || s.status === "ended") {
        cancel();
        await transaction((db) =>
          endSession(db, sid, s.end_reason ?? "timeout"),
        );
        send({ type: "ended" });
        ws.close();
        return;
      }
      if (s.epoch !== epoch) {
        cancel();
        ws.close(4001, "连接已更新");
        return;
      }
      if (s.version !== version && s.status !== "active") {
        version = s.version;
        cancel();
        going = false;
        asr?.close();
        asr = null;
        send({ type: "paused", status: s.status });
      }
      if (Date.now() - s.heartbeat_at.getTime() > 15000)
        ws.close(4000, "连接超时");
    } catch {
      ws.close(1011);
    }
  }, 1000);
  ws.on("close", () => {
    closed = true;
    cancel();
    asr?.close();
    clearTimeout(initTimeout);
    clearInterval(monitor);
    if (clients.get(sid) === ws) clients.delete(sid);
    if (sid)
      void transaction(async (db) => {
        const s = (
          await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [sid])
        ).rows[0];
        if (s.epoch === epoch && s.status !== "ended") {
          await stopActivity(db, sid, "disconnect");
          await db.query(
            "UPDATE sessions SET status='recovery',heartbeat_at=NULL,version=version+1 WHERE id=$1",
            [sid],
          );
        }
      }).catch(() => {});
  });
});
http.listen(Number(process.env.RELAY_PORT ?? 3001), "0.0.0.0", () =>
  console.log(
    "Relay listening",
    process.env.RELAY_PORT ?? 3001,
    testMode ? "TEST MODE" : "LIVE MODE",
  ),
);
async function shutdown() {
  draining = true;
  for (const ws of wss.clients) ws.close(1012, "服务更新，请稍后继续");
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

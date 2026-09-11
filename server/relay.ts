import { Semaphore } from "../shared/semaphore";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { validateEnvironment, testMode } from "./config";
import { verifyTicket } from "./auth";
import { pool, transaction, requireThat, type DB } from "./db";
import { append, stopActivity, endSession, expire, enqueue } from "./business";
import { clientEvent } from "../shared/contracts";
import { AsyncQueue } from "../shared/async-queue";
import { TaskLane } from "../shared/task-lane";
import { buildContext } from "./context";
import { streamModel, synthesizeStream, type Message } from "./model";
import { LiveASR, type TranscriptInfo } from "./asr";
import { speechConfig } from "./speech-provider";
import { hasTestAccess } from "./test-access";
import {
  stageAssistant,
  playbackReceipt,
  validateReceipt,
  savePlayback,
  saveUserAudio,
  decodeAudio,
  validateAudioRetry,
  audioChecksum,
} from "./audio-store";
import {
  TurnCoordinator,
  type ReplyTrigger,
  type InputTurn,
  type Reply,
} from "./turn-coordinator";
import { recordTiming } from "./telemetry";
import { spokenText, SpokenOutputError } from "./spoken-output";
validateEnvironment();
const http = createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ service: "interview-relay", testMode }));
});
const wss = new WebSocketServer({
  server: http,
  maxPayload: 150000,
  verifyClient(info, done) {
    void hasTestAccess(info.req.headers.cookie)
      .then((ok) => done(ok, ok ? undefined : 401))
      .catch(() => done(false, 401));
  },
});
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
    sessionTest = testMode,
    runtime: any = { protocol: 1 },
    closed = false,
    initializing = false,
    going = false,
    recovering = false;
  let asr: LiveASR | null = null,
    muted = false,
    lastFrame = -1,
    lastAudioAt = Date.now(),
    lastWarning = 0,
    lastInputState = -1;
  let response: Reply | null = null,
    ending: string | null = null,
    providerDone = false;
  let ingressBudget = 600000,
    ingressAt = Date.now();
  const turns = new TurnCoordinator(),
    inputLane = new TaskLane(60),
    storageLane = new TaskLane(8250),
    controlLane = new TaskLane(100),
    telemetryLane = new TaskLane(32);
  const outstanding = new Map<string, any>();
  const received = new Map<string, string>();
  const sent = new Map<string, any>();
  const initTimeout = setTimeout(() => ws.close(1008, "票据超时"), 10000);
  const send = (data: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 2_000_000) {
      ws.close(1013, "连接积压");
      return false;
    }
    ws.send(JSON.stringify({ ...data, epoch }));
    return true;
  };
  const timing = (
    stage: string,
    elapsed?: number,
    detail: Record<string, unknown> = {},
  ) => {
    if (sid)
      void telemetryLane
        .run(1, () => recordTiming(sid, epoch, stage, elapsed, detail))
        .catch(() => {});
  };
  const state = async (db: DB = pool, lock = false) => {
    const s = (
      await db.query(
        `SELECT * FROM sessions WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
        [sid],
      )
    ).rows[0];
    requireThat(s && s.epoch === epoch && !closed, "连接已失效", 409);
    return s;
  };
  const active = async () => {
    const s = await state();
    return s.status === "active" && s.deadline_at.getTime() > Date.now();
  };
  const persistReply = async (r: Reply) => {
    await pool.query(
      "UPDATE response_runs SET state=$2,cancellation_reason=$3,completed_at=CASE WHEN $2 IN ('completed','cancelled','failed') THEN now() ELSE completed_at END WHERE id=$1",
      [r.id, r.state, r.reason ?? null],
    );
  };
  function cancel(reason = "interrupted") {
    const previous = turns.cancel(reason);
    ending = null;
    providerDone = false;
    outstanding.clear();
    if (previous) {
      send({ type: "cancel", response_id: previous.id });
      timing("cancel", undefined, { response_id: previous.id });
      void persistReply(previous).catch(() => {});
    }
  }
  async function failure(
    message = "语音连接中断，已确认内容已保留，请点击继续。",
  ) {
    if (recovering || closed || !sid) return;
    recovering = true;
    cancel("provider_error");
    asr?.close();
    asr = null;
    going = false;
    try {
      await transaction(async (db) => {
        const s = await state(db, true);
        if (s.status === "ended") return;
        await stopActivity(db, sid, "provider_error");
        await db.query(
          "UPDATE sessions SET status='recovery',version=version+1 WHERE id=$1",
          [sid],
        );
      });
      send({ type: "error", message });
    } catch (error) {
      if (!closed && (error as any)?.status !== 409)
        send({ type: "error", message: "连接恢复失败，请稍后继续。" });
    } finally {
      recovering = false;
    }
  }
  async function complete(r: Reply) {
    if (!turns.isCurrent(r) || !providerDone || outstanding.size) return;
    const reason = ending;
    const didComplete = await transaction(async (db) => {
      const s = await state(db, true);
      if (
        !turns.isCurrent(r) ||
        !providerDone ||
        outstanding.size ||
        s.status !== "active"
      )
        return false;
      if (
        (
          await db.query(
            "SELECT 1 FROM chunks WHERE session_id=$1 AND response_id=$2 AND played_ms<duration_ms LIMIT 1",
            [sid, r.id],
          )
        ).rowCount
      )
        return false;
      if (reason) await endSession(db, sid, reason);
      await db.query(
        "UPDATE response_runs SET state='completed',completed_at=now() WHERE id=$1",
        [r.id],
      );
      requireThat(turns.isCurrent(r), "回复已取消", 409);
      return true;
    });
    if (didComplete) {
      turns.transition(r, "completed");
      if (reason) send({ type: "ended" });
    }
  }
  async function generate(trigger: ReplyTrigger, input?: InputTurn) {
    if (closed || !going) return;
    const r = turns.begin(trigger, input);
    if (!r) return;
    response = r;
    ending = null;
    providerDone = false;
    outstanding.clear();
    const current = () => turns.isCurrent(r) && !closed,
      signal = r.controller.signal;
    const started = performance.now();
    const timer = setTimeout(() => {
      if (current()) void failure("回复等待超时，请点击继续。");
    }, 45000);
    send({ type: "thinking", response_id: r.id });
    send({ type: "stage", stage: "generating" });
    let emitted = 0;
    try {
      if (!(await active()) || !current()) return;
      await pool.query(
        `INSERT INTO response_runs(id,session_id,epoch,generation,input_turn_id,input_revision,trigger,state,prompt_version,model_profile)
        VALUES($1,$2,$3,$4,$5,$6,$7,'generating',$8,$9)`,
        [
          r.id,
          sid,
          epoch,
          r.generation,
          input?.id ?? null,
          input?.revision ?? 0,
          trigger,
          runtime.promptVersion ?? "legacy",
          JSON.stringify(runtime.model ?? {}),
        ],
      );
      const context = await buildContext(sid, signal);
      timing("context_ready", performance.now() - started, {
        response_id: r.id,
      });
      context.push({
        role: "system",
        content: `本次回复 trigger=${trigger}，input_turn_id=${input?.id ?? "none"}，revision=${input?.revision ?? 0}。只根据这次触发与最近对话回复。`,
      });
      const queue = new AsyncQueue<string>(160, (t) => t.length, 2);
      const sentenceSlot =
        runtime.audioPipeline === false ? new Semaphore(1) : null;
      const sentenceReleases: (() => void)[] = [];
      const produce = async () => {
        try {
          let repaired = false;
          const consume = async (messages: Message[]) => {
            timing("llm_request", performance.now() - started, {
              response_id: r.id,
            });
            for await (const part of streamModel(
              messages,
              signal,
              sessionTest,
              {
                profile: runtime.model,
                onMetric: (stage, detail) =>
                  timing(stage, performance.now() - started, {
                    ...detail,
                    response_id: r.id,
                  }),
              },
            )) {
              if (!current()) return;
              if (part.type === "tool") {
                if (part.name === "complete_interview") ending = "completed";
                if (part.name === "request_end_confirmation")
                  send({ type: "end_confirmation" });
                continue;
              }
              const text = spokenText(part.text);
              if (text) {
                timing("speakable_text", performance.now() - started, {
                  response_id: r.id,
                });
                if (sentenceSlot)
                  sentenceReleases.push(await sentenceSlot.acquire(signal));
                await queue.push(text, signal);
              }
            }
          };
          try {
            await consume(context);
          } catch (error) {
            if (
              !(error instanceof SpokenOutputError) ||
              emitted ||
              queue.size ||
              !current() ||
              repaired
            )
              throw error;
            repaired = true;
            timing("output_repair", undefined, { response_id: r.id });
            await consume([
              ...context,
              {
                role: "system",
                content:
                  "上一尝试不符合朗读契约。重新给出一句直接对候选人说的自然中文，只问一个问题，最多70字；不描述规划或工具操作。",
              },
            ]);
          }
          queue.close();
        } catch (error) {
          queue.close(error);
        }
      };
      const producing = produce();
      try {
        for await (const text of queue.read(signal)) {
          if (!current()) break;
          const eventId = randomUUID();
          const saved = await transaction(async (db) => {
            const s = await state(db, true);
            if (!current() || s.status !== "active") return false;
            await append(db, sid, {
              kind: "generated",
              speaker: "assistant",
              text,
              event_id: eventId,
              response_id: r.id,
              epoch,
              metadata: {
                trigger,
                input_turn_id: input?.id,
                generation: r.generation,
                prompt_version: runtime.promptVersion,
              },
            });
            return true;
          });
          if (!saved || !current()) break;
          send({ type: "stage", stage: "synthesizing" });
          let first = true;
          timing("tts_request", performance.now() - started, {
            response_id: r.id,
          });
          for await (const pcm of synthesizeStream(
            text,
            signal,
            sessionTest,
            runtime,
          )) {
            while (
              [...outstanding.values()].reduce(
                (n, ch) => n + ch.duration_ms,
                0,
              ) +
                pcm.length / 48 >
                2400 &&
              current()
            )
              await new Promise((resolve) => setTimeout(resolve, 20));
            if (!current()) break;
            if (first) {
              timing("tts_first_pcm", performance.now() - started, {
                response_id: r.id,
              });
              first = false;
            }
            const ch = await stageAssistant(
              sid,
              epoch,
              r.id,
              eventId,
              pcm,
              current,
            );
            if (!ch || !current()) break;
            if (!emitted)
              timing("first_audio_durable", performance.now() - started, {
                response_id: r.id,
              });
            const receipt = playbackReceipt(ch);
            outstanding.set(ch.id, ch);
            sent.set(ch.id, ch);
            if (sent.size > 100) {
              throw new Error("Playback receipts not drained");
            }
            const delivered = send({
              type: "audio",
              response_id: r.id,
              chunk_id: ch.id,
              event_id: eventId,
              text,
              pcm: pcm.toString("base64"),
              sample_rate: 24000,
              duration_ms: pcm.length / 48,
              receipt,
              testMode: sessionTest,
            });
            if (!delivered) throw new Error("Audio send failed");
            turns.transition(r, "streaming");
            if (!emitted)
              timing("first_audio_sent", performance.now() - started, {
                response_id: r.id,
              });
            emitted++;
          }
          if (current())
            await transaction(async (db) => {
              await state(db, true);
              if (current())
                await db.query(
                  "UPDATE events SET metadata=metadata||'{\"tts_complete\":true}'::jsonb WHERE session_id=$1 AND event_id=$2",
                  [sid, eventId],
                );
            });
          sentenceReleases.shift()?.();
        }
        await producing;
      } finally {
        queue.close();
        for (const release of sentenceReleases) release();
        if (!current()) r.controller.abort();
      }
      if (current()) {
        providerDone = true;
        turns.transition(r, "draining");
        await persistReply(r);
        send({ type: "generation_done", response_id: r.id });
        await complete(r);
        send({ type: "stage", stage: "listening" });
      }
    } catch (error) {
      if (current()) {
        turns.fail(r, "generation_failed");
        await persistReply(r).catch(() => {});
        send({ type: "cancel", response_id: r.id });
        await failure(
          error instanceof Error && error.name === "ApiError"
            ? error.message
            : undefined,
        );
      }
    } finally {
      clearTimeout(timer);
      if (current() && !emitted) send({ type: "listening", response_id: r.id });
    }
  }
  async function commitText(
    eid: string,
    text: string,
    revisionOf?: string,
    info?: TranscriptInfo,
  ) {
    const result = await transaction(async (db) => {
      const s = await state(db, true);
      requireThat(s.status === "active", "会话已暂停", 409);
      const old = (
        await db.query(
          "SELECT text FROM events WHERE session_id=$1 AND event_id=$2",
          [sid, eid],
        )
      ).rows[0];
      if (old) {
        requireThat(old.text === text, "事件编号内容冲突", 409);
        return false;
      }
      const event = await append(db, sid, {
        kind: "utterance",
        speaker: "user",
        event_id: eid,
        text,
        epoch,
        metadata: {
          revision_of: revisionOf,
          input_turn_id: info?.inputTurnId ?? eid,
          revision: info?.revision ?? 0,
          provisional: info?.provisional ?? false,
          provider_id: info?.providerId,
          chunk_ids: info?.chunkNos ?? [],
        },
      });
      for (const ch of info?.chunkNos ?? [])
        await db.query(
          "INSERT INTO audio_coverage(session_id,chunk_no,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [sid, ch, eid],
        );
      if (text.length > 8000) await enqueue(db, "utterance", sid, event.seq);
      if (revisionOf) {
        const older = (
          await db.query(
            "SELECT seq FROM events WHERE session_id=$1 AND event_id=$2",
            [sid, revisionOf],
          )
        ).rows[0];
        if (
          older &&
          (
            await db.query(
              "SELECT 1 FROM events WHERE session_id=$1 AND kind='utterance' AND seq>$2 AND event_id<>$3 AND COALESCE(metadata->>'input_turn_id',event_id::text)<>$4 LIMIT 1",
              [sid, older.seq, eid, info?.inputTurnId ?? eid],
            )
          ).rowCount
        )
          return false;
      }
      return true;
    });
    send({ type: "saved", event_ids: [eid] });
    if (result) {
      cancel("new_input");
      timing("utterance_committed", undefined, {
        input_turn_id: info?.inputTurnId ?? eid,
      });
      void generate("user_turn", {
        id: info?.inputTurnId ?? eid,
        revision: info?.revision ?? 0,
        eventId: eid,
      });
    }
  }
  async function go() {
    if (going) return;
    going = true;
    const opening = await transaction(async (db) => {
      const s = await expire(db, await state(db, true));
      requireThat(s.status !== "ended", "面试已结束", 409);
      const history = (
        await db.query(
          "SELECT 1 FROM response_runs WHERE session_id=$1 AND trigger='opening' UNION ALL SELECT 1 FROM events WHERE session_id=$1 AND kind='generated' LIMIT 1",
          [sid],
        )
      ).rowCount;
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
      return !history;
    });
    if (!sessionTest) {
      asr?.close();
      asr = new LiveASR(
        (eid, text, revisionOf, info) =>
          inputLane.run(1, () => commitText(eid, text, revisionOf, info)),
        () => {
          if (turns.canInterrupt) cancel("voice_activity");
        },
        () => void failure(),
        undefined,
        {
          ...speechConfig(runtime.asrProvider),
          ...(runtime.asrModel ? { model: runtime.asrModel } : {}),
          silenceMs: runtime.asrSilenceMs ?? 900,
        },
        (stage, elapsed, detail) => timing(stage, elapsed, detail),
      );
      await asr.open();
    }
    if (closed) return;
    send({ type: "active", version });
    lastAudioAt = Date.now();
    void generate(opening ? "opening" : "explicit_resume");
  }
  async function init(e: any) {
    requireThat(!sid && !initializing, "重复初始化");
    initializing = true;
    const ticket = await verifyTicket(e.ticket);
    requireThat(
      ticket.purpose === "relay" && typeof ticket.session_id === "string",
      "无效票据",
      401,
    );
    const nextSid = String(ticket.session_id);
    const row = await transaction(async (db) => {
      const s = await expire(
        db,
        (
          await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [
            nextSid,
          ])
        ).rows[0],
      );
      requireThat(
        !closed && ws.readyState === WebSocket.OPEN,
        "连接已关闭",
        409,
      );
      requireThat(
        s.user_id === ticket.user_id && s.status !== "ended",
        "会话不可连接",
        403,
      );
      requireThat(
        (s.runtime_config.protocol ?? 1) <= e.protocol,
        "页面版本已更新，请刷新后继续",
        409,
      );
      requireThat(
        e.takeover ||
          !s.heartbeat_at ||
          Date.now() - s.heartbeat_at.getTime() > 15000,
        "已有页面正在面试，请显式接管",
        409,
      );
      await stopActivity(db, nextSid, "takeover");
      await db.query(
        "UPDATE voice_connections SET retired_at=now() WHERE session_id=$1 AND retired_at IS NULL",
        [nextSid],
      );
      const row = (
        await db.query(
          "UPDATE sessions SET epoch=epoch+1,status='recovery',heartbeat_at=now(),version=version+1 WHERE id=$1 RETURNING *",
          [nextSid],
        )
      ).rows[0];
      requireThat(!closed, "连接已关闭", 409);
      await db.query(
        "INSERT INTO voice_connections(session_id,epoch) VALUES($1,$2)",
        [nextSid, row.epoch],
      );
      return row;
    });
    sid = nextSid;
    epoch = row.epoch;
    version = row.version;
    sessionTest = row.test_mode;
    runtime = row.runtime_config;
    if (closed || ws.readyState !== WebSocket.OPEN) {
      await cleanup();
      return;
    }
    clients.get(sid)?.close(4001, "另一页面已接管");
    clients.set(sid, ws);
    clearTimeout(initTimeout);
    send({
      type: "ready",
      testMode: sessionTest,
      protocol: runtime.protocol,
      version,
    });
  }
  function handleError(error: unknown) {
    send({
      type: "error",
      message:
        error instanceof Error && error.name === "ApiError"
          ? error.message
          : "连接处理失败，请重新连接",
    });
    if (!sid) ws.close(1008);
  }
  ws.on("message", (raw) => {
    const at = performance.now();
    ingressBudget = Math.min(
      600000,
      ingressBudget + (Date.now() - ingressAt) * 96,
    );
    ingressAt = Date.now();
    ingressBudget -= Array.isArray(raw)
      ? raw.reduce((n, b) => n + b.length, 0)
      : raw.byteLength;
    if (ingressBudget < 0) {
      ws.close(1008, "发送速率过高");
      return;
    }
    try {
      const e = clientEvent.parse(JSON.parse(raw.toString()));
      if (e.type === "init") {
        void init(e).catch(handleError);
        return;
      }
      requireThat(sid && e.epoch === epoch && !closed, "连接已失效", 409);
      if (e.type === "ping") {
        send({ type: "pong", client_ms: e.client_ms, server_ms: Date.now() });
        return;
      }
      if (e.type === "interrupt" || e.type === "voice_activity") {
        if (
          e.type === "voice_activity" ||
          !e.response_id ||
          response?.id === e.response_id
        ) {
          if (turns.canInterrupt) cancel("voice_activity");
          asr?.touch();
        }
        timing("control_dispatch", performance.now() - at);
        return;
      }
      if (e.type === "input_state") {
        if (e.monotonic_ms > lastInputState) {
          lastInputState = e.monotonic_ms;
          muted = e.muted;
          void inputLane
            .run(1, async () => {
              asr?.mute(e.muted);
            })
            .catch(handleError);
        }
        void controlLane
          .run(1, () =>
            transaction(async (db) => {
              await state(db, true);
              await append(db, sid, {
                event_id: e.event_id,
                kind: e.muted ? "input_muted" : "input_unmuted",
                epoch,
                metadata: {
                  frame_seq: e.frame_seq,
                  monotonic_ms: e.monotonic_ms,
                },
              });
            }),
          )
          .then(() => send({ type: "saved", event_ids: [e.event_id] }))
          .catch(handleError);
        return;
      }
      if (e.type === "heartbeat") {
        void controlLane
          .run(1, () =>
            pool.query(
              "UPDATE sessions SET heartbeat_at=now() WHERE id=$1 AND epoch=$2 AND status<>'ended'",
              [sid, epoch],
            ),
          )
          .catch(handleError);
        return;
      }
      if (e.type === "telemetry") {
        timing(e.stage, e.elapsed_ms, {
          response_id: e.response_id,
          frame_seq: e.frame_seq,
          clock_error_ms: e.clock_error_ms,
          clock_offset_ms: e.clock_offset_ms,
        });
        return;
      }
      if (e.type === "played") {
        const ch = sent.get(e.chunk_id);
        if (ch) {
          requireThat(ch.response_id === e.response_id, "回复编号无效");
          if (runtime.protocol === 2) validateReceipt(ch, e.receipt);
          if (e.played_ms >= ch.duration_ms) outstanding.delete(ch.id);
        }
        void controlLane
          .run(1, () =>
            transaction(async (db) => {
              const s = await state(db, true);
              return savePlayback(db, s, e);
            }),
          )
          .then(async (ch) => {
            sent.delete(ch.id);
            send({
              type: "playback_saved",
              chunk_id: ch.id,
              played_ms: ch.played_ms,
            });
            if (response) await complete(response);
          })
          .catch(handleError);
        return;
      }
      if (e.type === "go") {
        void inputLane.run(1, go).catch(handleError);
        return;
      }
      if (e.type === "text") {
        requireThat(sessionTest, "真实模式通过语音输入");
        void inputLane
          .run(1, () => commitText(e.event_id, e.text))
          .catch(handleError);
        return;
      }
      if (e.type === "audio") {
        const receivedAt = performance.now();
        const sampled = e.frame_seq !== undefined && e.frame_seq % 5 === 0;
        if (sampled)
          timing("relay_receive", undefined, { frame_seq: e.frame_seq });
        const pcm = decodeAudio(e),
          wasMuted = muted;
        void inputLane
          .run(1, async () => {
            if (sampled)
              timing("input_queue", performance.now() - receivedAt, {
                frame_seq: e.frame_seq,
              });
            const s = await state();
            requireThat(s.status === "active", "会话已暂停", 409);
            const elapsed = Date.now() - s.started_at.getTime();
            requireThat(
              e.start_ms <= elapsed + 1000 &&
                (e.replay || e.start_ms >= elapsed - 10000),
              "音频采集时间无效",
            );
            if (!e.replay) {
              requireThat(!wasMuted, "静音期间不能上传录音");
              const saved = !received.has(e.chunk_no)
                ? (
                    await pool.query(
                      "SELECT * FROM chunks WHERE session_id=$1 AND track='user' AND chunk_no=$2",
                      [sid, e.chunk_no],
                    )
                  ).rows[0]
                : null;
              if (saved) validateAudioRetry(saved, e, audioChecksum(pcm));
              else if (!received.has(e.chunk_no)) {
                if (e.frame_seq !== undefined) {
                  requireThat(e.frame_seq > lastFrame, "音频顺序冲突", 409);
                  if (lastFrame >= 0 && e.frame_seq !== lastFrame + 1)
                    timing("input_gap", undefined, { frame_seq: e.frame_seq });
                  lastFrame = e.frame_seq;
                }
                received.set(e.chunk_no, e.pcm);
                if (received.size > 60)
                  received.delete(received.keys().next().value!);
                asr?.send(pcm, {
                  chunkNo: e.chunk_no,
                  startMs: e.start_ms,
                  durationMs: e.duration_ms,
                });
                lastAudioAt = Date.now();
              } else
                requireThat(
                  received.get(e.chunk_no) === e.pcm,
                  "音频编号冲突",
                  409,
                );
            }
            void storageLane
              .run(e.duration_ms, () =>
                saveUserAudio(sid, e, async (db) => {
                  const current = await state(db, true);
                  requireThat(current.status !== "ended", "面试已结束", 409);
                  return current;
                }),
              )
              .then(() => {
                if (sampled)
                  timing("user_audio_durable", performance.now() - receivedAt, {
                    frame_seq: e.frame_seq,
                  });
                send({ type: "audio_saved", chunk_no: e.chunk_no });
              })
              .catch((error) => {
                if ((error as any)?.status === 409) return;
                handleError(error);
                void failure("音频暂未保存，已暂停采音；请点击继续补传。");
              });
          })
          .catch(handleError);
      }
    } catch (error) {
      handleError(error);
    }
  });
  let monitoring = false;
  const monitor = setInterval(async () => {
    if (!sid || closed || monitoring) return;
    monitoring = true;
    try {
      const s = (await pool.query("SELECT * FROM sessions WHERE id=$1", [sid]))
        .rows[0];
      if (s.deadline_at.getTime() <= Date.now() || s.status === "ended") {
        cancel("ended");
        await transaction((db) =>
          endSession(db, sid, s.end_reason ?? "timeout"),
        );
        send({ type: "ended" });
        ws.close();
        return;
      }
      if (s.epoch !== epoch) {
        cancel("takeover");
        ws.close(4001, "连接已更新");
        return;
      }
      if (s.version !== version && s.status !== "active") {
        version = s.version;
        cancel("paused");
        going = false;
        asr?.close();
        asr = null;
        send({ type: "paused", status: s.status });
      }
      if (s.heartbeat_at && Date.now() - s.heartbeat_at.getTime() > 15000)
        ws.close(4000, "连接超时");
      if (
        going &&
        !sessionTest &&
        !muted &&
        Date.now() - lastAudioAt > 5000 &&
        Date.now() - lastWarning > 5000
      ) {
        lastWarning = Date.now();
        timing("input_starved");
        await failure("未收到麦克风音频，请检查设备后点击继续。");
      }
    } catch {
      ws.close(1011);
    } finally {
      monitoring = false;
    }
  }, 1000);
  async function cleanup() {
    if (!sid) return;
    await transaction(async (db) => {
      const s = (
        await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [sid])
      ).rows[0];
      await db.query(
        "UPDATE voice_connections SET retired_at=COALESCE(retired_at,now()) WHERE session_id=$1 AND epoch=$2",
        [sid, epoch],
      );
      if (s?.epoch === epoch && s.status !== "ended") {
        await stopActivity(db, sid, "disconnect");
        await db.query(
          "UPDATE sessions SET status='recovery',heartbeat_at=NULL,version=version+1 WHERE id=$1",
          [sid],
        );
      }
    });
  }
  ws.on("close", () => {
    closed = true;
    cancel("disconnect");
    asr?.close();
    clearTimeout(initTimeout);
    clearInterval(monitor);
    if (clients.get(sid) === ws) clients.delete(sid);
    void cleanup().catch(() => {});
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

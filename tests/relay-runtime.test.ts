import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { pool } from "../server/db";
import { signTicket } from "../server/auth";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as any).port;
}
const fake = createServer(async (req, res) => {
  for await (const _ of req) {
  }
  if (req.url?.includes("/audio/speech")) {
    res.end(Buffer.alloc(38400));
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({ choices: [{ delta: { content: "谢谢分享。" } }] }) +
      "\n\ndata: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    name: "complete_interview",
                    arguments: '{"reason":"fixture"}',
                  },
                },
              ],
            },
          },
        ],
      }) +
      "\n\ndata:[DONE]\n\n",
  );
});
const fakeSpeech = new WebSocketServer({ noServer: true });
fake.on("upgrade", (req, socket, head) =>
  fakeSpeech.handleUpgrade(req, socket, head, (ws) =>
    fakeSpeech.emit("connection", ws, req),
  ),
);
const org = "relay-runtime-" + randomUUID(),
  uid = randomUUID();
let child: ReturnType<typeof spawn>, port: number, providerPort: number;
let crashOutput = "";
const ready = (async () => {
  providerPort = await listen(fake);
  const reservation = createServer();
  port = await listen(reservation);
  await new Promise<void>((r) => reservation.close(() => r()));
  await pool.query("INSERT INTO organizations VALUES($1,$1)", [org]);
  await pool.query("INSERT INTO entries VALUES($1,$1,$1,true)", [org]);
  await pool.query(
    "INSERT INTO users VALUES($1::uuid,$1::text,'runtime fixture')",
    [uid],
  );
  child = spawn(process.execPath, ["--import", "tsx", "server/relay.ts"], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      APP_URL: `http://127.0.0.1:${port}`,
      DEV_TEST_MODE: "true",
      TEST_ACCESS_USERNAME: "",
      TEST_ACCESS_PASSWORD_HASH: "",
      INTERVIEW_API_KEY: "fixture",
      LLM_API_KEY: "fixture",
      ASR_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "fixture",
      DEEPGRAM_WS_URL: `ws://127.0.0.1:${providerPort}`,
      TTS_PROVIDER: "openai",
      TTS_API_KEY: "fixture",
      TTS_BASE_URL: `http://127.0.0.1:${providerPort}`,
      TTS_MODEL: "fixture",
      TTS_VOICE: "fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (b) => (crashOutput += b.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) return;
    } catch {}
    await sleep(25);
  }
  throw new Error("Relay fixture did not start");
})();
after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((r) => child.once("exit", () => r()));
  }
  for (const ws of fakeSpeech.clients) ws.terminate();
  await new Promise<void>((r) => fake.close(() => r()));
  await pool.end();
});
const owners = new Map<string, string>();
async function session(simulate = true) {
  const id = randomUUID(),
    uid = randomUUID();
  owners.set(id, uid);
  await pool.query("INSERT INTO users VALUES($1::uuid,$1::text,'fixture')", [
    uid,
  ]);
  await pool.query(
    `INSERT INTO sessions(id,user_id,entry_id,status,started_at,deadline_at,test_mode,runtime_config) VALUES($1,$2,$3,'recovery',now(),now()+interval '1 hour',$4,$5)`,
    [
      id,
      uid,
      org,
      simulate,
      JSON.stringify({
        protocol: 2,
        audioPipeline: true,
        conversationView: true,
        contextBudget: true,
        promptVersion: "interview-2026-09-v2",
        model: {
          model: "fixture",
          base: `http://127.0.0.1:${providerPort}`,
          contextWindow: 32768,
          maxInput: 24000,
          outputReserve: 800,
          safetyMargin: 2048,
        },
      }),
    ],
  );
  return id;
}
async function connection(sid: string, takeover = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    }),
    events: any[] = [];
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise<void>((r) => ws.once("open", () => r()));
  const send = (data: any) => ws.send(JSON.stringify(data));
  send({
    type: "init",
    ticket: await signTicket({
      purpose: "relay",
      session_id: sid,
      user_id: owners.get(sid),
    }),
    takeover,
    protocol: 2,
  });
  const wait = async (type: string, predicate = (e: any) => true) => {
    for (let i = 0; i < 250; i++) {
      const at = events.findIndex((e) => e.type === type && predicate(e));
      if (at >= 0) return events.splice(at, 1)[0];
      if (child.exitCode !== null)
        throw new Error("Relay crashed: " + crashOutput);
      await sleep(20);
    }
    throw new Error("No " + type + "; events: " + JSON.stringify(events));
  };
  return { ws, events, send, wait };
}
test("closed initialization cannot take over a newer connection after waiting for the database lock", async () => {
  await ready;
  const sid = await session(),
    db = await pool.connect();
  await db.query("BEGIN");
  await db.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [sid]);
  const stale = await connection(sid);
  await sleep(60);
  stale.ws.close();
  await new Promise<void>((r) => stale.ws.once("close", () => r()));
  const current = await connection(sid);
  await db.query("COMMIT");
  db.release();
  const readyEvent = await current.wait("ready");
  assert.equal(readyEvent.epoch, 1);
  assert.equal(current.ws.readyState, WebSocket.OPEN);
  current.ws.close();
});
test("cancellation while playback waits for a row lock prevents natural ending and Relay survives HTTP-style invalidation", async () => {
  await ready;
  const sid = await session(false),
    c = await connection(sid),
    e = await c.wait("ready");
  c.send({ type: "go", epoch: e.epoch });
  await c.wait("active");
  const r = await c.wait("thinking");
  await c.wait("generation_done");
  const packets = c.events.filter((e) => e.type === "audio");
  assert(packets.length >= 3);
  const db = await pool.connect();
  await db.query("BEGIN");
  await db.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [sid]);
  for (const p of packets)
    c.send({
      type: "played",
      epoch: e.epoch,
      response_id: p.response_id,
      chunk_id: p.chunk_id,
      played_ms: p.duration_ms,
      receipt: p.receipt,
    });
  c.send({ type: "interrupt", epoch: e.epoch, response_id: r.response_id });
  await c.wait("cancel");
  await db.query("COMMIT");
  db.release();
  await c.wait("playback_saved");
  await sleep(120);
  assert.equal(
    (await pool.query("SELECT status FROM sessions WHERE id=$1", [sid])).rows[0]
      .status,
    "active",
  );
  await pool.query(
    "UPDATE sessions SET status='ended',ended_at=now(),epoch=epoch+1 WHERE id=$1",
    [sid],
  );
  await c.wait("ended");
  assert.equal(child.exitCode, null, crashOutput);
  c.ws.close();
});
test("completed reply ignores old interruption and never regenerates after five seconds without a new answer", async () => {
  await ready;
  const sid = await session(),
    c = await connection(sid),
    e = await c.wait("ready");
  c.send({ type: "go", epoch: e.epoch });
  await c.wait("active");
  const r = await c.wait("thinking");
  const ticker = setInterval(() => {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.send({ type: "heartbeat", epoch: e.epoch });
      for (const p of c.events.filter((e) => e.type === "audio")) {
        c.events.splice(c.events.indexOf(p), 1);
        c.send({
          type: "played",
          epoch: e.epoch,
          response_id: p.response_id,
          chunk_id: p.chunk_id,
          played_ms: p.duration_ms,
          receipt: p.receipt,
        });
      }
    }
  }, 30);
  try {
    await c.wait("generation_done");
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query("SELECT state FROM response_runs WHERE id=$1", [
            r.response_id,
          ])
        ).rows[0]?.state === "completed"
      )
        break;
      await sleep(30);
    }
    assert.equal(
      (
        await pool.query("SELECT state FROM response_runs WHERE id=$1", [
          r.response_id,
        ])
      ).rows[0].state,
      "completed",
    );
    c.send({ type: "interrupt", epoch: e.epoch, response_id: r.response_id });
    await sleep(5200);
    assert(!c.events.some((e) => e.type === "thinking" || e.type === "cancel"));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM response_runs WHERE session_id=$1",
          [sid],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    clearInterval(ticker);
    c.ws.close();
  }
});

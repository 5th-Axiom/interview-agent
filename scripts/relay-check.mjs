import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
const base = "http://localhost:3100";
let cookie = "";
async function api(path, body, admin = false) {
  const r = await fetch(`${base}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Interview-Client": admin ? "admin" : "candidate",
      Cookie: cookie,
      Origin: base,
    },
    body: body
      ? JSON.stringify({ ...body, request_id: randomUUID() })
      : undefined,
  });
  const data = await r.json();
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  assert(r.ok, JSON.stringify({ path, status: r.status, data }));
  return data;
}
const phone = `transport-${Date.now()}`;
await api("auth/code", { phone });
await api("auth/login", { phone, code: "123456" });
const b = await api("bootstrap?entry=demo");
const session = await api("sessions/start", {
  entry: "demo",
  role_id: b.roles[0].id,
});
function connection() {
  const ws = new WebSocket("ws://localhost:3101", {
    headers: { Origin: base },
  });
  const events = [];
  ws.on("message", (d) => events.push(JSON.parse(d)));
  return {
    ws,
    events,
    async wait(type, predicate = () => true) {
      const limit = Date.now() + 10000;
      while (Date.now() < limit) {
        const i = events.findIndex((e) => e.type === type && predicate(e));
        if (i >= 0) return events.splice(i, 1)[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting ${type}: ${JSON.stringify(events)}`);
    },
    send(data) {
      ws.send(JSON.stringify(data));
    },
  };
}
const invalid = connection();
await new Promise((r) => invalid.ws.once("open", r));
invalid.send({ type: "init", ticket: "forged" });
await invalid.wait("error");
invalid.ws.close();
const a = connection();
await new Promise((r) => a.ws.once("open", r));
a.send({
  type: "init",
  ticket: (await api(`sessions/${session.id}/ticket`, {})).ticket,
});
const { epoch } = await a.wait("ready");
a.send({ type: "go", epoch });
await a.wait("active");
const first = await a.wait("thinking");
a.send({ type: "interrupt", epoch, response_id: first.response_id });
await a.wait("cancel");
const eid = randomUUID();
a.send({
  type: "text",
  epoch,
  event_id: eid,
  text: "我负责了一个中文 mixed English 项目。",
});
await a.wait("saved");
// Reproduce VAD arriving in the 350ms between transcript persistence and reply
// start. With no additional transcript, the server must resume after silence.
a.send({ type: "interrupt", epoch });
a.send({
  type: "text",
  epoch,
  event_id: eid,
  text: "我负责了一个中文 mixed English 项目。",
});
await a.wait("saved");
const response = await a.wait("thinking");
assert.notEqual(response.response_id, first.response_id);
const audio = await a.wait(
  "audio",
  (e) => e.response_id === response.response_id,
);
assert(
  !a.events.some(
    (e) => e.type === "audio" && e.response_id === first.response_id,
  ),
);
a.send({
  type: "played",
  epoch,
  response_id: audio.response_id,
  chunk_id: audio.chunk_id,
  played_ms: audio.duration_ms,
  started_ms: 1000,
});
const chunk = randomUUID();
const packet = {
  type: "audio",
  epoch,
  chunk_no: chunk,
  pcm: Buffer.alloc(6400).toString("base64"),
  duration_ms: 200,
  start_ms: 500,
};
a.send(packet);
await a.wait("audio_saved");
a.send(packet);
await a.wait("audio_saved");
const snap = await api(`sessions/${session.id}`);
assert.equal(snap.events.filter((e) => e.event_id === eid).length, 1);
assert.equal(snap.events.filter((e) => e.kind === "utterance").length, 1);
const takeover = connection();
await new Promise((r) => takeover.ws.once("open", r));
takeover.send({
  type: "init",
  ticket: (await api(`sessions/${session.id}/ticket`, {})).ticket,
});
const rejected = await takeover.wait("error");
assert(rejected.message.includes("已有页面"));
takeover.ws.close();
const next = connection();
await new Promise((r) => next.ws.once("open", r));
next.send({
  type: "init",
  ticket: (await api(`sessions/${session.id}/ticket`, {})).ticket,
  takeover: true,
});
const ready = await next.wait("ready");
assert(ready.epoch > epoch);
next.send({ type: "go", epoch: ready.epoch });
await next.wait("active");
next.send({
  type: "text",
  epoch,
  event_id: randomUUID(),
  text: "旧连接不得保存",
});
await next.wait("error");
await api(`sessions/${session.id}/control`, { action: "end" });
await next.wait("ended");
a.ws.close();
next.ws.close();
console.log(
  JSON.stringify({
    result: "PASS",
    checks: [
      "forged ticket",
      "barge-in stale audio",
      "VAD during scheduled reply recovers after silence",
      "duplicate save receipt",
      "durable audio retry",
      "explicit takeover",
      "old epoch rejection",
      "end",
    ],
    session: session.id,
  }),
);
await api("auth/admin", { password: "local-recruiter" });
let playback;
for (let i = 0; i < 15; i++) {
  const record = await api(`sessions/${session.id}`, undefined, true);
  if (record.recording?.object_key) {
    playback = await api(`sessions/${session.id}/recording`, {}, true);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
assert(playback);
const ranged = await fetch(`${base}${playback.url}`, {
  headers: { Cookie: cookie, Range: "bytes=0-99" },
});
assert.equal(ranged.status, 206);
assert.equal((await ranged.arrayBuffer()).byteLength, 100);
assert(ranged.headers.get("content-range")?.startsWith("bytes 0-99/"));
const denied = await fetch(`${base}${playback.url}`, {
  headers: { Range: "bytes=0-99" },
});
assert.equal(denied.status, 401);
console.log("Private recording authorization and byte-range seek: PASS");

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { LiveASR } from "../server/asr";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("live ASR de-duplicates finals, preserves revisions and drains old connection on rotation", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const sockets: WebSocket[] = [];
  server.on("connection", (s) => {
    sockets.push(s);
    s.on("message", (data) => {
      if (data.toString().includes("CloseStream")) s.close();
    });
  });
  const utterances: { id: string; text: string; revisionOf?: string }[] = [];
  let failures = 0;
  const asr = new LiveASR(
    (id, text, revisionOf) => utterances.push({ id, text, revisionOf }),
    () => {},
    () => failures++,
    `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  asr.open();
  while (!sockets.length) await delay(10);
  const packet = (s: WebSocket, start: number, text: string) =>
    s.send(
      JSON.stringify({
        type: "Results",
        start,
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: text }] },
      }),
    );
  try {
    packet(sockets[0], 0, "React 中文项目");
    packet(sockets[0], 0, "React 中文项目");
    await delay(1450);
    assert.equal(utterances.length, 1);
    packet(sockets[0], 0, "React 与 TypeScript 中文项目");
    await delay(30);
    assert.equal(utterances.length, 2);
    assert.equal(utterances[1].revisionOf, utterances[0].id);
    packet(sockets[0], 3, "还有一段长回答");
    await delay(20);
    asr.rotate();
    while (sockets.length < 2) await delay(10);
    packet(sockets[1], 0, "包含 English 术语");
    await delay(1450);
    assert.equal(utterances.at(-1)?.text, "还有一段长回答 包含 English 术语");
    assert.equal(failures, 0);
  } finally {
    asr.close();
    for (const s of sockets) s.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("DashScope buffers until task-started and preserves Chinese/English final revisions", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  let received = 0,
    taskId = "";
  let socket: WebSocket | undefined;
  server.on("connection", (s) => {
    socket = s;
    s.on("message", (raw, binary) => {
      if (binary) {
        received++;
        return;
      }
      const m = JSON.parse(raw.toString());
      if (m.header.action === "run-task") {
        taskId = m.header.task_id;
        setTimeout(
          () =>
            s.send(
              JSON.stringify({
                header: { event: "task-started", task_id: taskId },
              }),
            ),
          100,
        );
      }
      if (m.header.action === "finish-task") {
        s.send(
          JSON.stringify({
            header: { event: "task-finished", task_id: taskId },
          }),
        );
        s.close();
      }
    });
  });
  const events: { id: string; text: string; revisionOf?: string }[] = [];
  let failures = 0;
  const asr = new LiveASR(
    (id, text, revisionOf) => events.push({ id, text, revisionOf }),
    () => {},
    () => failures++,
    undefined,
    {
      provider: "dashscope",
      endpoint: `ws://127.0.0.1:${(server.address() as any).port}`,
      key: "fixture",
      model: "test",
    },
  );
  try {
    const opening = asr.open();
    asr.send(Buffer.alloc(6400));
    await delay(40);
    assert.equal(received, 0);
    await opening;
    await delay(30);
    assert.equal(received, 1);
    const emit = (id: number, text: string) =>
      socket!.send(
        JSON.stringify({
          header: { task_id: taskId, event: "result-generated" },
          payload: {
            output: { sentence: { sentence_id: id, text, sentence_end: true } },
          },
        }),
      );
    emit(1, "第一段 React");
    emit(2, "第二段中文");
    await delay(1450);
    assert.equal(events[0].text, "第一段 React 第二段中文");
    emit(2, "纠正后的 TypeScript");
    await delay(30);
    assert.equal(events[1].text, "第一段 React 纠正后的 TypeScript");
    assert.equal(events[1].revisionOf, events[0].id);
    assert.equal(failures, 0);
  } finally {
    asr.close();
    socket?.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("activity reschedules a pending final, retired activity cannot interrupt, and KeepAlive errors stay contained", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const sockets: WebSocket[] = [];
  server.on("connection", (s) => sockets.push(s));
  const committed: string[] = [];
  let activity = 0,
    errors = 0;
  const asr = new LiveASR(
    (_id, text) => {
      committed.push(text);
    },
    () => activity++,
    () => errors++,
    `ws://127.0.0.1:${(server.address() as any).port}`,
  );
  try {
    await asr.open();
    while (!sockets.length) await delay(10);
    sockets[0].send(
      JSON.stringify({
        type: "Results",
        start: 0,
        is_final: true,
        channel: { alternatives: [{ transcript: "等待保存的回答" }] },
      }),
    );
    await delay(50);
    sockets[0].send(JSON.stringify({ type: "SpeechStarted" }));
    await delay(1000);
    assert.deepEqual(committed, ["等待保存的回答"]);
    asr.rotate();
    while (sockets.length < 2) await delay(10);
    const before = activity;
    sockets[0].send(JSON.stringify({ type: "SpeechStarted" }));
    await delay(30);
    assert.equal(activity, before);
    (asr as any).current.keepalive = () => {
      throw new Error("buffer full");
    };
    (asr as any).audioAt = 0;
    await delay(4100);
    assert(errors >= 1);
  } finally {
    asr.close();
    for (const s of sockets) s.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("ASR save retries retain the exact event identity after an unknown outcome", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  let socket: WebSocket | undefined;
  server.on("connection", (s) => (socket = s));
  const attempts: any[] = [];
  let failures = 0;
  const asr = new LiveASR(
    (id, text, revisionOf, info) => {
      attempts.push({ id, text, revisionOf, info });
      if (attempts.length === 1) throw new Error("unknown commit outcome");
    },
    () => {},
    () => failures++,
    `ws://127.0.0.1:${(server.address() as any).port}`,
  );
  try {
    await asr.open();
    while (!socket) await delay(10);
    socket.send(
      JSON.stringify({
        type: "Results",
        start: 0,
        is_final: true,
        channel: { alternatives: [{ transcript: "只保存一遍" }] },
      }),
    );
    await delay(1350);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(failures, 1);
  } finally {
    asr.close();
    socket?.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("unchanged final text still upgrades provisional evidence and records actual audio coverage once", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  let socket: WebSocket | undefined;
  server.on("connection", (s) => (socket = s));
  const saved: any[] = [];
  const asr = new LiveASR(
    (id, text, revisionOf, info) => {
      saved.push({ id, text, revisionOf, info });
    },
    () => {},
    () => assert.fail("ASR error"),
    `ws://127.0.0.1:${(server.address() as any).port}`,
  );
  const emit = (final: boolean) =>
    socket!.send(
      JSON.stringify({
        type: "Results",
        start: 0,
        ...(final ? { duration: 0.2 } : {}),
        is_final: final,
        channel: { alternatives: [{ transcript: "我用了缓存" }] },
      }),
    );
  async function waitFor(count: number) {
    for (let i = 0; i < 100; i++) {
      if (saved.length >= count) return;
      await delay(20);
    }
    assert.fail("No transcript commit");
  }
  try {
    await asr.open();
    while (!socket) await delay(10);
    asr.send(Buffer.alloc(6400), {
      chunkNo: "fixture-audio",
      startMs: 0,
      durationMs: 200,
    });
    emit(false);
    await waitFor(1);
    emit(true);
    await waitFor(2);
    assert.equal(saved[0].info.provisional, true);
    assert.deepEqual(saved[0].info.chunkNos, []);
    assert.equal(saved[1].info.provisional, false);
    assert.deepEqual(saved[1].info.chunkNos, ["fixture-audio"]);
    assert.equal(saved[1].revisionOf, saved[0].id);
    assert.equal(saved[1].info.inputTurnId, saved[0].info.inputTurnId);
    emit(true);
    await delay(100);
    assert.equal(saved.length, 2);
  } finally {
    asr.close();
    socket?.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

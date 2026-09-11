import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { pool } from "../server/db";
after(() => pool.end());
test("twelve slow SMS deliveries leave database capacity available and a failed delivery can retry immediately", async () => {
  const before = {
    ALLOW_TEST_OTP: process.env.ALLOW_TEST_OTP,
    SMS_URL: process.env.SMS_URL,
    SMS_TOKEN: process.env.SMS_TOKEN,
  };
  const responses: ServerResponse[] = [];
  const server = createServer((req, res) => {
    req.resume();
    responses.push(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ALLOW_TEST_OTP = "false";
  process.env.SMS_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SMS_TOKEN = "fixture";
  const { sendCode } = await import("../server/auth");
  let pending: Promise<unknown> | undefined;
  try {
    pending = Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sendCode("1990000" + String(i).padStart(4, "0")),
      ),
    );
    void pending.catch(() => {});
    for (let i = 0; i < 200 && responses.length < 12; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(responses.length, 12);
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SMS holds database pool")), 500),
      ),
    ]);
    assert(pool.idleCount > 0);
    for (const res of responses) res.writeHead(200).end();
    await pending;
    const failure = sendCode("19900009999");
    void failure.catch(() => {});
    while (responses.length < 13) await new Promise((r) => setTimeout(r, 10));
    responses[12].writeHead(503).end();
    await assert.rejects(failure);
    const retry = sendCode("19900009999");
    void retry.catch(() => {});
    while (responses.length < 14) await new Promise((r) => setTimeout(r, 10));
    responses[13].writeHead(200).end();
    await retry;
  } finally {
    for (const res of responses)
      if (!res.writableEnded) res.writeHead(503).end();
    await pending?.catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
let cookie = "";
async function api(path, body) {
  const r = await fetch("http://localhost:3100/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body:
      body === undefined
        ? undefined
        : JSON.stringify({ ...body, request_id: randomUUID() }),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const value = await r.json();
  assert.equal(r.status, 200, value.error);
  return value;
}
assert.equal((await api("config")).testMode, false);
const phone = "selection-live-" + Date.now();
await api("auth/code", { phone });
await api("auth/login", { phone, code: "123456" });
const source = (await fs.readFile(".local/provider-sample.wav")).subarray(44),
  pcm = Buffer.alloc(Math.floor(source.length / 3) * 2);
for (let i = 0; i < pcm.length / 2; i++)
  pcm.writeInt16LE(source.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
const result = await api("selection", {
  entry: "demo",
  pcm: pcm.toString("base64"),
});
const roles = (await api("bootstrap?entry=demo")).roles;
assert.equal(roles.find((r) => r.id === result.role_id)?.name, "前端工程师");
console.log(
  JSON.stringify({
    result: "PASS",
    checks: ["real voice ASR", "explicit tool-based role selection"],
    role: "前端工程师",
  }),
);

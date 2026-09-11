import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = process.env.TEST_BASE_URL || "http://localhost:3100";
const source = await fs.readFile(".local/provider-sample.wav");
const pcm = Buffer.concat([source.subarray(44), Buffer.alloc(24000 * 2 * 4)]);
const file = Buffer.concat([source.subarray(0, 44), pcm]);
file.writeUInt32LE(file.length - 8, 4);
file.writeUInt32LE(pcm.length, 40);
await fs.writeFile(".local/browser-live-input.wav", file);
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${process.cwd()}/.local/browser-live-input.wav`,
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ["microphone"],
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function api(path, body, admin = false) {
  return page.evaluate(
    async ({ path, body, admin }) => {
      const r = await fetch("/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Interview-Client": admin ? "admin" : "candidate",
        },
        body:
          body === undefined
            ? undefined
            : JSON.stringify({ request_id: crypto.randomUUID(), ...body }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error);
      return v;
    },
    { path, body, admin },
  );
}
try {
  await page.goto(base + "/interview/login");
  const config = await api("config");
  assert.equal(config.testMode, false);
  assert.equal(config.otp, true);
  const phone = `live-browser-${Date.now()}`;
  await page.getByLabel("手机号", { exact: true }).fill(phone);
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByLabel("短信验证码").fill("123456");
  await page.getByRole("button", { name: "登录并继续" }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.getByRole("heading", { name: "你想面试哪个岗位？" }).waitFor();
  await page
    .getByRole("button", { name: /前端工程师/ })
    .first()
    .click();
  await page.waitForURL(/\/interview\/session\//);
  const sid = new URL(page.url()).pathname.split("/").at(-1);
  await page.getByRole("button", { name: "显示字幕" }).click();
  let detail;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    detail = await api(`sessions/${sid}`);
    if (
      detail.events.some((e) => e.kind === "utterance") &&
      detail.events.some((e) => e.kind === "generated")
    )
      break;
  }
  assert(
    detail.events.some(
      (e) => e.kind === "utterance" && /前端|React|项目/.test(e.text),
    ),
    "real ASR utterance",
  );
  assert(
    detail.events.some((e) => e.kind === "generated"),
    "real LLM reply",
  );
  await page.getByRole("button", { name: "静音", exact: true }).click();
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    detail = await api(`sessions/${sid}`);
    if (detail.events.some((e) => e.kind === "playback")) break;
  }
  assert(
    detail.events.some((e) => e.kind === "playback"),
    "browser playback receipt",
  );
  await page.screenshot({
    path: ".local/screenshots/live-h5.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "结束面试", exact: true }).click();
  await page.getByRole("button", { name: "确认结束", exact: true }).click();
  await page
    .getByRole("heading", { name: "本次面试已结束", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await api("auth/admin", { password: "local-recruiter" }, true);
  for (let i = 0; i < 60; i++) {
    detail = await api(`sessions/${sid}`, undefined, true);
    if (
      detail.assessments[0]?.status === "ready" &&
      detail.recording?.object_key
    )
      break;
    await page.waitForTimeout(1000);
  }
  assert.equal(detail.assessments[0]?.status, "ready");
  assert.equal(detail.assessments[0]?.result?.testMode, false);
  assert(detail.recording?.object_key);
  const timingStages = new Set((detail.telemetry ?? []).map((t) => t.stage));
  for (const stage of [
    "asr_send",
    "asr_final",
    "utterance_committed",
    "llm_request",
    "llm_first_delta",
    "speakable_text",
    "tts_request",
    "tts_first_pcm",
    "first_audio_durable",
    "first_audio_sent",
    "play_start",
    "play_end",
  ])
    assert(timingStages.has(stage), `Missing timing stage: ${stage}`);
  await page.goto(base + `/admin/interviews/${sid}`);
  await page.getByRole("button", { name: "加载录音", exact: true }).click();
  await page.locator("audio").first().waitFor();
  await page.screenshot({
    path: ".local/screenshots/live-record-h5.png",
    fullPage: true,
  });
  assert.equal(errors.length, 0, errors.join(";"));
  const report = {
    result: "PASS",
    sid,
    mode: "real suppliers, synthetic browser microphone",
    utterances: detail.events.filter((e) => e.kind === "utterance").length,
    playbackReceipts: detail.events.filter((e) => e.kind === "playback").length,
    assessment: detail.assessments[0].status,
    recording: detail.recording.status,
    timingStages: [...timingStages],
    errors,
  };
  await fs.writeFile(
    ".local/live-result.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({
    path: ".local/screenshots/live-failure.png",
    fullPage: true,
  });
  console.error(error.message);
  console.error((await page.locator("body").innerText()).slice(0, 3000));
  process.exitCode = 1;
} finally {
  await browser.close();
}

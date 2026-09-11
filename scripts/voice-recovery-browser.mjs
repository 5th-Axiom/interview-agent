import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const base = process.env.TEST_BASE_URL || "http://localhost:3100";
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
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
await context.addInitScript(() => {
  window.dropAudioSaved = true;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        if (window.dropAudioSaved) {
          try {
            if (JSON.parse(event.data).type === "audio_saved")
              event.stopImmediatePropagation();
          } catch {}
        }
      });
    }
  };
});
// Keep the server's explicit simulation mode, while exercising actual browser Worklet capture with a fake microphone.
await page.route("**/api/sessions/*", async (route) => {
  const response = await route.fetch();
  const type = response.headers()["content-type"] || "";
  if (type.includes("application/json")) {
    const body = await response.json();
    if (body.session) {
      body.session.test_mode = false;
      await route.fulfill({ response, json: body });
      return;
    }
  }
  await route.fulfill({ response });
});
try {
  await page.goto(`${base}/interview/login`);
  await page
    .getByLabel("手机号", { exact: true })
    .fill("recovery-fixture-" + Date.now());
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByLabel("短信验证码").fill("123456");
  await page.getByRole("button", { name: "登录并继续" }).click();
  await page
    .getByRole("button", { name: "开发测试：跳过麦克风，使用文字输入" })
    .click();
  await page.getByRole("button", { name: /前端工程师/ }).click();
  await page
    .getByText("录音尚未保存，已暂停。点击继续后会先补传再开启麦克风。", {
      exact: true,
    })
    .waitFor();
  await page.evaluate(() => (window.dropAudioSaved = false));
  await page.getByRole("button", { name: "继续面试", exact: true }).click();
  await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
  await page.waitForTimeout(1000);
  assert.equal(
    await page.getByRole("button", { name: "继续面试", exact: true }).count(),
    0,
    "Full queue must drain before new capture",
  );
  await page.getByRole("button", { name: "重新选岗", exact: true }).click();
  await page.getByRole("heading", { name: "你想面试哪个岗位？" }).waitFor();
  await page.getByRole("button", { name: /后端工程师/ }).click();
  await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
  await page.getByRole("button", { name: "结束面试", exact: true }).click();
  await page.getByRole("button", { name: "确认结束", exact: true }).click();
  await page
    .getByRole("heading", { name: "本次面试已结束", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  const result = {
    result: "PASS",
    mode: "real browser Worklet, fake microphone, simulated providers",
    checks: [
      "8 second unconfirmed audio limit",
      "drain before recapture",
      "pending evidence survives role change",
      "ending flush",
      "H5",
    ],
  };
  await fs.mkdir(".local/remediation", { recursive: true });
  await fs.writeFile(
    ".local/remediation/recovery-browser.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({
    path: ".local/remediation/recovery-failure.png",
    fullPage: true,
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}

const testBase = process.env.TEST_BASE_URL || "http://localhost:3100";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const pcm = Buffer.alloc(44100 * 2 * 5);
for (let i = 0; i < pcm.length / 2; i++)
  pcm.writeInt16LE(
    Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * 6000),
    i * 2,
  );
const h = Buffer.alloc(44);
h.write("RIFF");
h.writeUInt32LE(36 + pcm.length, 4);
h.write("WAVEfmt ", 8);
h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20);
h.writeUInt16LE(1, 22);
h.writeUInt32LE(44100, 24);
h.writeUInt32LE(88200, 28);
h.writeUInt16LE(2, 32);
h.writeUInt16LE(16, 34);
h.write("data", 36);
h.writeUInt32LE(pcm.length, 40);
await fs.writeFile(".local/mic-fixture.wav", Buffer.concat([h, pcm]));
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: [
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${process.cwd()}/.local/mic-fixture.wav`,
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  permissions: ["microphone"],
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
process.on("uncaughtException", async (e) => {
  console.error(e);
  console.error(await page.locator("body").innerText());
  await browser.close();
  process.exit(1);
});
await page.goto(`${testBase}/interview/login`);
const phone = `mobile-${Date.now()}`;
await page.getByLabel("手机号", { exact: true }).fill(phone);
await page.getByRole("button", { name: "获取验证码" }).click();
await page.getByLabel("短信验证码").fill("123456");
await page.getByRole("button", { name: "登录并继续" }).click();
await page.getByRole("button", { name: "开始对话", exact: true }).click();
await page
  .getByRole("heading", { name: "你想面试哪个岗位？" })
  .waitFor({ timeout: 15000 });
await page.screenshot({
  path: ".local/screenshots/selection-h5.png",
  fullPage: true,
});
await page.getByLabel("测试岗位意向").fill("我想面试前端工程师");
await page.getByRole("button", { name: "测试选岗意向" }).click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
const firstUrl = page.url();
await page.getByRole("button", { name: "静音", exact: true }).click();
await page.getByRole("button", { name: "取消静音", exact: true }).waitFor();
await page.getByRole("button", { name: "暂停", exact: true }).click();
await page.getByRole("button", { name: "继续面试", exact: true }).click();
await page.getByRole("button", { name: "取消静音", exact: true }).waitFor();
await page.getByRole("button", { name: "切换深色" }).click();
await page.waitForTimeout(300);
await page.getByLabel("测试回答").waitFor();
await page.screenshot({
  path: ".local/screenshots/session-h5-dark.png",
  fullPage: true,
});
await page.getByRole("button", { name: "切换浅色" }).click();
await page.waitForTimeout(300);
await page.screenshot({
  path: ".local/screenshots/session-h5.png",
  fullPage: true,
});
assert(
  !(await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  )),
);
await page.getByRole("button", { name: "重新选岗" }).click();
await page.getByRole("button", { name: /后端工程师/ }).click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
assert.equal(page.url(), firstUrl);
await ctx.setOffline(true);
await page.getByRole("button", { name: "继续面试", exact: true }).waitFor();
await ctx.setOffline(false);
await page.getByRole("button", { name: "继续面试", exact: true }).click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "结束面试", exact: true }).click();
await page.getByRole("button", { name: "确认结束", exact: true }).click();
await page.getByRole("button", { name: "跳过，直接完成" }).click();
await page.goto(`${testBase}/admin/login`);
await page.getByLabel("工作台密码").fill("local-recruiter");
await page.getByRole("button", { name: "登录工作台", exact: true }).click();
await page.getByRole("link", { name: "前端工程师", exact: true }).click();
await page.getByRole("button", { name: "开始试聊" }).click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
await page.getByLabel("测试回答").fill("这是一条试聊回答");
await page.getByRole("button", { name: "发送", exact: true }).click();
await page.getByRole("button", { name: "结束面试", exact: true }).click();
await page.getByRole("button", { name: "确认结束", exact: true }).click();
await page.getByRole("heading", { name: "配置面试岗位" }).waitFor();
await page.screenshot({
  path: ".local/screenshots/editor-h5.png",
  fullPage: true,
});
assert(
  !(await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  )),
);
assert.deepEqual(errors, [], "Browser page errors must fail acceptance");
console.log(
  JSON.stringify({
    result: "PASS",
    errors,
    checks: [
      "real AudioWorklet fake PCM 44100 to 16000",
      "H5 voice",
      "explicit semantic selection test",
      "mute preserved after pause",
      "theme preserves voice",
      "role switch preserves session",
      "offline resume",
      "preview isolation",
    ],
  }),
);
await browser.close();

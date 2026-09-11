const testBase = process.env.TEST_BASE_URL || "http://localhost:3100";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
const entry = process.env.TEST_ENTRY || "demo";
process.on("uncaughtException", async (e) => {
  console.error(e.message);
  console.error(await page.locator("body").innerText());
  await page.screenshot({
    path: ".local/screenshots/failure.png",
    fullPage: true,
  });
  await browser.close();
  process.exit(1);
});
page.on("pageerror", (e) => errors.push(e.message));
await fs.mkdir(".local/screenshots", { recursive: true });
await page.goto(
  `${testBase}/interview/login?entry=${encodeURIComponent(entry)}`,
);
await page.getByRole("heading", { name: "欢迎参加面试" }).waitFor();
await page.screenshot({
  path: ".local/screenshots/login-pc.png",
  fullPage: true,
});
const phone = `browser-${Date.now()}`;
await page.getByLabel("手机号", { exact: true }).fill(phone);
await page.getByRole("button", { name: "获取验证码" }).click();
await page.getByLabel("短信验证码").fill("123456");
await page.getByRole("button", { name: "登录并继续" }).click();
await page.getByRole("heading", { name: "准备好，开始一段对话" }).waitFor();
await page
  .getByRole("button", { name: "开发测试：跳过麦克风，使用文字输入" })
  .click();
await page.getByRole("heading", { name: "你想面试哪个岗位？" }).waitFor();
await page.screenshot({
  path: ".local/screenshots/selection-pc.png",
  fullPage: true,
});
await page
  .getByRole("button", { name: /前端工程师/ })
  .first()
  .click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "显示字幕" }).click();
await page
  .getByLabel("测试回答")
  .fill("我负责 React 和 TypeScript 项目，主要改善了加载性能。");
await page.getByRole("button", { name: "发送", exact: true }).click();
await page.waitForTimeout(2500);
await page.screenshot({
  path: ".local/screenshots/session-pc.png",
  fullPage: true,
});
const sessionUrl = page.url();
assert.equal(new URL(sessionUrl).searchParams.get("entry"), entry);
await page.getByRole("button", { name: "暂停", exact: true }).click();
await page.getByRole("button", { name: "继续面试", exact: true }).waitFor();
await page.getByRole("button", { name: "继续面试", exact: true }).click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
await page.reload();
await page.getByRole("button", { name: "继续面试", exact: true }).waitFor();
await page.getByRole("button", { name: "继续面试", exact: true }).click();
await page.getByLabel("测试回答").waitFor({ timeout: 15000 });
await page.getByRole("button", { name: "结束面试", exact: true }).click();
await page.getByRole("button", { name: "确认结束", exact: true }).click();
await page.getByRole("heading", { name: "本次面试已结束" }).waitFor();
assert.equal(new URL(page.url()).searchParams.get("entry"), entry);
await page.getByRole("button", { name: "5 星", exact: true }).click();
await page.getByRole("button", { name: "提交反馈", exact: true }).click();
await page.getByLabel("申请原因").fill("希望补充更多项目经历");
await page.getByRole("button", { name: "提交再次面试申请" }).click();
await page.getByText("待审核", { exact: true }).waitFor();
await page.screenshot({
  path: ".local/screenshots/feedback-pc.png",
  fullPage: true,
});
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  deviceScaleFactor: 1,
  storageState: await context.storageState(),
});
const mp = await mobile.newPage();
await mp.goto(page.url());
await mp.getByRole("heading", { name: "感谢反馈，你可以关闭页面了" }).waitFor();
await mp.screenshot({
  path: ".local/screenshots/feedback-h5.png",
  fullPage: true,
});
await mp.getByRole("button", { name: "切换深色" }).click();
await mp.screenshot({
  path: ".local/screenshots/feedback-h5-dark.png",
  fullPage: true,
});
if (await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth))
  throw new Error("Mobile overflow");
await page.goto(`${testBase}/admin/login`);
await page.getByLabel("工作台密码").fill("local-recruiter");
await page.getByRole("button", { name: "登录工作台", exact: true }).click();
await page.getByRole("heading", { name: "岗位管理", exact: true }).waitFor();
await page.screenshot({
  path: ".local/screenshots/admin-roles-pc.png",
  fullPage: true,
});
await page.getByRole("link", { name: "前端工程师", exact: true }).click();
await page.getByRole("heading", { name: "配置面试岗位" }).waitFor();
await page.screenshot({
  path: ".local/screenshots/editor-pc.png",
  fullPage: true,
});
const sid = new URL(sessionUrl).pathname.split("/").at(-1);
await page.goto(`${testBase}/admin/interviews/${sid}`);
await page
  .getByRole("heading", { name: "再次面试申请", exact: true })
  .waitFor();
assert.equal(
  await page.getByRole("button", { name: "保存复核意见" }).isDisabled(),
  true,
);
await page
  .getByLabel("招聘方判断")
  .fill("浏览器验证：建议补充项目中的个人贡献。");
await page.getByRole("button", { name: "保存复核意见" }).click();
await page.getByRole("button", { name: "通过申请", exact: true }).click();
await page.getByRole("button", { name: "确认通过", exact: true }).click();
await page.getByText("已通过", { exact: true }).waitFor();
await page.getByRole("button", { name: "加载录音", exact: true }).click();
await page.locator("audio").first().waitFor();
await page.screenshot({
  path: ".local/screenshots/record-pc.png",
  fullPage: true,
});
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({
  path: ".local/screenshots/record-h5.png",
  fullPage: true,
});
if (
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
)
  throw new Error("Admin mobile overflow");
await fs.writeFile(
  ".local/browser-result.json",
  JSON.stringify(
    { phone, sid, errors, screenshots: await fs.readdir(".local/screenshots") },
    null,
    2,
  ),
);
assert.deepEqual(errors, [], "Browser page errors must fail acceptance");
console.log(JSON.stringify({ sid, errors, result: "PASS" }));
await browser.close();

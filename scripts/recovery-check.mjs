import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const failRequest = (route) =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "验收模拟：服务暂时不可用，请重试。" }),
  });
try {
  await page.goto("http://localhost:3100/admin/login");
  await page.getByLabel("工作台密码").fill("local-recruiter");
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("heading", { name: "岗位管理", exact: true }).waitFor();
  await page.route("**/api/roles", failRequest);
  await page.reload();
  await page
    .getByRole("button", { name: "重试加载岗位", exact: true })
    .waitFor();
  await page.unroute("**/api/roles", failRequest);
  await page.getByRole("button", { name: "重试加载岗位", exact: true }).click();
  await page.getByRole("link", { name: "前端工程师", exact: true }).waitFor();
  checks.push("Failed role loading retries successfully");
  await page.goto(
    "http://localhost:3100/admin/roles/00000000-0000-4000-8000-000000000000",
  );
  await page
    .getByText("没有找到该岗位，请返回列表选择。", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "发布岗位", exact: true }).count(),
    0,
  );
  checks.push(
    "Missing role cannot accidentally create or publish a blank editor",
  );

  const { sid } = JSON.parse(
    await fs.readFile(".local/live-result.json", "utf8"),
  );
  await page.goto(`http://localhost:3100/admin/interviews/${sid}`);
  const review = page.getByLabel("招聘方判断");
  await review.fill("验收未保存意见：在返回后恢复这段输入");
  await page.getByRole("link", { name: "返回面试记录", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(review).toHaveValue("验收未保存意见：在返回后恢复这段输入");
  await page.goBack();
  await page
    .getByText("没有找到该岗位，请返回列表选择。", { exact: true })
    .waitFor();
  await page.goForward();
  await expect(review).toHaveValue("验收未保存意见：在返回后恢复这段输入");
  await review.fill("");
  checks.push(
    "Navigation warning preserves review; browser Back/Forward restores the draft",
  );

  const prompt = page.getByLabel("本次评估要求");
  const original = await prompt.inputValue();
  await prompt.fill("验收失败输入：只使用原始对话证据");
  await page.route("**/api/sessions/*/assessment-prompt", failRequest);
  await page.getByRole("button", { name: "保存评估要求", exact: true }).click();
  await page
    .getByText("验收模拟：服务暂时不可用，请重试。", { exact: true })
    .waitFor();
  await expect(prompt).toHaveValue("验收失败输入：只使用原始对话证据");
  await page.waitForTimeout(4500);
  await expect(prompt).toHaveValue("验收失败输入：只使用原始对话证据");
  await page.unroute("**/api/sessions/*/assessment-prompt", failRequest);
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await expect(prompt).toHaveValue(original);
  checks.push(
    "Failed assessment save and background refresh retain edits; cancel restores saved version",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://localhost:3100/interview/login");
  const identity = `recovery-${Date.now()}`;
  await page.getByLabel("手机号", { exact: true }).fill(identity);
  await page.getByRole("button", { name: "获取验证码", exact: true }).click();
  await page.getByLabel("短信验证码").fill("000000");
  await page.getByRole("button", { name: "登录并继续", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await expect(page.getByLabel("手机号", { exact: true })).toHaveValue(
    identity,
  );
  await page.getByLabel("短信验证码").fill("123456");
  await page.getByRole("button", { name: "登录并继续", exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).waitFor();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Synthetic permission denial", "NotAllowedError");
    };
  });
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page
    .getByText("无法开启麦克风，请在浏览器权限中允许访问后重试。", {
      exact: true,
    })
    .waitFor();
  await expect(
    page.getByRole("button", { name: "重新测试", exact: true }),
  ).toBeEnabled();
  await page.goto(
    "http://localhost:3100/interview/session/00000000-0000-4000-8000-000000000000",
  );
  await page
    .getByRole("heading", { name: "无法读取这场面试", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "开始对话", exact: true }).count(),
    0,
  );
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
  );
  checks.push(
    "Wrong OTP preserves phone; denied microphone offers retry; invalid session shows recoverable error on H5",
  );
  assert.deepEqual(errors, []);
  const report = {
    result: "PASS",
    mode: "Chrome UI with explicit HTTP/permission failure injection",
    checks,
    errors,
  };
  await fs.writeFile(
    ".local/recovery-result.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  console.error((await page.locator("body").innerText()).slice(0, 3500));
  await page.screenshot({
    path: ".local/screenshots/recovery-failure.png",
    fullPage: true,
  });
  process.exitCode = 1;
} finally {
  await browser.close();
}

const testBase = process.env.TEST_BASE_URL || "http://localhost:3100";
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
  await page.goto(`${testBase}/admin/login`);
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
    `${testBase}/admin/roles/00000000-0000-4000-8000-000000000000`,
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

  // A fresh fixture in the selected environment; never reuse an unrelated DB's session.
  const sid = await page.evaluate(async () => {
    async function api(path, body) {
      const response = await fetch("/api/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: crypto.randomUUID(), ...body }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    }
    const phone = "recovery-record-" + Date.now();
    await api("auth/code", { phone });
    await api("auth/login", { phone, code: "123456" });
    const boot = await fetch("/api/bootstrap?entry=demo").then((r) => r.json());
    const session = await api("sessions/start", {
      entry: "demo",
      role_id: boot.roles[0].id,
    });
    await api(`sessions/${session.id}/control`, {
      action: "end",
      expected_version: session.version,
      expected_epoch: session.epoch,
    });
    return session.id;
  });
  await page.goto(`${testBase}/admin/interviews/${sid}`);
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

  for (const item of [
    { path: "review", field: review, button: "保存复核意见" },
    { path: "assessment-prompt", field: prompt, button: "保存评估要求" },
  ]) {
    const pattern = `**/api/sessions/${sid}/${item.path}`;
    let release;
    const held = new Promise((r) => (release = r));
    let entered;
    const received = new Promise((r) => (entered = r));
    const handler = async (route) => {
      entered();
      await held;
      await route.continue();
    };
    await page.route(pattern, handler);
    await item.field.fill("已提交的版本");
    await page.getByRole("button", { name: item.button, exact: true }).click();
    await received;
    await item.field.fill("保存中继续输入的新版本");
    release();
    await expect(
      page.getByRole("button", { name: item.button, exact: true }),
    ).toBeEnabled();
    await page.waitForTimeout(4200);
    await expect(item.field).toHaveValue("保存中继续输入的新版本");
    await page.unroute(pattern, handler);
    if (item.path === "review") await review.fill("");
    else
      await page.getByRole("button", { name: "取消修改", exact: true }).click();
  }
  checks.push(
    "Typing during review and assessment saves survives the response and background refresh",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${testBase}/interview/login`);
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
    `${testBase}/interview/session/00000000-0000-4000-8000-000000000000`,
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

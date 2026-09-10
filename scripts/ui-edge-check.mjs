import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
page.setDefaultTimeout(15000);
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
  await page.goto("http://localhost:3100/interview/login");
  const phone = "ui-edge-" + Date.now();
  await api("auth/code", { phone });
  await api("auth/login", { phone, code: "123456" });
  const boot = await api("bootstrap?entry=demo");
  const session = await api("sessions/start", {
    entry: "demo",
    role_id: boot.roles[0].id,
  });
  await api(`sessions/${session.id}/control`, { action: "end" });
  await page.goto(
    `http://localhost:3100/interview/session/${session.id}/feedback`,
  );
  const submit = page.getByRole("button", { name: "提交反馈", exact: true });
  assert(await submit.isDisabled());
  await page.getByLabel("补充说明（选填）").fill("中".repeat(501));
  assert(await submit.isDisabled());
  await page.getByText(/501 \/ 500/).waitFor();
  await page.getByLabel("补充说明（选填）").fill("修改后保留的体验建议");
  await page.getByRole("button", { name: "4 星", exact: true }).click();
  assert(!(await submit.isDisabled()));
  await page.getByRole("button", { name: "录制语音说明" }).click();
  await page.getByRole("button", { name: "取消录音", exact: true }).click();
  await page.getByRole("button", { name: "录制语音说明" }).waitFor();
  await page.screenshot({
    path: ".local/screenshots/feedback-form-h5.png",
    fullPage: true,
  });
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
  );
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await page.getByRole("button", { name: "继续填写", exact: true }).click();
  assert.equal(
    await page.getByLabel("补充说明（选填）").inputValue(),
    "修改后保留的体验建议",
  );
  await page.getByRole("button", { name: "切换深色" }).click();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: ".local/screenshots/feedback-form-h5-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await page.getByRole("button", { name: "放弃并跳过", exact: true }).click();
  await page
    .getByRole("heading", { name: "本次面试已结束，你可以关闭页面了" })
    .waitFor();
  assert.equal((await api(`sessions/${session.id}`)).feedback.text, "");
  await api("auth/admin", { password: "local-recruiter" }, true);
  const result = JSON.parse(
    await fs.readFile(".local/live-result.json", "utf8"),
  );
  await page.goto(`http://localhost:3100/admin/interviews/${result.sid}`);
  const field = page.getByLabel("本次评估要求");
  await field.waitFor();
  const original = await field.inputValue();
  await field.fill("不应保存的修改");
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  assert.equal(await field.inputValue(), original);
  const before = (await api(`sessions/${result.sid}`, undefined, true)).session
    .assessment_version;
  await page.getByRole("button", { name: "重新生成评估", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    (await api(`sessions/${result.sid}`, undefined, true)).session
      .assessment_version,
    before,
  );
  assert(
    await page
      .locator('a[href^="#event-"]')
      .evaluateAll((links) =>
        links.every((a) =>
          document.getElementById(a.getAttribute("href").slice(1)),
        ),
      ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".local/screenshots/assessment-controls-pc.png",
    fullPage: true,
  });
  assert.equal(errors.length, 0, errors.join(";"));
  console.log(
    JSON.stringify({
      result: "PASS",
      checks: [
        "500 char UI limit",
        "stars",
        "cancel microphone",
        "skip confirmation retains input",
        "skip discards submitted content",
        "assessment cancel",
        "regenerate confirmation cancel",
        "all evidence links resolve",
        "H5 overflow",
      ],
      errors,
    }),
  );
} catch (error) {
  console.error(error.message);
  await page.screenshot({
    path: ".local/screenshots/ui-edge-failure.png",
    fullPage: true,
  });
  process.exitCode = 1;
} finally {
  await browser.close();
}

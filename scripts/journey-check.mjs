import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

// Business mutations happen through the UI. Read-only API checks verify that
// the visible success states correspond to durable records.
const base = process.env.TEST_BASE_URL || "http://localhost:3100";
const stamp = Date.now();
const name = `验收岗位 ${stamp}`;
const phone = `journey-${stamp}`;
await fs.mkdir(".local/screenshots", { recursive: true });
const source = await fs.readFile(".local/provider-sample.wav");
const pcm = Buffer.concat([source.subarray(44), Buffer.alloc(24000 * 2 * 4)]);
const microphone = Buffer.concat([source.subarray(0, 44), pcm]);
microphone.writeUInt32LE(microphone.length - 8, 4);
microphone.writeUInt32LE(pcm.length, 40);
await fs.writeFile(".local/browser-live-input.wav", microphone);
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${process.cwd()}/.local/browser-live-input.wav`,
  ],
});
const recruiter = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["microphone", "clipboard-read", "clipboard-write"],
});
const candidate = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  permissions: ["microphone"],
});
const admin = await recruiter.newPage();
const person = await candidate.newPage();
const errors = [],
  issues = [],
  checks = [];
let sid, rid, retrySid;
for (const page of [admin, person]) {
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
}
const mark = (value) => {
  checks.push(value);
  console.log(value);
};
async function read(page, path, isAdmin = false) {
  return page.evaluate(
    async ({ path, isAdmin }) => {
      const response = await fetch(`/api/${path}`, {
        headers: { "X-Interview-Client": isAdmin ? "admin" : "candidate" },
      });
      if (!response.ok) throw new Error(`Read failed: ${response.status}`);
      return response.json();
    },
    { path, isAdmin },
  );
}
async function screenshot(page, label) {
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
    `${label}: horizontal overflow`,
  );
  await page.screenshot({
    path: `.local/screenshots/journey-${label}.png`,
    fullPage: true,
  });
}
async function optionalConfirmation(page, name, issue) {
  if (await page.getByRole("dialog").isVisible()) {
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: true })
      .click();
  } else issues.push(issue);
}
try {
  await admin.goto(`${base}/admin/roles`);
  await admin.getByLabel("工作台密码").fill("local-recruiter");
  await admin.getByRole("button", { name: "登录工作台", exact: true }).click();
  assert.equal(
    (await read(admin, "config")).testMode,
    false,
    "Start dev:all in real supplier mode before this journey",
  );
  await admin.getByRole("link", { name: "新建岗位", exact: true }).click();
  await admin.getByLabel("岗位名称 *", { exact: true }).fill(name);
  await admin
    .getByLabel("岗位简介（选填）")
    .fill("浏览器验收专用，验证草稿与发布隔离。");
  await admin.getByRole("button", { name: "使用示例", exact: true }).click();
  await admin.getByRole("button", { name: "保存草稿", exact: true }).click();
  await admin.waitForURL(/\/admin\/roles\/[0-9a-f-]+$/);
  rid = new URL(admin.url()).pathname.split("/").at(-1);
  await admin.getByRole("button", { name: "开始试聊", exact: true }).click();
  await expect(
    admin
      .getByRole("dialog")
      .getByRole("button", { name: "静音", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await admin
    .getByRole("dialog")
    .getByRole("button", { name: "静音", exact: true })
    .click();
  await screenshot(admin, "preview-pc");
  await admin.getByRole("button", { name: "结束面试", exact: true }).click();
  await admin.getByRole("button", { name: "确认结束", exact: true }).click();
  await expect(admin.getByRole("dialog"))
    .toHaveCount(0)
    .catch(async () => {
      await expect(admin.locator("dialog[open]")).toHaveCount(0);
    });
  await admin.getByRole("button", { name: "发布岗位", exact: true }).click();
  await admin
    .getByText("已发布，新面试将使用本次版本。", { exact: true })
    .waitFor();
  await admin
    .getByRole("button", { name: "返回岗位列表", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "复制面试链接", exact: true })
    .click();
  const link = await admin.evaluate(() => navigator.clipboard.readText());
  assert.equal(link, `${base}/interview?entry=demo`);
  mark("Recruiter login, new draft, real preview, publish, copy invitation");

  await person.goto(link);
  await person.getByLabel("手机号", { exact: true }).fill(phone);
  await person.getByRole("button", { name: "获取验证码", exact: true }).click();
  await person.getByLabel("短信验证码").fill("123456");
  await person.getByRole("button", { name: "登录并继续", exact: true }).click();
  await person.getByRole("button", { name: "开始对话", exact: true }).click();
  await person.getByRole("button", { name: new RegExp(name) }).click();
  await person.waitForURL(/\/interview\/session\/[0-9a-f-]+(?:\?[^#]*)?$/);
  sid = new URL(person.url()).pathname.split("/").at(-1);
  await expect
    .poll(
      async () =>
        (await read(person, `sessions/${sid}`)).events.some(
          (e) => e.kind === "utterance",
        ),
      { timeout: 60000 },
    )
    .toBeTruthy();
  await person.getByRole("button", { name: "静音", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read(person, `sessions/${sid}`)).events.some(
          (e) => e.kind === "playback",
        ),
      { timeout: 60000 },
    )
    .toBeTruthy();
  const before = (await read(person, `sessions/${sid}`)).session;
  await person.getByRole("button", { name: "显示字幕", exact: true }).click();
  await person.getByRole("button", { name: "暂停", exact: true }).click();
  await person.getByRole("button", { name: "继续面试", exact: true }).click();
  await expect(
    person.getByRole("button", { name: "取消静音", exact: true }),
  ).toBeEnabled();
  await person.reload();
  await person.getByRole("button", { name: "继续面试", exact: true }).click();
  await expect(
    person.getByRole("button", { name: "静音", exact: true }),
  ).toBeEnabled();
  await person.getByRole("button", { name: "静音", exact: true }).click();
  assert.equal(
    (await read(person, `sessions/${sid}`)).session.deadline_at,
    before.deadline_at,
  );
  await screenshot(person, "interview-h5");
  await person.getByRole("button", { name: "结束面试", exact: true }).click();
  await person.getByRole("button", { name: "继续交流", exact: true }).click();
  await expect(
    person.getByRole("button", { name: "取消静音", exact: true }),
  ).toBeEnabled();
  await person.getByRole("button", { name: "结束面试", exact: true }).click();
  await person.getByRole("button", { name: "确认结束", exact: true }).click();
  await person
    .getByRole("heading", { name: "本次面试已结束", exact: true })
    .waitFor();
  mark(
    "H5 candidate login, microphone check, live speech/playback, pause, refresh/resume, end confirmation",
  );

  await person.getByRole("button", { name: "4 星", exact: true }).click();
  await person.getByRole("button", { name: "声音卡顿", exact: true }).click();
  await person
    .getByLabel("补充说明（选填）")
    .fill("浏览器验收反馈：以下语音只用于体验反馈。");
  await person
    .getByRole("button", { name: "录制语音说明", exact: true })
    .click();
  await person.waitForTimeout(7000);
  await person.getByRole("button", { name: "停止并转写", exact: true }).click();
  await person
    .getByText("转写完成，可修改后提交。", { exact: true })
    .waitFor({ timeout: 30000 });
  const feedbackText = await person.getByLabel("补充说明（选填）").inputValue();
  assert(feedbackText.length > 35);
  await screenshot(person, "feedback-h5");
  await person.getByRole("button", { name: "提交反馈", exact: true }).click();
  await person
    .getByRole("heading", { name: "感谢反馈，你可以关闭页面了", exact: true })
    .waitFor();
  await person
    .getByLabel("申请原因（选填）")
    .fill("验收申请：希望再次说明项目贡献。");
  await person
    .getByRole("button", { name: "提交再次面试申请", exact: true })
    .click();
  await person.getByText("待审核", { exact: true }).waitFor();
  assert.equal(
    (await read(person, `sessions/${sid}`)).feedback.text,
    feedbackText,
  );
  mark("Real feedback transcription, submit, persist, retry request");

  await admin
    .getByRole("navigation", { name: "招聘管理" })
    .getByRole("link", { name: "面试记录", exact: true })
    .click();
  await admin.getByLabel("候选人手机号", { exact: true }).fill(phone);
  await admin.getByLabel("筛选岗位", { exact: true }).selectOption(rid);
  await admin.getByLabel("面试状态", { exact: true }).selectOption("manual");
  await admin.getByRole("button", { name: "查找", exact: true }).click();
  await expect(admin.locator("tbody tr")).toHaveCount(1);
  await admin.getByRole("link", { name: "查看记录", exact: true }).click();
  await admin.getByRole("link", { name: "返回面试记录", exact: true }).click();
  await admin.getByLabel("候选人手机号", { exact: true }).waitFor();
  if (
    (await admin.getByLabel("候选人手机号", { exact: true }).inputValue()) !==
      phone ||
    (await admin.getByLabel("筛选岗位").inputValue()) !== rid
  )
    issues.push("Returning from a record loses filters");
  await admin.goto(`${base}/admin/interviews/${sid}`);
  await expect(
    admin.getByRole("button", { name: "加载录音", exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await admin.getByRole("button", { name: "加载录音", exact: true }).click();
  const audio = admin.locator("audio").first();
  await expect
    .poll(() => audio.evaluate((e) => e.readyState), { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);
  await audio.evaluate(async (e) => {
    await e.play();
  });
  await expect
    .poll(() => audio.evaluate((e) => e.currentTime))
    .toBeGreaterThan(0);
  await audio.evaluate((e) => e.pause());
  await expect(
    admin.getByRole("button", { name: "重新生成评估", exact: true }),
  ).toBeEnabled({ timeout: 90000 });
  await admin
    .getByLabel("招聘方判断")
    .fill("验收：人工意见应在重新生成后保留。");
  await admin
    .getByRole("button", { name: "保存复核意见", exact: true })
    .click();
  await admin.getByText("人工复核意见已独立保存。", { exact: true }).waitFor();
  await admin
    .getByLabel("本次评估要求")
    .fill(
      "仅依据原始候选人回答，分析个人贡献和技术取舍。没有证据就说明证据不足，引用原始事件。不要把体验反馈纳入评估。",
    );
  await admin
    .getByRole("button", { name: "保存评估要求", exact: true })
    .click();
  await admin
    .getByText("本次评估要求已保存，尚未重新生成。", { exact: true })
    .waitFor();
  const firstVersion = (await read(admin, `sessions/${sid}`, true)).session
    .assessment_version;
  await admin
    .getByRole("button", { name: "重新生成评估", exact: true })
    .click();
  await admin
    .getByRole("button", { name: "确认重新生成", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await read(admin, `sessions/${sid}`, true)).assessments[0].status,
      { timeout: 90000 },
    )
    .toBe("ready");
  const detail = await read(admin, `sessions/${sid}`, true);
  assert.equal(detail.assessments[0].version, firstVersion + 1);
  assert.equal(detail.reviews.length, 1);
  assert(!detail.events.some((e) => e.text.includes("浏览器验收反馈")));
  await screenshot(admin, "record-pc");
  mark(
    "Console filters, recording actually plays, prompt save, real assessment regeneration, human review isolation",
  );

  await admin
    .getByLabel("审核说明（拒绝时必填）")
    .fill("验收拒绝说明：请补充设备问题。");
  await admin.getByRole("button", { name: "拒绝申请", exact: true }).click();
  await optionalConfirmation(
    admin,
    "确认拒绝",
    "Retry rejection has no confirmation",
  );
  await person.getByText("未通过", { exact: true }).waitFor();
  await person.getByText(/验收拒绝说明/).waitFor();
  await person
    .getByLabel("申请原因（选填）")
    .fill("验收补充：之前设备输入不稳定。");
  await person
    .getByRole("button", { name: "提交再次面试申请", exact: true })
    .click();
  await admin.getByRole("button", { name: "通过申请", exact: true }).waitFor();
  await admin.getByRole("button", { name: "通过申请", exact: true }).click();
  await optionalConfirmation(
    admin,
    "确认通过",
    "Retry approval has no confirmation",
  );
  await person
    .getByRole("button", { name: "进入新一轮面试", exact: true })
    .click();
  await person.getByRole("button", { name: "开始对话", exact: true }).click();
  await person.getByRole("button", { name: new RegExp(name) }).click();
  await person.waitForURL(/\/interview\/session\/[0-9a-f-]+(?:\?[^#]*)?$/);
  retrySid = new URL(person.url()).pathname.split("/").at(-1);
  assert.notEqual(retrySid, sid);
  await expect(
    person.getByRole("button", { name: "静音", exact: true }),
  ).toBeEnabled();
  await person.getByRole("button", { name: "结束面试", exact: true }).click();
  await person.getByRole("button", { name: "确认结束", exact: true }).click();
  await person
    .getByRole("button", { name: "跳过，直接完成", exact: true })
    .click();
  assert.equal(
    (await read(admin, `sessions/${sid}`, true)).retries[0].used_by,
    retrySid,
  );
  mark(
    "Retry rejection explanation, reapply, approve, single qualification consumed by new session",
  );

  await admin.getByLabel("招聘方判断").fill("不应无提示丢失的未保存意见");
  await admin.getByRole("link", { name: "返回面试记录", exact: true }).click();
  if (await admin.getByRole("dialog").isVisible()) {
    await admin.getByRole("button", { name: "继续编辑", exact: true }).click();
    assert.equal(
      await admin.getByLabel("招聘方判断").inputValue(),
      "不应无提示丢失的未保存意见",
    );
    await admin
      .getByRole("link", { name: "返回面试记录", exact: true })
      .click();
    await admin.getByRole("button", { name: "放弃修改", exact: true }).click();
  } else
    issues.push("Unsaved human review is lost on navigation without warning");
  await admin.goto(`${base}/admin/roles/${rid}`);
  await admin.getByLabel("岗位简介（选填）").fill("尚未发布的新简介");
  await admin.getByRole("button", { name: "保存草稿", exact: true }).click();
  await admin.getByText("草稿已保存。", { exact: true }).waitFor();
  assert.notEqual(
    (await read(person, "bootstrap?entry=demo")).roles.find((r) => r.id === rid)
      .description,
    "尚未发布的新简介",
  );
  await admin
    .getByRole("button", { name: "返回岗位列表", exact: true })
    .click();
  await admin.getByLabel("搜索岗位", { exact: true }).fill(name);
  await admin.getByRole("button", { name: "停用", exact: true }).click();
  await admin.getByRole("button", { name: "确认停用", exact: true }).click();
  await admin.getByRole("cell", { name: /已停用/ }).waitFor();
  assert(
    !(await read(person, "bootstrap?entry=demo")).roles.some(
      (r) => r.id === rid,
    ),
  );
  await admin.setViewportSize({ width: 390, height: 844 });
  await screenshot(admin, "roles-h5");
  mark(
    "Draft edits stay unpublished, role disable removes candidate option, H5 console layout",
  );
  assert.equal(errors.length, 0, errors.join("; "));
  const report = {
    result: issues.length ? "ISSUES_FOUND" : "PASS",
    sid,
    rid,
    retrySid,
    checks,
    issues,
    errors,
    mode: "Real suppliers; synthetic microphone; UI business actions",
  };
  await fs.writeFile(
    ".local/journey-result.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (issues.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  for (const [label, page] of [
    ["admin", admin],
    ["candidate", person],
  ]) {
    await page.screenshot({
      path: `.local/screenshots/journey-failure-${label}.png`,
      fullPage: true,
    });
    console.error(
      label,
      (await page.locator("body").innerText()).slice(0, 4000),
    );
  }
  await fs.writeFile(
    ".local/journey-result.json",
    JSON.stringify(
      {
        result: "FAIL",
        sid,
        rid,
        retrySid,
        checks,
        issues,
        errors,
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}

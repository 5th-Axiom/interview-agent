import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
const base = process.env.TEST_BASE_URL || "http://localhost:3100";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(base + "/interview/login");
  async function api(path, body, admin = false) {
    const r = await page.request.fetch(base + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: base,
        "X-Interview-Client": admin ? "admin" : "candidate",
      },
      data:
        body === undefined ? undefined : { request_id: randomUUID(), ...body },
    });
    assert(r.ok(), path + ": " + r.status());
    return r.json();
  }
  assert.equal(
    (await api("config")).testMode,
    true,
    "Use an explicit test-mode environment",
  );
  const phone = "assessment-layout-" + Date.now();
  await api("auth/code", { phone });
  await api("auth/login", { phone, code: "123456" });
  const boot = await api("bootstrap?entry=demo");
  const s = await api("sessions/start", {
    entry: "demo",
    role_id: boot.roles[0].id,
  });
  await api(`sessions/${s.id}/control`, {
    action: "end",
    expected_version: s.version,
    expected_epoch: s.epoch,
  });
  await api("auth/admin", { password: "local-recruiter" }, true);
  const fixture = await api(`sessions/${s.id}`, undefined, true);
  const eid = randomUUID();
  fixture.events.push({
    event_id: eid,
    seq: 99,
    kind: "utterance",
    speaker: "user",
    text: "合成布局用例：我负责订单列表性能优化，并验证竞态和异常恢复。",
    metadata: {},
  });
  const old = {
    version: 1,
    status: "ready",
    prompt: "评估布局合成用例",
    result: {
      items: Array.from({ length: 50 }, () => ({
        text: "旧版长观察。".repeat(20),
        sources: [eid],
      })),
    },
  };
  const current = {
    version: 2,
    status: "ready",
    prompt: "评估布局合成用例",
    result: {
      formatVersion: 2,
      conclusion: {
        verdict: "follow_up",
        summary: "具备相关项目经验，建议补充核实实现取舍与结果验证。",
        sources: [eid],
      },
      items: Array.from({ length: 5 }, (_, i) => ({
        text: `重点 ${i + 1}：能说明个人贡献，需核实实现取舍和异常恢复。`,
        sources: [eid],
      })),
    },
  };
  fixture.assessments = [current, old];
  fixture.session.assessment_version = 2;
  await page.route(`**/api/sessions/${s.id}`, (route) =>
    route.fulfill({ json: fixture }),
  );
  await page.goto(base + `/admin/interviews/${s.id}`);
  const panel = page.locator(".assessment-panel"),
    body = page.getByRole("region", { name: "面试评估内容" }),
    regen = panel.getByRole("button", { name: "重新生成评估", exact: true });
  await expect(
    panel.getByRole("heading", { name: "建议补充面试", exact: true }),
  ).toBeVisible();
  assert.equal(await panel.boundingBox().then((b) => b.height), 520);
  await expect(panel.getByLabel("本次评估要求")).not.toBeVisible();
  await panel.getByText("查看历史评估版本", { exact: true }).click();
  const height = await panel.boundingBox().then((b) => b.height);
  assert.equal(height, 520);
  assert(await body.evaluate((e) => e.scrollHeight > e.clientHeight));
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await expect(regen).toBeVisible();
  await body.evaluate((e) => (e.scrollTop = 0));
  await panel.getByText("查看依据", { exact: true }).first().click();
  for (const href of await panel
    .locator('a[href^="#event-"]')
    .evaluateAll((a) => a.map((x) => x.hash)))
    assert(await page.locator(href).count());
  await fs.mkdir(".local/screenshots", { recursive: true });
  await panel.screenshot({
    path: ".local/screenshots/assessment-compact-pc.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toHaveCSS("height", "480px");
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )),
  );
  await page.getByRole("button", { name: "切换深色" }).click();
  await panel.screenshot({
    path: ".local/screenshots/assessment-compact-h5.png",
  });
  // Historical data remains readable inside exactly the same bounded panel.
  fixture.assessments = [old];
  fixture.session.assessment_version = 1;
  await page.reload();
  await expect(
    panel.getByText("历史版本只有观察记录，重新生成即可查看面试结论。"),
  ).toBeVisible();
  assert(await body.evaluate((e) => e.scrollHeight > e.clientHeight));
  await expect(panel).toHaveCSS("height", "480px");
  await page.unroute(`**/api/sessions/${s.id}`);
  await page.reload();
  await panel.getByText("评估设置", { exact: true }).click();
  const input = panel.getByLabel("本次评估要求");
  await input.fill("只突出个人贡献与验证结果");
  await panel
    .getByRole("button", { name: "保存评估要求", exact: true })
    .click();
  await page
    .getByText("本次评估要求已保存，尚未重新生成。", { exact: true })
    .waitFor();
  assert.equal(
    (await api(`sessions/${s.id}`, undefined, true)).session.assessment_prompt,
    "只突出个人贡献与验证结果",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      checks: [
        "PC 520px/H5 480px",
        "conclusion first",
        "five key points",
        "independent content scroll",
        "fixed regenerate control",
        "collapsed settings/history",
        "source links",
        "legacy long reports",
        "settings save",
      ],
      errors,
    }),
  );
} finally {
  await browser.close();
}

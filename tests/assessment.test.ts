import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateAssessment } from "../server/assessment";
import {
  assessmentPrompt,
  defaultAssessmentPrompt,
  legacyAssessmentPrompt,
} from "../shared/assessment";
import { estimateTokens, inputLimit } from "../server/context-budget";
import { modelProfile } from "../server/runtime-profile";
const event = (text: string, kind = "utterance") => ({
  event_id: randomUUID(),
  seq: 1,
  kind,
  speaker: kind === "utterance" ? "user" : "assistant",
  text,
  metadata: {},
});
const args = (events: any[]) => ({
  events,
  role: { name: "前端工程师", prompt: "考察个人贡献、React、测试和性能优化" },
  instructions: legacyAssessmentPrompt,
  testMode: false,
  signal: () => AbortSignal.timeout(5000),
});
function report(id: string) {
  return {
    conclusion: {
      verdict: "follow_up",
      summary: "有项目实践，建议补充核实设计取舍。",
      sources: [id],
    },
    items: [{ text: "能说明个人贡献，设计取舍尚需核实。", sources: [id] }],
  };
}
test("assessment leads with a sourced conclusion, uses role requirements and upgrades only the old default", async () => {
  const answer = event("我负责虚拟列表和性能测试。");
  let calls = 0;
  const result = await generateAssessment({
    ...args([answer]),
    callModel: async (prompt, data, _signal, purpose) => {
      calls++;
      assert.equal(purpose, "assessment");
      assert(prompt.includes(defaultAssessmentPrompt));
      assert.deepEqual((data as any).role, args([]).role);
      assert.equal((data as any).events[0].text, answer.text);
      return report(answer.event_id);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.formatVersion, 2);
  assert.equal(result.conclusion.verdict, "follow_up");
  assert.equal(result.items.length, 1);
  assert.equal(assessmentPrompt("只考察架构取舍"), "只考察架构取舍");
});
test("missing or provisional answers never become a fabricated negative decision", async () => {
  for (const events of [
    [],
    [event("你熟悉React吗？", "generated")],
    [{ ...event("助手话语不能算候选人回答"), speaker: "assistant" }],
    [{ ...event("还在识别的回答"), metadata: { provisional: true } }],
  ]) {
    const result = await generateAssessment({
      ...args(events),
      callModel: async () => {
        throw Error("must not call a model");
      },
    });
    assert.equal(result.conclusion.verdict, "insufficient");
    assert.deepEqual(result.conclusion.sources, []);
  }
});
test("unknown sources, excessive detail and AI-only support cannot pass assessment validation", async () => {
  const answer = event("我负责组件测试"),
    question = event("请介绍项目", "generated");
  const invalid = [
    report(randomUUID()),
    {
      ...report(answer.event_id),
      items: Array.from({ length: 6 }, () => report(answer.event_id).items[0]),
    },
    report(question.event_id),
    {
      ...report(answer.event_id),
      conclusion: {
        ...report(answer.event_id).conclusion,
        summary: "长".repeat(81),
      },
    },
  ];
  for (const output of invalid)
    await assert.rejects(
      generateAssessment({
        ...args([answer, question]),
        callModel: async () => output,
      }),
    );
});
test("long transcripts carry prior conclusions and original references across bounded model batches", async () => {
  const events = Array.from({ length: 55 }, (_, i) => ({
    ...event(`回答${i}：` + "我负责实际实现并验证结果。".repeat(100)),
    seq: i + 1,
  }));
  const seen = new Set<string>();
  let calls = 0;
  const result = await generateAssessment({
    ...args(events),
    callModel: async (prompt, data) => {
      const d = data as any;
      assert(
        estimateTokens(prompt) + estimateTokens(data) + 64 <=
          inputLimit(modelProfile("assessment")),
      );
      if (calls++) assert(d.previous);
      for (const e of d.events) seen.add(e.event_id);
      return {
        ...report(d.events.at(-1).event_id),
        items: [
          {
            text: "最初回答的个人贡献得到后续细节补充。",
            sources: [events[0].event_id],
          },
        ],
      };
    },
  });
  assert(calls > 1);
  assert.equal(seen.size, events.length);
  assert.equal(result.items[0].sources[0], events[0].event_id);
});

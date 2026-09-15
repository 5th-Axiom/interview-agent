import { test } from "node:test";
import assert from "node:assert/strict";
import { sameTranscriptContent } from "../server/transcript-revision";
import {
  conversationView,
  conversationPolicy,
} from "../server/conversation-view";

test("interrupted question remains next to the corrected answer without claiming full playback", () => {
  const events = [
    {
      event_id: "question",
      seq: 1,
      kind: "generated",
      text: "匹配功能具体怎么实现？",
      metadata: { tts_complete: true },
    },
    {
      event_id: "draft",
      seq: 2,
      kind: "utterance",
      text: "嗯就用Agent Loop 去实现的",
      metadata: { input_turn_id: "input", provisional: true },
    },
    {
      event_id: "final",
      seq: 3,
      kind: "utterance",
      text: "嗯，就用Agent Loop去实现的。",
      metadata: {
        input_turn_id: "input",
        revision_of: "draft",
        revision: 1,
        provisional: false,
      },
    },
    {
      event_id: "next",
      seq: 4,
      kind: "generated",
      text: "循环的停止条件是怎样设置的？",
      metadata: { tts_complete: true },
    },
  ];
  const view = conversationView(events, [
    { event_id: "question", played_ms: 3925, duration_ms: 5997 },
  ]);
  assert.deepEqual(
    view.turns.map((t) => t.event_id),
    ["question", "final", "next"],
  );
  assert.equal(view.turns[0].playback, "partial");
  assert(view.turns[0].content.includes(events[0].text));
  assert.equal(view.turns[1].follows_assistant_event_id, "question");
  assert.equal(view.turns[1].content, events[2].text);
  assert.equal(view.turns[2].playback, "unheard");
  // The earlier interrupted question remains even after another question exists.
  assert.equal(view.lastQuestion.event_id, "next");
});

test("waiting and clarification inputs stay verbatim; chronology does not label them as answers", () => {
  for (const input of [
    "等一下",
    "没听清你刚才问什么",
    "我没有用缓存",
    "我想结束面试",
  ]) {
    const view = conversationView([
      {
        event_id: "q",
        seq: 1,
        kind: "generated",
        text: "用了缓存吗？",
        metadata: {},
      },
      { event_id: "u", seq: 2, kind: "utterance", text: input, metadata: {} },
    ]);
    assert.equal(view.latestInput.content, input);
    assert.equal(view.latestInput.follows_assistant_event_id, "q");
    assert.equal(view.turns[0].playback, "unheard");
    assert.equal(view.latestInput.answered, undefined);
  }
  assert(conversationPolicy.includes("不把任何插话一律当成回答"));
});

test("formatting equivalence is conservative around negation, numbers, punctuation and word boundaries", () => {
  for (const [before, after] of [
    ["嗯就用Agent Loop 去实现的", "嗯，就用Agent Loop去实现的。"],
    ["用了缓存", "用了缓存。"],
    ["React 和 TypeScript", "React和TypeScript"],
  ])
    assert(sameTranscriptContent(before, after));
  for (const [before, after] of [
    ["用了缓存", "没用缓存"],
    ["不，使用缓存", "不使用缓存"],
    ["1.5 秒", "15 秒"],
    ["30%", "30"],
    ["用了缓存", "用了缓存？"],
    ["Agent Loop", "AgentLoop"],
    ["不能", "能"],
  ])
    assert(!sameTranscriptContent(before, after), `${before} != ${after}`);
});

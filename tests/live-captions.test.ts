import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  liveCaptionsReducer as reduce,
  type LiveCaption,
} from "../features/interview/live-captions";
import { clientEvent, serverEvent } from "../shared/contracts";

test("live captions revise the same row in place without changing speaker chronology", () => {
  const user = (text: string, revision: number, final = false) => ({
    type: "user" as const,
    update: { utterance_id: "user-1", text, revision, final },
  });
  let entries = reduce([], user("我负责订单", 0));
  entries = reduce(entries, {
    type: "play",
    eventId: "ai-1",
    responseId: "reply-1",
    text: "请继续。",
  });
  entries = reduce(entries, user("我负责订单和支付模块。", 1, true));
  assert.deepEqual(
    entries.map((e) => [e.speaker, e.text, e.status]),
    [
      ["user", "我负责订单和支付模块。", "complete"],
      ["assistant", "请继续。", "complete"],
    ],
  );
  assert.equal(reduce(entries, user("过期结果", 0)), entries);
  assert.equal(reduce(entries, user("迟到的临时结果", 2)), entries);
  assert.equal(reduce(entries, user("重复结果", 1, true)), entries);
});

test("audio chunks show a sentence once and interruption marks only that reply's last displayed sentence", () => {
  const play = {
    type: "play" as const,
    eventId: "sentence-1",
    responseId: "r1",
    text: "你是怎么定位问题的？",
  };
  let entries = reduce([], play);
  assert.equal(reduce(entries, play), entries);
  entries = reduce(entries, {
    ...play,
    eventId: "sentence-2",
    text: "当时用了什么工具？",
  });
  entries = reduce(entries, { type: "interrupt", responseId: "r1" });
  assert.deepEqual(
    entries.map((e) => e.status),
    ["complete", "interrupted"],
  );
  assert.equal(
    reduce(entries, { type: "interrupt", responseId: "unplayed" }),
    entries,
  );
});

test("suspending retains provisional words without claiming recognition completed, a final can still revise them", () => {
  const update = {
    utterance_id: "u1",
    text: "我用了缓存",
    revision: 0,
    final: false,
  };
  let entries = reduce([], { type: "user", update });
  entries = reduce(entries, { type: "suspend" });
  assert.equal(entries[0].status, "unconfirmed");
  entries = reduce(entries, {
    type: "user",
    update: { ...update, revision: 1, final: true },
  });
  assert.equal(entries[0].status, "complete");
});

test("the live window stays bounded and late revisions do not reinsert evicted speech", () => {
  let entries: LiveCaption[] = [];
  for (let n = 0; n < 201; n++)
    entries = reduce(entries, {
      type: "user",
      update: {
        utterance_id: String(n),
        text: "同样的话",
        revision: 0,
        final: true,
      },
    });
  assert.equal(entries.length, 200);
  assert.equal(entries[0].id, "1");
  assert.equal(
    reduce(entries, {
      type: "user",
      update: {
        utterance_id: "0",
        text: "迟到的纠正",
        revision: 1,
        final: true,
      },
    }),
    entries,
  );
});

test("caption delivery is opt-in for old clients and validates its identity and revision", () => {
  const init = clientEvent.parse({
    type: "init",
    ticket: "fixture",
    protocol: 2,
  });
  assert.equal(init.type, "init");
  assert(init.type === "init");
  assert.equal(init.captions, false);
  const update = {
    type: "user_caption",
    epoch: 3,
    utterance_id: randomUUID(),
    text: "中文 React 回答",
    revision: 0,
    final: false,
  };
  assert(serverEvent.safeParse(update).success);
  assert(!serverEvent.safeParse({ ...update, revision: -1 }).success);
  assert(
    !serverEvent.safeParse({ ...update, text: "x".repeat(10001) }).success,
  );
});

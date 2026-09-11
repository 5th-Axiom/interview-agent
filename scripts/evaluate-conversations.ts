import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TurnCoordinator, type ReplyTrigger } from "../server/turn-coordinator";
import { conversationView } from "../server/conversation-view";
import {
  platformPrompt,
  streamProvider,
  type ModelConfig,
} from "../server/model";
import { modelProfile } from "../server/runtime-profile";
const cases = JSON.parse(
  await readFile(
    new URL("../tests/fixtures/conversation-cases.json", import.meta.url),
    "utf8",
  ),
);
const live = process.argv.includes("--live");
const configured = modelProfile("interview");
const profiles: Record<string, ModelConfig> = {
  baseline: {
    base: configured.base,
    model: configured.model,
    key: process.env.INTERVIEW_API_KEY || process.env.LLM_API_KEY || "",
  },
};
if (live) {
  if (!process.env.EVAL_CANDIDATE_MODEL)
    throw new Error(
      "Set EVAL_CANDIDATE_MODEL for the explicitly selected comparison model",
    );
  profiles.candidate = {
    base: process.env.EVAL_CANDIDATE_BASE_URL || configured.base,
    model: process.env.EVAL_CANDIDATE_MODEL,
    key: process.env.EVAL_CANDIDATE_API_KEY || profiles.baseline.key,
  };
}
const results = [];
for (const c of cases) {
  const coordinator = new TurnCoordinator(),
    id = randomUUID(),
    input = { id, eventId: id, revision: 0 };
  const reply = coordinator.begin(
    c.trigger as ReplyTrigger,
    c.trigger === "user_turn" ? input : undefined,
  )!;
  if (!reply) throw new Error(c.id + ": trigger failed");
  if (c.duplicate && coordinator.begin("user_turn", input) !== null)
    throw new Error("duplicate response");
  if (c.revision) {
    const next = coordinator.begin("user_turn", { ...input, revision: 1 })!;
    if (coordinator.isCurrent(reply) || !next)
      throw new Error("stale revision");
  }
  if (c.noiseAfter) {
    const current = coordinator.current!;
    coordinator.transition(current, "completed");
    if (coordinator.cancel("noise"))
      throw new Error("completed response cancelled");
  }
  if (c.playback) {
    const view = conversationView(
      [
        {
          event_id: "q",
          seq: 1,
          kind: "generated",
          text: "上一个问题",
          metadata: { tts_complete: true },
        },
      ],
      [
        {
          event_id: "q",
          duration_ms: 1000,
          played_ms:
            c.playback === "heard" ? 1000 : c.playback === "partial" ? 400 : 0,
        },
      ],
    );
    if (view.lastQuestion.playback !== c.playback)
      throw new Error("wrong playback projection");
  }
  if (!live) {
    results.push({
      id: c.id,
      protocol: "pass",
      quality: "not_evaluated",
      expectation: c.expectation,
    });
    continue;
  }
  for (const [profile, config] of Object.entries(profiles)) {
    const at = performance.now();
    let first: number | undefined;
    const parts = [];
    for await (const part of streamProvider(
      [
        { role: "system", content: platformPrompt },
        {
          role: "system",
          content: `岗位：前端工程师。当前回复触发 ${c.trigger}。上一问题：请介绍最近的项目。播放状态：${c.playback ?? "heard"}。`,
        },
        { role: "user", content: c.input || "开始面试" },
      ],
      AbortSignal.timeout(45000),
      config,
    )) {
      first ??= performance.now() - at;
      parts.push(part);
    }
    results.push({
      id: c.id,
      profile,
      model: config.model,
      firstSentenceMs: first,
      totalMs: performance.now() - at,
      parts,
      expectation: c.expectation,
      humanRatings: [null, null],
    });
  }
}
await mkdir(".local/remediation", { recursive: true });
await writeFile(
  ".local/remediation/conversation-evaluation.json",
  JSON.stringify(
    {
      mode: live
        ? "real-model synthetic scenarios"
        : "deterministic protocol scenarios",
      cases: cases.length,
      results,
      qualityPassed: null,
      humanBlindReview: "pending",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    mode: live ? "real-model" : "protocol-only",
    cases: cases.length,
    protocol: "PASS",
    humanQuality: "not claimed",
  }),
);

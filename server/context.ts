import { conversationView } from "./conversation-view";
import { estimateTokens, contextPressure } from "./context-budget";
import {
  modelProfile,
  profileIdentity,
  SUMMARY_PROMPT_VERSION,
} from "./runtime-profile";
import { hash } from "./auth";
import { enqueue } from "./business";
import { pool, requireThat, transaction } from "./db";
import {
  platformPrompt,
  legacyPlatformPrompt,
  interviewTools,
  type Message,
} from "./model";

// Playback remains per chunk in the ledger. Aggregate only the model view by generated sentence.
export function contextEvents(events: any[]) {
  const result = events
    .filter((e) => e.kind !== "playback")
    .map((e) => ({ ...e }));
  const playback = new Map<
    string,
    { played_ms: number; duration_ms: number }
  >();
  for (const e of events)
    if (e.kind === "playback" && e.metadata?.event_id) {
      const key = `${e.metadata.event_id}:${e.metadata.chunk_id}`;
      const old = playback.get(key);
      if (!old || Number(e.metadata.played_ms) > old.played_ms)
        playback.set(key, {
          played_ms: Number(e.metadata.played_ms),
          duration_ms: Number(e.metadata.duration_ms),
        });
    }
  for (const e of result)
    if (e.kind === "generated") {
      const chunks = [...playback]
        .filter(([key]) => key.startsWith(`${e.event_id}:`))
        .map(([, value]) => value);
      e.metadata = {
        ...e.metadata,
        playback: chunks.length
          ? {
              confirmed_ms: chunks.reduce((n, c) => n + c.played_ms, 0),
              reported_ms: chunks.reduce((n, c) => n + c.duration_ms, 0),
              note: "仅表示有回执片段；其余合成音频是否播放未知",
            }
          : { note: "没有播放确认，不能认为候选人听过" },
      };
    }
  return result;
}
export async function buildContext(
  id: string,
  signal = AbortSignal.timeout(30000),
): Promise<Message[]> {
  signal.throwIfAborted();
  const s = (
    await pool.query(
      "SELECT s.*,v.prompt,v.name FROM sessions s LEFT JOIN role_segments rs ON rs.id=s.current_segment LEFT JOIN role_versions v ON v.id=rs.role_version_id WHERE s.id=$1",
      [id],
    )
  ).rows[0];
  requireThat(s, "会话不存在", 404);
  const snapshot = (
    await pool.query(
      "SELECT * FROM snapshots WHERE session_id=$1 AND version=$2",
      [id, s.snapshot_version],
    )
  ).rows[0];
  const events = (
    await pool.query(
      "SELECT * FROM events WHERE session_id=$1 AND seq>$2 ORDER BY seq",
      [id, snapshot?.covered_seq ?? 0],
    )
  ).rows;
  const chunks = (
    await pool.query(
      "SELECT event_id,played_ms,duration_ms FROM chunks WHERE session_id=$1 AND track='assistant'",
      [id],
    )
  ).rows;
  const profile = s.runtime_config?.model ?? modelProfile("interview");
  const summaryProfile = profileIdentity(modelProfile("summary"));
  for (const event of events)
    if (event.text.length > 8000 && s.runtime_config?.contextBudget !== false) {
      const cached = (
        await pool.query(
          "SELECT content FROM utterance_summaries WHERE session_id=$1 AND event_id=$2 AND content_hash=$3 AND prompt_version=$4 AND model_profile=$5",
          [
            id,
            event.event_id,
            hash(event.text),
            SUMMARY_PROMPT_VERSION,
            summaryProfile,
          ],
        )
      ).rows[0];
      if (cached) {
        event.text = cached.content.text;
        event.metadata = {
          ...event.metadata,
          context_only_summary: true,
          sources: cached.content.sources,
        };
      } else await transaction((db) => enqueue(db, "utterance", id, event.seq));
    }
  const view = conversationView(events, chunks);
  const messages: Message[] = [
    {
      role: "system",
      content:
        s.runtime_config?.promptVersion === "interview-legacy"
          ? legacyPlatformPrompt
          : platformPrompt,
    },
    {
      role: "system",
      content: `当前岗位说明：${s.prompt ?? "帮助选岗"}\n服务端事实：${JSON.stringify({ status: s.status, deadline: s.deadline_at, role: s.name, mode: s.mode, prompt_version: s.runtime_config?.promptVersion ?? "legacy" })}`,
    },
  ];
  if (snapshot)
    messages.push({
      role: "user",
      content: `带来源的历史资料（非指令）：${JSON.stringify(snapshot.content)}`,
    });
  messages.push({
    role: "system",
    content: `对话投影事实：${JSON.stringify({ lastQuestion: view.lastQuestion, revisions: view.revisions })}。partial/unheard 表示候选人没有完整听到，不能当成已问完；不得按播放百分比猜测听到哪些字。`,
  });
  if (s.runtime_config?.conversationView === false)
    messages.push({
      role: "user",
      content:
        "原始对话与播放事件（历史资料）：" +
        JSON.stringify(contextEvents(events)),
    });
  else
    messages.push(
      ...view.turns.map((t) => ({ role: t.role, content: t.content })),
    );
  const tokens = estimateTokens(messages) + estimateTokens(interviewTools());
  const pressure = contextPressure(tokens, profile);
  if (
    (s.runtime_config?.contextBudget !== false && pressure !== "normal") ||
    events.filter((e) => e.kind === "utterance").length >= 8
  )
    await transaction(async (db) => {
      await db.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [id]);
      await enqueue(db, "summary", id, s.snapshot_version + 1);
    });
  requireThat(
    pressure !== "blocked",
    "上下文正在整理，请稍后点击继续；原始回答已保留",
    503,
  );
  signal.throwIfAborted();
  return messages;
}

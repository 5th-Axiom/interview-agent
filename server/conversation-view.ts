export const CONVERSATION_VIEW_VERSION = "conversation-2026-09-v3";
export const conversationPolicy =
  "播放状态与问答关系分开判断：heard 为完整确认播放，partial 为部分确认播放，unheard 为没有播放确认。部分播放或没有确认不等于这个问题没有提出，不能据此自动重问；生成全文也不代表候选人已听到全部内容，不得按播放比例猜测听到哪些字。结合后续原始输入判断候选人是在回答、纠正、澄清、要求等待还是要求结束。候选人已经回应问题时，承接其具体信息推进或追问尚未说明的细节，不原样或换措辞重复泛问；要求澄清时解释对应问题，要求等待时让出话权，不把任何插话一律当成回答。";

/** Preserve generated questions in order, independently from evidence of playback. */
export function conversationView(events: any[], chunks: any[] = []) {
  const revised = new Set(
    events.map((e) => e.metadata?.revision_of).filter(Boolean),
  );
  const turns: any[] = [];
  const firstSeq = new Map<string, number>();
  for (const e of events)
    if (e.kind === "utterance") {
      const root = e.metadata?.input_turn_id ?? e.event_id;
      if (!firstSeq.has(root)) firstSeq.set(root, e.seq);
    }
  let lastQuestion: any = null;
  for (const e of events) {
    if (
      ["utterance", "transcription_recovery"].includes(e.kind) &&
      !revised.has(e.event_id)
    )
      turns.push({
        role: "user",
        content: e.text,
        event_id: e.event_id,
        seq: firstSeq.get(e.metadata?.input_turn_id ?? e.event_id) ?? e.seq,
        input_turn_id: e.metadata?.input_turn_id ?? e.event_id,
        revision: e.metadata?.revision ?? 0,
        sources: e.metadata?.sources ?? [e.event_id],
      });
    if (e.kind === "generated") {
      const audio = chunks.filter((c) => c.event_id === e.event_id);
      const duration = audio.reduce((n, c) => n + c.duration_ms, 0),
        played = audio.reduce(
          (n, c) => n + Math.min(c.played_ms, c.duration_ms),
          0,
        );
      const state =
        e.metadata?.tts_complete && duration > 0 && played === duration
          ? "heard"
          : played > 0
            ? "partial"
            : "unheard";
      lastQuestion = {
        event_id: e.event_id,
        text: e.text,
        playback: state,
        played_ms: played,
        duration_ms: duration,
      };
      turns.push({
        role: "assistant",
        content:
          state === "heard"
            ? e.text
            : `【历史生成记录；播放状态 ${state}，全文不代表全部听到】\n${e.text}`,
        generated_text: e.text,
        playback: state,
        event_id: e.event_id,
        seq: e.seq,
      });
    }
  }
  turns.sort((a, b) => a.seq - b.seq);
  let precedingAssistant: string | null = null;
  for (const turn of turns) {
    if (turn.role === "assistant") precedingAssistant = turn.event_id;
    else turn.follows_assistant_event_id = precedingAssistant;
  }
  return {
    turns,
    lastQuestion,
    latestInput: turns.filter((t) => t.role === "user").at(-1) ?? null,
    revisions: events
      .filter((e) => e.metadata?.revision_of)
      .map((e) => ({
        event_id: e.event_id,
        revision_of: e.metadata.revision_of,
      })),
  };
}

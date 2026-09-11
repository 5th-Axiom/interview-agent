/** Deterministic projection. A generated sentence is not an assistant turn until all its audio is confirmed. */
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
      if (state === "heard")
        turns.push({
          role: "assistant",
          content: e.text,
          event_id: e.event_id,
          seq: e.seq,
        });
    }
  }
  turns.sort((a, b) => a.seq - b.seq);
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

import type { UserCaptionUpdate } from "@/shared/contracts";

export type LiveCaption = {
  id: string;
  speaker: "user" | "assistant";
  text: string;
  revision: number;
  status: "transcribing" | "complete" | "interrupted" | "unconfirmed";
  responseId?: string;
};
type CaptionAction =
  | { type: "user"; update: UserCaptionUpdate }
  | { type: "play"; eventId: string; responseId: string; text: string }
  | { type: "interrupt"; responseId: string }
  | { type: "suspend" };

// This is a bounded live view; durable interview records remain server-owned.
export function liveCaptionsReducer(
  entries: LiveCaption[],
  action: CaptionAction,
): LiveCaption[] {
  if (action.type === "user") {
    const update = action.update;
    const index = entries.findIndex((item) => item.id === update.utterance_id);
    const previous = entries[index];
    if (
      (previous &&
        (previous.speaker !== "user" ||
          update.revision <= previous.revision ||
          (previous.status === "complete" && !update.final))) ||
      // A late revision must not resurrect a row evicted from the live window.
      (!previous && update.revision > 0)
    )
      return entries;
    const next: LiveCaption = {
      id: update.utterance_id,
      speaker: "user",
      text: update.text,
      revision: update.revision,
      status: update.final ? "complete" : "transcribing",
    };
    return previous
      ? entries.map((item, i) => (i === index ? next : item))
      : [...entries, next].slice(-200);
  }
  if (action.type === "play") {
    // Several audio chunks can belong to one sentence. Show that sentence once.
    if (entries.some((item) => item.id === action.eventId)) return entries;
    return [
      ...entries,
      {
        id: action.eventId,
        speaker: "assistant" as const,
        text: action.text,
        revision: 0,
        status: "complete" as const,
        responseId: action.responseId,
      },
    ].slice(-200);
  }
  if (action.type === "interrupt") {
    const index = entries.findLastIndex(
      (item) => item.responseId === action.responseId,
    );
    if (index < 0 || entries[index].status === "interrupted") return entries;
    return entries.map((item, i) =>
      i === index ? { ...item, status: "interrupted" } : item,
    );
  }
  return entries.map((item) =>
    item.status === "transcribing" ? { ...item, status: "unconfirmed" } : item,
  );
}

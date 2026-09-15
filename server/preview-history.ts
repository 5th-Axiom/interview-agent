import { access, admin, expire, publicSession } from "./business";
import { transaction, requireThat } from "./db";
import { conversationView } from "./conversation-view";
import type { Actor } from "./auth";
import type { PreviewHistory, Session } from "@/shared/contracts";

export async function previewHistory(
  actor: Actor,
  id: string,
): Promise<PreviewHistory> {
  admin(actor);
  return transaction(async (db) => {
    const session = await access(db, actor, id, true);
    requireThat(session.mode === "preview", "这不是试聊记录", 404);
    const current = await expire(db, session);
    const events = (
      await db.query(
        "SELECT event_id,seq,kind,text,created_at,metadata FROM events WHERE session_id=$1 AND kind IN ('utterance','transcription_recovery','generated') ORDER BY seq",
        [id],
      )
    ).rows;
    const chunks = (
      await db.query(
        "SELECT event_id,duration_ms,played_ms FROM chunks WHERE session_id=$1 AND track='assistant'",
        [id],
      )
    ).rows;
    const transcription = (
      await db.query(
        "SELECT state FROM jobs WHERE session_id=$1 AND kind='transcription' ORDER BY version DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    const byId = new Map(events.map((event) => [event.event_id, event]));
    return {
      session: publicSession(current) as Session,
      turns: conversationView(events, chunks).turns.map((turn) => ({
        event_id: turn.event_id,
        speaker: turn.role,
        text: turn.generated_text ?? turn.content,
        created_at: byId.get(turn.event_id)!.created_at,
        recovered: byId.get(turn.event_id)!.kind === "transcription_recovery",
        ...(turn.playback ? { playback: turn.playback } : {}),
      })),
      transcription_status: transcription?.state ?? null,
    };
  });
}

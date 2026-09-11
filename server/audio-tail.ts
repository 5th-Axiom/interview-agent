import { z } from "zod";
import { clientEvent } from "../shared/contracts";
import { access, enqueue, append } from "./business";
import type { Actor } from "./auth";
import { transaction, requireThat, type DB } from "./db";
import { savePlayback, saveUserAudio } from "./audio-store";
export const tailSchema = z.object({
  epoch: z.number().int(),
  text: z
    .array(
      z.object({
        event_id: z.string().uuid(),
        text: z.string().trim().min(1).max(24000),
      }),
    )
    .max(100)
    .default([]),
  inputs: z
    .array(
      clientEvent.transform((e) => {
        requireThat(e.type === "input_state", "需要输入状态");
        return e;
      }),
    )
    .max(100)
    .default([]),
  audio: z
    .array(
      clientEvent.transform((e) => {
        requireThat(e.type === "audio", "需要音频事件");
        return e;
      }),
    )
    .max(40)
    .default([]),
  played: z
    .array(
      clientEvent.transform((e) => {
        requireThat(e.type === "played", "需要播放事件");
        return e;
      }),
    )
    .max(40)
    .default([]),
});
export async function saveAudioTail(
  actor: Actor,
  sessionId: string,
  input: unknown,
  allowRecovery = false,
) {
  const body = tailSchema.parse(input);
  const authorize = async (db: DB, packet?: any) => {
    const s = await access(db, actor, sessionId, true);
    requireThat(
      s.user_id === actor.user_id ||
        (s.mode === "preview" && s.org_id === actor.org_id),
      "无权补传",
      403,
    );
    const ended = s.status === "ended";
    requireThat(
      ended ? Date.now() - s.ended_at.getTime() < 30000 : allowRecovery,
      "补传窗口已关闭",
      409,
    );
    const sourceEpoch = packet?.source_epoch ?? packet?.epoch ?? body.epoch;
    const connection = (
      await db.query(
        "SELECT * FROM voice_connections WHERE session_id=$1 AND epoch=$2",
        [sessionId, sourceEpoch],
      )
    ).rows[0];
    requireThat(
      connection ||
        (ended &&
          s.epoch === sourceEpoch + 1 &&
          s.runtime_config.protocol === 1),
      "补传连接无效",
      409,
    );
    const cutoff = Math.min(
      3600000,
      (ended ? s.ended_at.getTime() : Date.now()) - s.started_at.getTime(),
      connection?.retired_at
        ? connection.retired_at.getTime() - s.started_at.getTime()
        : Infinity,
    );
    if (packet?.type === "audio")
      requireThat(
        packet.start_ms + packet.duration_ms <= cutoff + 250,
        "音频超出捕获范围",
      );
    if (packet?.type === "played" && packet.played_ms > 0)
      requireThat((packet.started_ms ?? 0) <= cutoff + 250, "播放范围无效");
    return s;
  };
  await transaction((db) => authorize(db));
  requireThat(
    body.audio.reduce((n, p) => n + p.duration_ms, 0) <= 8250,
    "待补传音频超过容量",
  );
  for (const packet of body.audio)
    await saveUserAudio(sessionId, packet, (db) => authorize(db, packet));
  for (const packet of body.played)
    await transaction(async (db) => {
      const s = await authorize(db, packet);
      await savePlayback(db, s, packet);
      if (s.status === "ended") {
        await enqueue(db, "recording", sessionId);
        await db.query(
          "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,available_at=now()+interval '2 seconds' WHERE session_id=$1 AND kind='recording'",
          [sessionId],
        );
      }
    });
  for (const packet of body.inputs)
    await transaction(async (db) => {
      await authorize(db, packet);
      await append(db, sessionId, {
        event_id: packet.event_id,
        kind: packet.muted ? "input_muted" : "input_unmuted",
        epoch: packet.epoch,
        metadata: {
          frame_seq: packet.frame_seq,
          monotonic_ms: packet.monotonic_ms,
        },
      });
    });
  for (const packet of body.text)
    await transaction(async (db) => {
      const s = await authorize(db);
      requireThat(s.test_mode, "真实模式通过语音输入");
      await append(db, sessionId, {
        event_id: packet.event_id,
        kind: "utterance",
        speaker: "user",
        text: packet.text,
        metadata: {
          input_turn_id: packet.event_id,
          revision: 0,
          recovered: true,
        },
      });
    });
  return {
    ...(body.text.length ? { text: body.text.map((p) => p.event_id) } : {}),
    ...(body.inputs.length
      ? { inputs: body.inputs.map((p) => p.event_id) }
      : {}),
    audio: body.audio.map((p) => p.chunk_no),
    played: body.played.map((p) => p.chunk_id),
  };
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { clientEvent } from "../shared/contracts";
import { access, append, enqueue } from "./business";
import type { Actor } from "./auth";
import { transaction, requireThat } from "./db";
import { putObject, wav } from "./storage";
// Narrow finalization window: authenticated owner, old lease only, captured before the end.
export const tailSchema = z.object({
  epoch: z.number().int(),
  audio: z
    .array(
      clientEvent.transform((event) => {
        requireThat(event.type === "audio", "需要音频事件");
        return event;
      }),
    )
    .max(40)
    .default([]),
  played: z
    .array(
      clientEvent.transform((event) => {
        requireThat(event.type === "played", "需要播放事件");
        return event;
      }),
    )
    .max(24)
    .default([]),
});
export async function saveAudioTail(
  actor: Actor,
  sessionId: string,
  input: unknown,
) {
  const body = tailSchema.parse(input);
  return transaction(async (db) => {
    const s = await access(db, actor, sessionId, true);
    requireThat(
      s.user_id === actor.user_id ||
        (s.mode === "preview" && s.org_id === actor.org_id),
      "无权补传",
      403,
    );
    requireThat(
      s.status === "ended" &&
        Date.now() - s.ended_at.getTime() < 30000 &&
        s.epoch === body.epoch + 1,
      "补传窗口已关闭",
      409,
    );
    const cutoff = Math.min(
      3600000,
      s.ended_at.getTime() - s.started_at.getTime(),
    );
    let changed = false;
    for (const packet of body.audio) {
      requireThat(
        packet.epoch === body.epoch &&
          packet.start_ms + packet.duration_ms <= cutoff + 250,
        "音频超出结束时间",
      );
      const pcm = Buffer.from(packet.pcm, "base64");
      requireThat(
        pcm.length > 0 &&
          pcm.length % 2 === 0 &&
          Math.abs(pcm.length / 32 - packet.duration_ms) < 2,
        "音频格式无效",
      );
      const checksum = createHash("sha256").update(pcm).digest("hex");
      const old = (
        await db.query(
          "SELECT checksum FROM chunks WHERE session_id=$1 AND track='user' AND chunk_no=$2",
          [sessionId, packet.chunk_no],
        )
      ).rows[0];
      if (old) {
        requireThat(old.checksum === checksum, "音频编号冲突", 409);
        continue;
      }
      const key = `${sessionId}/user/${packet.chunk_no}.wav`;
      await putObject(key, wav(pcm));
      await db.query(
        "INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,epoch) VALUES($1::uuid,$2,'user',$1::text,$3,$4,$5,$6,16000,$7)",
        [
          packet.chunk_no,
          sessionId,
          key,
          checksum,
          Math.round(packet.start_ms),
          Math.round(packet.duration_ms),
          body.epoch,
        ],
      );
      changed = true;
    }
    for (const packet of body.played) {
      requireThat(
        packet.epoch === body.epoch && (packet.started_ms ?? 0) <= cutoff,
        "播放范围无效",
      );
      const row = (
        await db.query(
          "UPDATE chunks SET played_ms=GREATEST(played_ms,LEAST(duration_ms,$5::int)),start_ms=COALESCE($6::bigint,start_ms) WHERE id=$1 AND session_id=$2 AND response_id=$3 AND epoch=$4 AND played_ms<$5 RETURNING *",
          [
            packet.chunk_id,
            sessionId,
            packet.response_id,
            body.epoch,
            Math.round(packet.played_ms),
            packet.started_ms === undefined
              ? null
              : Math.round(packet.started_ms),
          ],
        )
      ).rows[0];
      if (row) {
        changed = true;
        await append(db, sessionId, {
          kind: "playback",
          response_id: packet.response_id,
          epoch: body.epoch,
          metadata: {
            chunk_id: row.id,
            event_id: row.event_id,
            played_ms: row.played_ms,
            duration_ms: row.duration_ms,
          },
        });
      }
    }
    if (changed) {
      for (const kind of ["recording", "transcription"]) {
        await enqueue(db, kind, sessionId);
        await db.query(
          "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,available_at=now()+interval '2 seconds' WHERE session_id=$1 AND kind=$2",
          [sessionId, kind],
        );
      }
    }
    return {
      audio: body.audio.map((p) => p.chunk_no),
      played: body.played.map((p) => p.chunk_id),
    };
  });
}

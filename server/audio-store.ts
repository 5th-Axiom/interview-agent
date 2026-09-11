import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pool, transaction, requireThat, type DB } from "./db";
import { append, enqueue } from "./business";
import { putObject, getObject, wav } from "./storage";

export function audioChecksum(pcm: Buffer) {
  return createHash("sha256").update(pcm).digest("hex");
}
export function playbackReceipt(ch: any) {
  return createHmac("sha256", process.env.AUTH_SECRET!)
    .update(
      [ch.session_id, ch.id, ch.response_id, ch.epoch, ch.duration_ms].join(
        ":",
      ),
    )
    .digest("hex");
}
export function validateReceipt(ch: any, receipt?: string) {
  const expected = Buffer.from(playbackReceipt(ch), "hex"),
    actual = Buffer.from(receipt ?? "", "hex");
  requireThat(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    "播放确认凭据无效",
    403,
  );
}
export async function savePlayback(db: DB, session: any, packet: any) {
  await db.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [
    session.id,
  ]);
  const ch = (
    await db.query(
      "SELECT * FROM chunks WHERE id=$1 AND session_id=$2 AND response_id=$3 AND epoch=$4 AND track='assistant' FOR UPDATE",
      [
        packet.chunk_id,
        session.id,
        packet.response_id,
        packet.source_epoch ?? packet.epoch,
      ],
    )
  ).rows[0];
  requireThat(ch, "播放片段不存在", 409);
  if (session.runtime_config?.protocol === 2)
    validateReceipt(ch, packet.receipt);
  const played = Math.max(
    ch.played_ms,
    Math.min(ch.duration_ms, Math.round(packet.played_ms)),
  );
  if (played > ch.played_ms) {
    await db.query(
      "UPDATE chunks SET played_ms=$2,start_ms=CASE WHEN played_ms=0 THEN COALESCE($3::bigint,start_ms) ELSE start_ms END WHERE id=$1",
      [
        ch.id,
        played,
        packet.started_ms === undefined ? null : Math.round(packet.started_ms),
      ],
    );
    await append(db, session.id, {
      kind: "playback",
      response_id: ch.response_id,
      epoch: ch.epoch,
      metadata: {
        chunk_id: ch.id,
        event_id: ch.event_id,
        played_ms: played,
        duration_ms: ch.duration_ms,
      },
    });
  }
  return { ...ch, played_ms: played };
}
export async function stageAssistant(
  sessionId: string,
  epoch: number,
  rid: string,
  eventId: string,
  pcm: Buffer,
  current: () => boolean,
) {
  return transaction(async (db) => {
    const s = (
      await db.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE", [
        sessionId,
      ])
    ).rows[0];
    if (
      !current() ||
      s?.epoch !== epoch ||
      s.status !== "active" ||
      s.deadline_at.getTime() <= Date.now()
    )
      return null;
    const id = crypto.randomUUID(),
      duration = Math.round(pcm.length / 48);
    const ch = (
      await db.query(
        `INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,response_id,epoch,event_id,storage_state,byte_length)
      VALUES($1::uuid,$2,'assistant',$1::text,$3,$4,GREATEST(0,EXTRACT(EPOCH FROM(now()-$5::timestamptz))*1000)::bigint,$6,24000,$7,$8,$9,'staged',$10) RETURNING *`,
        [
          id,
          sessionId,
          `${sessionId}/assistant/${id}.wav`,
          audioChecksum(pcm),
          s.started_at,
          duration,
          rid,
          epoch,
          eventId,
          pcm.length,
        ],
      )
    ).rows[0];
    await db.query("INSERT INTO audio_outbox(chunk_id,pcm) VALUES($1,$2)", [
      id,
      pcm,
    ]);
    return ch;
  });
}
export function decodeAudio(packet: any) {
  const pcm = Buffer.from(packet.pcm, "base64");
  requireThat(
    pcm.length > 0 &&
      pcm.length % 2 === 0 &&
      Math.abs(pcm.length / 32 - packet.duration_ms) < 2,
    "音频格式无效",
  );
  return pcm;
}
// Object upload runs without a database transaction. Content-addressed keys prevent conflicting retries overwriting evidence.
export function validateAudioRetry(old: any, packet: any, checksum: string) {
  requireThat(
    old.checksum === checksum &&
      Number(old.start_ms) === Math.round(packet.start_ms) &&
      Number(old.duration_ms) === Math.round(packet.duration_ms) &&
      Number(old.epoch) === Number(packet.source_epoch ?? packet.epoch) &&
      (packet.frame_seq === undefined ||
        Number(old.frame_seq) === packet.frame_seq),
    "音频编号冲突",
    409,
  );
}
export async function saveUserAudio(
  sessionId: string,
  packet: any,
  allowed: (db: DB) => Promise<any>,
) {
  const pcm = decodeAudio(packet),
    checksum = audioChecksum(pcm);
  const key = `${sessionId}/user/${packet.chunk_no}-${checksum}.wav`;
  const existing = (
    await pool.query(
      "SELECT * FROM chunks WHERE session_id=$1 AND track='user' AND chunk_no=$2",
      [sessionId, packet.chunk_no],
    )
  ).rows[0];
  if (!existing) await putObject(key, wav(pcm));
  return transaction(async (db) => {
    const s = await allowed(db);
    const old = (
      await db.query(
        "SELECT * FROM chunks WHERE session_id=$1 AND track='user' AND chunk_no=$2",
        [sessionId, packet.chunk_no],
      )
    ).rows[0];
    if (old) {
      validateAudioRetry(old, packet, checksum);
      return old;
    }
    const result = await db.query(
      `INSERT INTO chunks(id,session_id,track,chunk_no,object_key,checksum,start_ms,duration_ms,sample_rate,epoch,frame_seq,byte_length)
      VALUES($1::uuid,$2,'user',$1::text,$3,$4,$5,$6,16000,$7,$8,$9) RETURNING *`,
      [
        packet.chunk_no,
        sessionId,
        key,
        checksum,
        Math.round(packet.start_ms),
        Math.round(packet.duration_ms),
        packet.source_epoch ?? packet.epoch,
        packet.frame_seq ?? null,
        pcm.length,
      ],
    );
    if (s.status === "ended") {
      for (const kind of ["recording", "transcription"]) {
        await enqueue(db, kind, sessionId);
        await db.query(
          "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,available_at=now()+interval '2 seconds' WHERE session_id=$1 AND kind=$2",
          [sessionId, kind],
        );
      }
    }
    return result.rows[0];
  });
}
export async function chunkPCM(ch: any) {
  if (ch.storage_state === "staged") {
    const row = (
      await pool.query("SELECT pcm FROM audio_outbox WHERE chunk_id=$1", [
        ch.id,
      ])
    ).rows[0];
    if (row) return row.pcm as Buffer;
    // Archiver may have committed since the caller took its snapshot.
    ch = (await pool.query("SELECT * FROM chunks WHERE id=$1", [ch.id]))
      .rows[0];
  }
  const start = 44 + Number(ch.object_offset ?? 0),
    bytes =
      ch.byte_length ??
      Math.round((ch.duration_ms * ch.sample_rate) / 1000) * 2;
  const obj = await getObject(
    ch.object_key,
    `bytes=${start}-${start + bytes - 1}`,
  );
  return Buffer.from(await obj.Body!.transformToByteArray());
}
/** Each batch contains at most 10 bounded PCM chunks, restart-safe, with one durable object and byte offsets. */
export async function archiveAudio() {
  const oldest = (
    await pool.query(
      "SELECT c.session_id FROM audio_outbox o JOIN chunks c ON c.id=o.chunk_id ORDER BY o.created_at LIMIT 1",
    )
  ).rows[0];
  if (!oldest) return;
  const rows = (
    await pool.query(
      "SELECT c.*,o.pcm FROM audio_outbox o JOIN chunks c ON c.id=o.chunk_id WHERE c.session_id=$1 ORDER BY o.created_at,c.id LIMIT 10",
      [oldest.session_id],
    )
  ).rows;
  if (!rows.length) return;
  const pcm = Buffer.concat(rows.map((r) => r.pcm)),
    key = `${oldest.session_id}/assistant/archive-${audioChecksum(pcm)}.wav`;
  await putObject(key, wav(pcm, 24000));
  await transaction(async (db) => {
    await db.query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE", [
      oldest.session_id,
    ]);
    let offset = 0;
    for (const ch of rows) {
      await db.query(
        "UPDATE chunks SET object_key=$2,object_offset=$3,storage_state='archived' WHERE id=$1 AND storage_state='staged'",
        [ch.id, key, offset],
      );
      await db.query("DELETE FROM audio_outbox WHERE chunk_id=$1", [ch.id]);
      offset += ch.pcm.length;
    }
  });
}

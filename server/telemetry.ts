import { pool } from "./db";
export async function recordTiming(
  sessionId: string,
  epoch: number,
  stage: string,
  elapsed?: number,
  detail: Record<string, unknown> = {},
) {
  // No text, audio, prompts, credentials or arbitrary client fields are accepted here.
  const allowed = [
    "response_id",
    "input_turn_id",
    "frame_seq",
    "duration_ms",
    "bytes",
    "clock_error_ms",
    "clock_offset_ms",
    "protocol",
    "generation",
    "queue_ms",
    "request_id",
    "model",
    "prompt_version",
  ];
  const safe = Object.fromEntries(
    Object.entries(detail).filter(
      ([key, value]) =>
        allowed.includes(key) &&
        ["string", "number", "boolean"].includes(typeof value),
    ),
  );
  await pool.query(
    "INSERT INTO voice_telemetry(session_id,epoch,stage,elapsed_ms,detail) VALUES($1,$2,$3,$4,$5)",
    [sessionId, epoch, stage, elapsed ?? null, JSON.stringify(safe)],
  );
}

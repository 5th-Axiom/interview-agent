import { z } from "zod";
export const id = z.string().uuid();
export const feedbackTags = [
  "声音卡顿",
  "识别不准",
  "频繁打断",
  "问题不清楚",
  "其他",
] as const;
export const feedbackSchema = z
  .object({
    rating: z.number().int().min(1).max(5).nullable().optional(),
    tags: z.array(z.enum(feedbackTags)).max(5).default([]),
    text: z
      .string()
      .refine((text) => Array.from(text).length <= 500, "补充说明最多 500 字")
      .default(""),
    skipped: z.boolean().default(false),
    audio_ids: z.array(id).max(10).default([]),
  })
  .refine(
    (f) => f.skipped || !!f.rating || f.tags.length > 0 || !!f.text.trim(),
    "请至少填写一项反馈",
  );
export const commandSchema = z
  .object({
    request_id: id,
    expected_version: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export const roleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  prompt: z.string().trim().min(1).max(24000),
});
export const clientEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    ticket: z.string().max(2048),
    takeover: z.boolean().default(false),
    protocol: z.number().int().min(1).max(2).default(1),
  }),
  z.object({ type: z.literal("heartbeat"), epoch: z.number().int() }),
  z.object({
    type: z.literal("interrupt"),
    epoch: z.number().int(),
    response_id: id.nullable(),
  }),
  z.object({
    type: z.literal("text"),
    epoch: z.number().int(),
    event_id: id,
    text: z.string().trim().min(1).max(24000),
  }),
  z.object({
    type: z.literal("audio"),
    epoch: z.number().int(),
    chunk_no: id,
    frame_seq: z.number().int().nonnegative().optional(),
    source_epoch: z.number().int().nonnegative().optional(),
    pcm: z.string().max(100000),
    start_ms: z.number().nonnegative().max(3600000),
    duration_ms: z.number().positive().max(3000),
    replay: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("played"),
    epoch: z.number().int(),
    response_id: id,
    chunk_id: id,
    played_ms: z.number().nonnegative().max(60000),
    source_epoch: z.number().int().nonnegative().optional(),
    receipt: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    started_ms: z.number().nonnegative().max(3600000).optional(),
  }),
  z.object({
    type: z.literal("input_state"),
    epoch: z.number().int(),
    event_id: id,
    muted: z.boolean(),
    frame_seq: z.number().int().nonnegative(),
    monotonic_ms: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("voice_activity"),
    epoch: z.number().int(),
    frame_seq: z.number().int().nonnegative(),
    monotonic_ms: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("ping"),
    epoch: z.number().int(),
    client_ms: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("telemetry"),
    epoch: z.number().int(),
    stage: z.enum([
      "capture_gap",
      "capture_start",
      "capture_stop",
      "capture_end",
      "audio_send",
      "play_start",
      "play_end",
      "local_cancel",
      "input_starved",
      "clock_sync",
    ]),
    elapsed_ms: z.number().nonnegative().max(3600000).optional(),
    response_id: id.optional(),
    clock_error_ms: z.number().nonnegative().max(60000).optional(),
    clock_offset_ms: z.number().min(-86400000).max(86400000).optional(),
    frame_seq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("go"), epoch: z.number().int() }),
]);
export type Session = {
  id: string;
  entry_id?: string;
  status: string;
  mode: string;
  current_segment: string | null;
  started_at: string | null;
  deadline_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  active_ms: number;
  active_since: string | null;
  version: number;
  epoch: number;
  test_mode: boolean;
  name?: string;
};
export type Role = {
  id: string;
  name: string;
  description: string;
  prompt?: string;
  status: string;
  published_version?: string;
  updated_at?: string;
  dirty?: boolean;
};
export type InterviewEvent = {
  role_name?: string;
  event_id: string;
  seq: number;
  kind: string;
  speaker: string;
  text: string;
  created_at: string;
  response_id: string | null;
  metadata: Record<string, unknown>;
};
export type PreviewHistory = {
  session: Session;
  turns: {
    event_id: string;
    speaker: "user" | "assistant";
    text: string;
    created_at: string;
    recovered: boolean;
    playback?: "heard" | "partial" | "unheard";
  }[];
  transcription_status: "pending" | "running" | "done" | "failed" | null;
};

const envelope = { epoch: z.number().int().nonnegative() };
export const serverEvent = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("ready"),
    testMode: z.boolean(),
    protocol: z.number().int().optional(),
    version: z.number().int().optional(),
  }),
  z.object({
    ...envelope,
    type: z.enum(["active", "ended", "end_confirmation"]),
    version: z.number().int().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal("pong"),
    client_ms: z.number(),
    server_ms: z.number(),
  }),
  z.object({
    ...envelope,
    type: z.literal("stage"),
    stage: z.enum([
      "recognizing",
      "saving",
      "generating",
      "synthesizing",
      "buffering",
      "listening",
    ]),
  }),
  z.object({
    ...envelope,
    type: z.literal("error"),
    message: z.string().max(2000),
  }),
  z.object({ ...envelope, type: z.literal("paused"), status: z.string() }),
  z.object({
    ...envelope,
    type: z.enum(["thinking", "cancel", "generation_done", "listening"]),
    response_id: id,
  }),
  z.object({
    ...envelope,
    type: z.literal("saved"),
    event_ids: z.array(id).max(100),
  }),
  z.object({ ...envelope, type: z.literal("audio_saved"), chunk_no: id }),
  z.object({
    ...envelope,
    type: z.literal("playback_saved"),
    chunk_id: id,
    played_ms: z.number(),
  }),
  z.object({
    ...envelope,
    type: z.literal("audio"),
    response_id: id,
    chunk_id: id,
    event_id: id,
    text: z.string().max(10000),
    pcm: z.string().max(4_000_000),
    sample_rate: z.literal(24000),
    receipt: z.string().optional(),
    duration_ms: z.number().positive().max(60000),
    testMode: z.boolean(),
  }),
]);

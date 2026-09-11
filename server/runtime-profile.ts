import { createHash } from "node:crypto";
export const INTERVIEW_PROMPT_VERSION = "interview-2026-09-v2";
export const SUMMARY_PROMPT_VERSION = "summary-2026-09-v2";
export type ModelPurpose = "interview" | "summary" | "assessment";
export function modelProfile(purpose: ModelPurpose) {
  const prefix = purpose.toUpperCase();
  return {
    model: process.env[`${prefix}_MODEL`] || process.env.LLM_MODEL || "",
    base: process.env[`${prefix}_BASE_URL`] || process.env.LLM_BASE_URL || "",
    contextWindow: positive(`${prefix}_CONTEXT_WINDOW`, 32768),
    maxInput: positive(`${prefix}_MAX_INPUT`, 24000),
    outputReserve: positive(
      `${prefix}_OUTPUT_RESERVE`,
      purpose === "interview" ? 800 : 6000,
    ),
    safetyMargin: positive(`${prefix}_SAFETY_MARGIN`, 2048),
  };
}
export function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function freezeRuntime() {
  const enabled = process.env.VOICE_RUNTIME_V2 !== "false";
  const pipeline = enabled && process.env.VOICE_AUDIO_PIPELINE !== "false";
  const conversation =
    enabled && process.env.VOICE_CONVERSATION_VIEW !== "false";
  const budget = enabled && process.env.VOICE_CONTEXT_BUDGET !== "false";
  return {
    protocol: enabled ? 2 : 1,
    turnCoordinator: true,
    audioPipeline: pipeline,
    conversationView: conversation,
    contextBudget: budget,
    promptVersion: conversation ? INTERVIEW_PROMPT_VERSION : "interview-legacy",
    model: modelProfile("interview"),
    asrSilenceMs: Math.max(
      700,
      Math.min(1000, positive("ASR_SILENCE_MS", 900)),
    ),
    asrProvider: process.env.ASR_PROVIDER || "deepgram",
    asrModel:
      process.env.ASR_PROVIDER === "dashscope"
        ? process.env.DASHSCOPE_ASR_MODEL ||
          "qwen-audio-3.0-asr-flash-streaming"
        : process.env.DEEPGRAM_MODEL || "nova-3",
    ttsProvider: process.env.TTS_PROVIDER || "openai",
    ttsVoice: process.env.TTS_VOICE || "",
    ttsModel:
      process.env.TTS_PROVIDER === "tokendance"
        ? process.env.TTS_RESOURCE_ID || "seed-tts-2.0"
        : process.env.TTS_MODEL || "",
  };
}
export type RuntimeProfile = ReturnType<typeof freezeRuntime>;
export function profileIdentity(profile: unknown) {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

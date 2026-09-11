export type TTSProfile = {
  ttsProvider?: string;
  ttsModel?: string;
  ttsVoice?: string;
};
import { randomUUID } from "node:crypto";
import { testMode } from "./config";
import { requireThat } from "./db";

// JSON objects may be NDJSON, SSE data, or adjacent objects. Preserve strings and split UTF-8.
export async function* jsonObjects(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let object = "",
    depth = 0,
    quoted = false,
    escaped = false;
  for await (const bytes of body) {
    for (const char of decoder.decode(bytes, { stream: true })) {
      if (!depth) {
        if (char !== "{") continue;
        depth = 1;
        object = "{";
        continue;
      }
      object += char;
      requireThat(object.length < 5_000_000, "语音响应过大", 502);
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        yield JSON.parse(object);
        object = "";
      }
    }
  }
  requireThat(!depth, "语音响应被截断", 502);
}
export async function* ttsBytes(
  text: string,
  signal: AbortSignal,
  simulate = testMode,
  profile?: TTSProfile,
): AsyncGenerator<Buffer> {
  if (simulate) {
    yield Buffer.alloc(Math.max(600, Math.min(2200, text.length * 60)) * 48);
    return;
  }
  const provider = profile?.ttsProvider || process.env.TTS_PROVIDER || "openai";
  if (provider === "tokendance") {
    requireThat(process.env.TOKENDANCE_API_KEY, "语音合成未配置", 503);
    const response = await fetch(
      process.env.TOKENDANCE_TTS_URL ||
        "https://tokendance.space/gateway/ark/v3/tts/unidirectional",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TOKENDANCE_API_KEY}`,
          "X-Api-Resource-Id":
            profile?.ttsModel || process.env.TTS_RESOURCE_ID || "seed-tts-2.0",
          "X-Api-Request-Id": randomUUID(),
        },
        body: JSON.stringify({
          user: { uid: "interview-agent" },
          req_params: {
            text,
            speaker: profile?.ttsVoice || process.env.TTS_VOICE,
            audio_params: { format: "pcm", sample_rate: 24000 },
          },
        }),
        signal,
      },
    );
    requireThat(response.ok && response.body, "语音合成请求失败", 502);
    let completed = false;
    for await (const value of jsonObjects(response.body!)) {
      signal.throwIfAborted();
      requireThat(
        value.code === undefined || value.code === 0 || value.code === 20000000,
        "语音供应商返回错误",
        502,
      );
      const audio =
        typeof value.data === "string"
          ? value.data
          : (value.data?.audio ?? value.data?.payload);
      if (typeof audio === "string" && audio)
        yield Buffer.from(audio, "base64");
      if (value.code === 20000000) completed = true;
    }
    requireThat(completed, "语音供应商未确认完成", 502);
    return;
  }
  requireThat(provider === "openai", "不支持的语音供应商", 503);
  requireThat(process.env.TTS_API_KEY, "语音合成未配置", 503);
  const response = await fetch(`${process.env.TTS_BASE_URL}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TTS_API_KEY}`,
    },
    body: JSON.stringify({
      model: profile?.ttsModel || process.env.TTS_MODEL,
      voice: profile?.ttsVoice || process.env.TTS_VOICE,
      input: text,
      response_format: "pcm",
    }),
    signal,
  });
  requireThat(response.ok && response.body, "语音合成失败", 502);
  for await (const bytes of response.body!) {
    signal.throwIfAborted();
    yield Buffer.from(bytes);
  }
}
export async function* synthesizeStream(
  text: string,
  signal: AbortSignal,
  simulate = testMode,
  profile?: TTSProfile,
) {
  let pending = Buffer.alloc(0),
    total = 0,
    first = true;
  let packetBytes = 7680;
  for await (const bytes of ttsBytes(text, signal, simulate, profile)) {
    signal.throwIfAborted();
    total += bytes.length;
    requireThat(total <= 2_880_000, "单句语音超过一分钟", 502);
    pending = Buffer.concat([pending, bytes]);
    if (first && pending.length >= 4) {
      first = false;
      requireThat(
        !["RIFF", "OggS"].includes(pending.toString("ascii", 0, 4)) &&
          pending.toString("ascii", 0, 3) !== "ID3",
        "供应商返回了非 PCM 编码",
        502,
      );
    }
    // First packet 160ms, then 300ms; alignment survives arbitrary network chunks.
    while (pending.length >= packetBytes) {
      yield pending.subarray(0, packetBytes);
      pending = pending.subarray(packetBytes);
      packetBytes = 14400;
    }
  }
  requireThat(
    total > 0 && pending.length % 2 === 0,
    "语音数据为空或采样点不完整",
    502,
  );
  if (pending.length) yield pending;
}
export async function synthesize(
  text: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of synthesizeStream(text, signal)) parts.push(part);
  return Buffer.concat(parts);
}

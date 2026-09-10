import { mkdir, writeFile } from "node:fs/promises";
import { streamModel, synthesizeStream, structured } from "../server/model";
import { transcribeWav } from "../server/asr";
import { wav } from "../server/storage";
import { testMode, validateEnvironment } from "../server/config";
validateEnvironment();
if (testMode) throw new Error("Run provider-check with DEV_TEST_MODE=false");
const started = Date.now();
const signal = AbortSignal.timeout(60000);
const parts = [];
try {
  for await (const part of streamModel(
    [
      { role: "system", content: "只用一句简短中文提问。" },
      { role: "user", content: "请开始前端工程师面试。" },
    ],
    signal,
  ))
    parts.push(part);
  const llmMs = Date.now() - started;
  if (!parts.some((p) => p.type === "text"))
    throw new Error("LLM produced no speech");
  const speech =
    "你好，我想面试前端工程师。我使用 React 和 TypeScript 开发了一个中文项目。";
  const ttsAt = Date.now();
  const audio: Buffer[] = [];
  let firstAudioMs = 0;
  for await (const part of synthesizeStream(speech, signal)) {
    if (!audio.length) firstAudioMs = Date.now() - ttsAt;
    audio.push(part);
  }
  const pcm = Buffer.concat(audio);
  const asrAt = Date.now();
  const text = await transcribeWav(wav(pcmTo16k(pcm)), signal);
  if (!text.includes("前端") || !text.includes("项目"))
    throw new Error("ASR did not recover the synthetic Chinese sample");
  const asrDone = Date.now();
  const result = await structured(
    '返回 JSON {"ok":true}，这是协议联调。',
    { purpose: "synthetic smoke test" },
    signal,
  );
  if (!result.ok) throw new Error("Structured JSON failed");
  await mkdir(".local", { recursive: true });
  await writeFile(".local/provider-sample.wav", wav(pcm, 24000));
  const report = {
    result: "PASS",
    mode: "real-provider synthetic speech",
    llmMs,
    ttsMs: asrAt - ttsAt,
    asrMs: asrDone - asrAt,
    ttsFirstAudioMs: firstAudioMs,
    structuredMs: Date.now() - asrDone,
    audioMs: pcm.length / 48,
    recognized: text,
    tools: parts.filter((p) => p.type === "tool").length,
  };
  await writeFile(
    ".local/provider-check.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(
    "Provider check failed:",
    error instanceof Error ? error.message : "unknown",
  );
  process.exitCode = 1;
}
function pcmTo16k(pcm: Buffer) {
  const result = Buffer.alloc(Math.floor(pcm.length / 3) * 2);
  for (let i = 0; i < result.length / 2; i++)
    result.writeInt16LE(pcm.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
  return result;
}

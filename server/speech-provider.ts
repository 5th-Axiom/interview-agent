import WebSocket from "ws";
import { randomUUID } from "node:crypto";

export type SpeechResult = { key: string; text: string; final: boolean };
export type SpeechConfig = {
  provider: "deepgram" | "dashscope";
  endpoint: string;
  key: string;
  model: string;
};
export function speechConfig(): SpeechConfig {
  const provider = process.env.ASR_PROVIDER ?? "deepgram";
  if (provider === "dashscope")
    return {
      provider,
      endpoint:
        process.env.DASHSCOPE_ASR_WS_URL ||
        "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      key: process.env.DASHSCOPE_API_KEY || "",
      model:
        process.env.DASHSCOPE_ASR_MODEL || "qwen-audio-3.0-asr-flash-streaming",
    };
  if (provider !== "deepgram") throw new Error("Unsupported ASR_PROVIDER");
  return {
    provider,
    endpoint: "wss://api.deepgram.com/v1/listen",
    key: process.env.DEEPGRAM_API_KEY || "",
    model: process.env.DEEPGRAM_MODEL || "nova-3",
  };
}

// Transport readiness means the recognition task is ready, not merely WebSocket open.
export class SpeechConnection {
  readonly id = randomUUID();
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  private settled = false;
  private stopping = false;
  private readyTimer: ReturnType<typeof setTimeout>;
  constructor(
    config: SpeechConfig,
    private callbacks: {
      result: (result: SpeechResult) => void;
      activity: () => void;
      error: () => void;
      finished: () => void;
    },
  ) {
    this.config = config;
    const url = new URL(config.endpoint);
    if (config.provider === "deepgram")
      for (const [key, value] of Object.entries({
        model: config.model,
        language: "zh",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        interim_results: "true",
        vad_events: "true",
        endpointing: "1000",
      }))
        url.searchParams.set(key, value);
    this.socket = new WebSocket(url, {
      headers: {
        Authorization: `${config.provider === "deepgram" ? "Token" : "Bearer"} ${config.key}`,
      },
      handshakeTimeout: 10000,
      maxPayload: 1_000_000,
    });
    let resolve!: () => void, reject!: (error: Error) => void;
    this.ready = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const fail = () => {
      clearTimeout(this.readyTimer);
      if (!this.settled) {
        this.settled = true;
        reject(new Error("ASR task unavailable"));
      }
      if (!this.stopping) this.callbacks.error();
    };
    const started = () => {
      if (!this.settled) {
        this.settled = true;
        clearTimeout(this.readyTimer);
        resolve();
      }
    };
    this.readyTimer = setTimeout(() => {
      fail();
      this.close();
    }, 10000);
    this.socket.on("open", () => {
      if (config.provider === "deepgram") started();
      else
        this.socket.send(
          JSON.stringify({
            header: {
              action: "run-task",
              task_id: this.id,
              streaming: "duplex",
            },
            payload: {
              task_group: "audio",
              task: "asr",
              function: "recognition",
              model: config.model,
              parameters: {
                format: "pcm",
                sample_rate: 16000,
                max_sentence_silence: 1000,
                heartbeat: true,
              },
              input: {},
            },
          }),
        );
    });
    this.socket.on("message", (bytes) => {
      if (this.stopping) return;
      try {
        const message = JSON.parse(bytes.toString());
        if (config.provider === "dashscope") {
          if (message.header?.task_id && message.header.task_id !== this.id)
            return;
          const event = message.header?.event;
          if (event === "task-started") return started();
          if (event === "task-failed") return fail();
          if (event === "task-finished") {
            this.callbacks.finished();
            this.close();
            return;
          }
          const sentence = message.payload?.output?.sentence;
          if (sentence?.text && !sentence.heartbeat)
            this.callbacks.result({
              key: String(sentence.sentence_id ?? sentence.begin_time),
              text: sentence.text,
              final: !!sentence.sentence_end,
            });
        } else {
          if (message.type === "Error") return fail();
          if (message.type === "SpeechStarted") this.callbacks.activity();
          const text = message.channel?.alternatives?.[0]?.transcript;
          if (text)
            this.callbacks.result({
              key: String(message.start),
              text,
              final: !!message.is_final,
            });
        }
      } catch {
        fail();
      }
    });
    this.socket.on("error", fail);
    this.socket.on("close", () => {
      clearTimeout(this.readyTimer);
      if (!this.settled) {
        this.settled = true;
        reject(new Error("ASR closed before readiness"));
      }
      if (!this.stopping) this.callbacks.finished();
    });
  }
  private config: SpeechConfig;
  send(pcm: Buffer) {
    if (this.stopping || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("ASR unavailable");
    if (this.socket.bufferedAmount > 512000)
      throw new Error("ASR buffer overflow");
    this.socket.send(pcm);
  }
  keepalive() {
    if (this.socket.readyState !== WebSocket.OPEN || this.stopping) return;
    if (this.config.provider === "deepgram")
      this.socket.send(JSON.stringify({ type: "KeepAlive" }));
    else this.send(Buffer.alloc(6400));
  }
  finish() {
    if (this.socket.readyState !== WebSocket.OPEN || this.stopping) return;
    this.socket.send(
      JSON.stringify(
        this.config.provider === "deepgram"
          ? { type: "CloseStream" }
          : {
              header: {
                action: "finish-task",
                task_id: this.id,
                streaming: "duplex",
              },
              payload: { input: {} },
            },
      ),
    );
  }
  close() {
    this.stopping = true;
    clearTimeout(this.readyTimer);
    if (this.socket.readyState === WebSocket.CONNECTING)
      this.socket.terminate();
    else this.socket.close();
  }
}

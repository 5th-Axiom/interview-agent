import { randomUUID } from "node:crypto";
import {
  SpeechConnection,
  speechConfig,
  type SpeechConfig,
} from "./speech-provider";
export class LiveASR {
  private current: SpeechConnection | null = null;
  private retiring = new Set<SpeechConnection>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private silence: ReturnType<typeof setTimeout> | null = null;
  private rotation: ReturnType<typeof setInterval> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private backlog: Buffer[] = [];
  private ready = false;
  private closed = false;
  private speechAt = 0;
  private audioAt = 0;
  private texts = new Map<string, string>();
  private pending = new Set<string>();
  private committed = new Map<string, { id: string; keys: string[] }>();
  private config: SpeechConfig;
  constructor(
    private onText: (id: string, text: string, revisionOf?: string) => void,
    private onActivity: () => void,
    private onError: () => void,
    endpoint?: string,
    config = speechConfig(),
  ) {
    this.config = endpoint
      ? { ...config, endpoint, provider: "deepgram" }
      : config;
  }
  async open() {
    this.rotation = setInterval(() => this.rotate(), 240000);
    this.keepalive = setInterval(() => {
      if (this.ready && Date.now() - this.audioAt > 4000)
        this.current?.keepalive();
    }, 5000);
    await this.connect();
  }
  rotate() {
    void this.connect().catch(() => this.onError());
  }
  private async connect() {
    if (this.closed) return;
    const old = this.current;
    if (old) {
      this.retiring.add(old);
      old.finish();
    }
    this.ready = false;
    const next = new SpeechConnection(this.config, {
      result: ({ key: part, text, final }) => {
        if (this.closed || (this.current !== next && !this.retiring.has(next)))
          return;
        const key = `${next.id}:${part}`;
        if (final && this.texts.get(key) === text) return;
        this.activity();
        if (!final) return;
        this.texts.set(key, text);
        const group = this.committed.get(key);
        if (group) {
          const id = randomUUID();
          for (const k of group.keys)
            this.committed.set(k, { id, keys: group.keys });
          this.onText(
            id,
            group.keys.map((k) => this.texts.get(k)).join(" "),
            group.id,
          );
        } else {
          this.pending.add(key);
          this.schedule();
        }
      },
      activity: () => {
        if (!this.closed) this.activity();
      },
      error: () => {
        if (!this.closed) this.onError();
      },
      finished: () => {
        if (this.retiring.delete(next) || this.closed) return;
        if (this.current === next) {
          this.ready = false;
          this.onError();
        }
      },
    });
    this.current = next;
    await next.ready;
    if (this.closed || this.current !== next) {
      next.close();
      return;
    }
    this.ready = true;
    for (const frame of this.backlog) next.send(frame);
    this.backlog = [];
    if (old) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.retiring.delete(old)) {
          old.close();
          if (!this.closed) this.onError();
        }
      }, 5000);
      this.timers.add(timer);
    }
  }
  private activity() {
    this.speechAt = Date.now();
    if (this.silence) clearTimeout(this.silence);
    this.onActivity();
  }
  touch() {
    this.speechAt = Date.now();
    if (this.pending.size) this.schedule();
  }
  private schedule() {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      if (Date.now() - this.speechAt < 1200) return this.schedule();
      const keys = [...this.pending];
      this.pending.clear();
      if (!keys.length || this.closed) return;
      const id = randomUUID();
      for (const key of keys) this.committed.set(key, { id, keys });
      this.onText(id, keys.map((k) => this.texts.get(k)).join(" "));
    }, 1300);
  }
  send(pcm: Buffer) {
    if (this.closed) return;
    this.audioAt = Date.now();
    try {
      if (this.ready) this.current?.send(pcm);
      else if (this.backlog.length < 15) this.backlog.push(pcm);
      else this.onError();
    } catch {
      this.onError();
    }
  }
  close() {
    this.closed = true;
    if (this.silence) clearTimeout(this.silence);
    if (this.rotation) clearInterval(this.rotation);
    if (this.keepalive) clearInterval(this.keepalive);
    this.current?.close();
    for (const socket of this.retiring) socket.close();
    for (const timer of this.timers) clearTimeout(timer);
    this.retiring.clear();
    this.timers.clear();
    this.backlog = [];
  }
}
export async function transcribeWav(
  audio: Buffer,
  signal: AbortSignal,
): Promise<string> {
  const config = speechConfig();
  if (!config.key) throw new Error("语音识别尚未配置");
  signal.throwIfAborted();
  // All callers supply our canonical mono PCM16 / 16k WAV, never arbitrary uploads.
  if (
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.readUInt32LE(24) !== 16000 ||
    audio.readUInt16LE(34) !== 16
  )
    throw new Error("Invalid transcription audio");
  const results = new Map<string, string>();
  let finish!: () => void, fail!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Attach immediately: readiness failures may occur before we reach await ended.
  void ended.catch(() => {});
  const connection = new SpeechConnection(config, {
    result: (r) => {
      if (r.final) results.set(r.key, r.text);
    },
    activity: () => {},
    error: () => fail(new Error("语音识别失败，请重试")),
    finished: () => finish(),
  });
  const abort = () => {
    connection.close();
    fail(new Error("语音识别已取消或超时"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await connection.ready;
    for (let offset = 44; offset < audio.length; offset += 6400) {
      signal.throwIfAborted();
      connection.send(audio.subarray(offset, offset + 6400));
      await new Promise((r) => setTimeout(r, 20));
    }
    connection.finish();
    await ended;
    signal.throwIfAborted();
    return [...results.values()].join(" ");
  } finally {
    connection.close();
    signal.removeEventListener("abort", abort);
  }
}

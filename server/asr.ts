import { randomUUID } from "node:crypto";
import type { UserCaptionUpdate } from "../shared/contracts";
import {
  SpeechConnection,
  speechConfig,
  type SpeechConfig,
} from "./speech-provider";
export type AudioFrame = {
  chunkNo: string;
  startMs: number;
  durationMs: number;
};
export type TranscriptInfo = {
  chunkNos: string[];
  provisional: boolean;
  providerId: string;
  inputTurnId: string;
  revision: number;
};
type Part = {
  text: string;
  final: boolean;
  chunks: string[];
  provider: string;
  captionId: string;
  captionRevision: number;
};
type Group = {
  id: string;
  turn: string;
  revision: number;
  keys: string[];
  text: string;
  evidence: string;
};
export class LiveASR {
  private current: SpeechConnection | null = null;
  private retiring = new Set<SpeechConnection>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private silence: ReturnType<typeof setTimeout> | null = null;
  private rotation: ReturnType<typeof setInterval> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private backlog: { pcm: Buffer; frame?: AudioFrame }[] = [];
  private ready = false;
  private closed = false;
  private speechAt = 0;
  private audioAt = 0;
  private committedAt = 0;
  private parts = new Map<string, Part>();
  private pending = new Set<string>();
  private committed = new Map<string, Group>();
  private timeline = new Map<
    string,
    { ms: number; frames: (AudioFrame & { from: number; to: number })[] }
  >();
  private saving = false;
  private attempt: {
    keys: string[];
    values: Part[];
    group?: Group;
    id: string;
    turn: string;
    revision: number;
    text: string;
  } | null = null;
  private muted = false;
  private connecting = false;
  private config: SpeechConfig;
  constructor(
    private onText: (
      id: string,
      text: string,
      revisionOf?: string,
      info?: TranscriptInfo,
    ) => unknown,
    private onActivity: () => void,
    private onError: () => void,
    endpoint?: string,
    config = speechConfig(),
    private onTiming: (
      stage: string,
      elapsed?: number,
      detail?: Record<string, unknown>,
    ) => void = () => {},
    private onCaption: (update: UserCaptionUpdate) => void = () => {},
  ) {
    this.config = endpoint
      ? { ...config, endpoint, provider: "deepgram" }
      : config;
  }
  async open() {
    this.rotation = setInterval(() => this.rotate(), 240000);
    this.keepalive = setInterval(() => {
      if (!this.ready || Date.now() - this.audioAt < 4000) return;
      try {
        this.current?.keepalive();
        if (this.current && this.config.provider === "dashscope")
          this.timeline.get(this.current.id)!.ms += 200;
      } catch {
        this.onError();
      }
    }, 5000);
    await this.connect();
  }
  rotate() {
    if (!this.connecting) void this.connect().catch(() => this.onError());
  }
  private async connect() {
    if (this.closed) return;
    this.connecting = true;
    const old = this.current;
    if (old) {
      this.retiring.add(old);
      old.finish();
    }
    this.ready = false;
    const next = new SpeechConnection(this.config, {
      result: (r) => {
        if (this.closed || (this.current !== next && !this.retiring.has(next)))
          return;
        const key = next.id + ":" + r.key,
          previous = this.parts.get(key);
        if (previous?.text === r.text && previous.final === r.final) return;
        // Late finals revise their own input; a retired connection never signals new activity.
        if (!r.final && this.current === next && !this.committed.has(key))
          this.activity();
        else if (!previous && this.speechAt <= this.committedAt)
          this.speechAt = Date.now();
        const timeline = this.timeline.get(next.id);
        const chunks =
          Number.isFinite(r.startMs) && Number.isFinite(r.endMs)
            ? (timeline?.frames ?? [])
                .filter((f) => f.to > r.startMs! && f.from < r.endMs!)
                .map((f) => f.chunkNo)
            : (previous?.chunks ?? []);
        this.onTiming(r.final ? "asr_final" : "asr_interim", undefined, {
          request_id: next.id,
        });
        const part = {
          text: r.text,
          final: r.final,
          chunks,
          provider: next.id,
          captionId: previous?.captionId ?? randomUUID(),
          captionRevision: (previous?.captionRevision ?? -1) + 1,
        };
        this.parts.set(key, part);
        // Display updates do not wait for silence or enter the persistence lane.
        this.onCaption({
          utterance_id: part.captionId,
          text: r.text.slice(0, 10000),
          revision: part.captionRevision,
          final: r.final,
        });
        this.pending.add(key);
        this.schedule(this.committed.has(key) ? 0 : undefined);
      },
      activity: () => {
        if (!this.closed && this.current === next) this.activity();
      },
      error: () => {
        if (!this.closed && this.current === next) this.onError();
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
    this.timeline.set(next.id, { ms: 0, frames: [] });
    try {
      await next.ready;
      if (this.closed || this.current !== next) {
        next.close();
        return;
      }
      this.ready = true;
      for (const item of this.backlog) this.transmit(item.pcm, item.frame);
      this.backlog = [];
      if (old) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          if (this.retiring.delete(old)) old.close();
        }, 5000);
        this.timers.add(timer);
      }
    } finally {
      this.connecting = false;
    }
  }
  private activity() {
    this.speechAt = Date.now();
    this.onActivity();
    if (this.pending.size) this.schedule();
  }
  touch() {
    this.speechAt = Date.now();
    if (this.pending.size) this.schedule();
  }
  private schedule(delay?: number) {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(
      () => void this.commit(),
      delay ??
        Math.max(
          0,
          this.speechAt + (this.config.silenceMs ?? 900) - Date.now(),
        ),
    );
  }
  private async commit() {
    if (this.closed || this.saving || (!this.pending.size && !this.attempt))
      return;
    this.saving = true;
    // Revisions stay within the original logical input turn, including after rotation.
    if (!this.attempt) {
      const first = [...this.pending][0],
        group = this.committed.get(first);
      const keys =
        group?.keys ?? [...this.pending].filter((k) => !this.committed.has(k));
      const values = keys.map((k) => this.parts.get(k)!);
      const id = randomUUID();
      this.attempt = {
        keys,
        values,
        group,
        id,
        turn: group?.turn ?? id,
        revision: (group?.revision ?? -1) + 1,
        text: values.map((p) => p.text).join(" "),
      };
    }
    // Keep the exact command identity/content across an unknown database outcome.
    const { keys, values, group, id, turn, revision, text } = this.attempt;
    const chunkNos = [...new Set(values.flatMap((p) => p.chunks))];
    const provisional = values.some((p) => !p.final);
    const evidence = JSON.stringify([provisional, [...chunkNos].sort()]);
    const changed = text !== group?.text || evidence !== group?.evidence;
    try {
      if (changed)
        await this.onText(id, text, group?.id, {
          chunkNos,
          provisional,
          providerId: values[0].provider,
          inputTurnId: turn,
          revision,
        });
      if (!group) this.committedAt = Date.now();
      const next = changed
        ? { id, turn, revision, keys, text, evidence }
        : group!;
      for (let i = 0; i < keys.length; i++) {
        this.committed.set(keys[i], next);
        if (this.parts.get(keys[i]) === values[i]) this.pending.delete(keys[i]);
      }
      this.attempt = null;
    } catch {
      this.onError();
    } finally {
      this.saving = false;
      if (this.pending.size && !this.closed) this.schedule(250);
    }
  }
  mute(value: boolean) {
    this.muted = value;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (!value) return;
    try {
      this.current?.finalize();
    } catch {
      this.onError();
    }
    // DashScope has no Finalize control: send bounded, real-time paced synthetic silence.
    // These samples have no chunk IDs and never become candidate recording or coverage.
    if (this.config.provider === "dashscope") {
      let remaining = Math.ceil((this.config.silenceMs ?? 900) / 100) + 2;
      this.flushTimer = setInterval(() => {
        if (!this.muted || this.closed || remaining-- <= 0) {
          clearInterval(this.flushTimer!);
          this.flushTimer = null;
          return;
        }
        try {
          if (this.ready) this.transmit(Buffer.alloc(3200));
        } catch {
          this.onError();
        }
      }, 100);
    }
    if (this.pending.size) this.schedule();
  }
  private transmit(pcm: Buffer, frame?: AudioFrame) {
    const current = this.current!;
    current.send(pcm);
    if (
      frame &&
      Math.floor(frame.startMs / 1000) !==
        Math.floor((frame.startMs - frame.durationMs) / 1000)
    )
      this.onTiming("asr_send", undefined, {
        request_id: current.id,
        duration_ms: frame.durationMs,
      });
    const timeline = this.timeline.get(current.id)!;
    if (frame)
      timeline.frames.push({
        ...frame,
        from: timeline.ms,
        to: timeline.ms + pcm.length / 32,
      });
    timeline.ms += pcm.length / 32;
  }
  send(pcm: Buffer, frame?: AudioFrame) {
    if (this.closed || this.muted) return;
    this.audioAt = Date.now();
    try {
      if (this.ready) this.transmit(pcm, frame);
      else if (
        this.backlog.reduce((n, f) => n + f.pcm.length, 0) + pcm.length <=
        96000
      )
        this.backlog.push({ pcm, frame });
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
    if (this.flushTimer) clearInterval(this.flushTimer);
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

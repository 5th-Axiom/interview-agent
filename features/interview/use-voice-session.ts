"use client";
import { useEffect, useRef, useState } from "react";
import { capture, Capture, base64, pcmBuffer } from "./audio";
import { mutate } from "./api";
import { DurableQueue } from "@/shared/voice-state";
import type { Session } from "@/shared/contracts";
import { serverEvent } from "@/shared/contracts";
export function useVoiceSession(
  initialSession: Session,
  onEnded: () => void,
  onRefresh: () => void,
) {
  const [state, setState] = useState("recovery"),
    [audioState, setAudioState] = useState("idle"),
    [level, setLevel] = useState(0),
    [subtitle, setSubtitle] = useState(""),
    [error, setError] = useState(""),
    [muted, setMuted] = useState(false),
    [endConfirm, setEndConfirm] = useState(false),
    [controlling, setControlling] = useState(false);
  const controlLock = useRef(false);
  const ws = useRef<WebSocket | null>(null),
    mic = useRef<Capture | null>(null),
    playContext = useRef<AudioContext | null>(null),
    epoch = useRef(0),
    rid = useRef<string | null>(null),
    active = useRef(false),
    mutedRef = useRef(false),
    scene = useRef(0),
    heartbeat = useRef<ReturnType<typeof setInterval> | null>(null),
    retry = useRef<ReturnType<typeof setInterval> | null>(null),
    test = useRef(false),
    session = useRef<Session | null>(initialSession),
    queue = useRef(new DurableQueue<{ event_id: string; text: string }>(100)),
    audioQueue = useRef(new Map<string, Record<string, unknown>>()),
    playbackQueue = useRef(new Map<string, Record<string, any>>()),
    playing = useRef<
      {
        node: AudioBufferSourceNode;
        start: number;
        duration: number;
        chunk_id: string;
        response_id: string;
        started_ms: number;
      }[]
    >([]),
    nextStart = useRef(0),
    lastVad = useRef(0),
    done = useRef(false);
  const endedRef = useRef(onEnded),
    refreshRef = useRef(onRefresh);
  endedRef.current = onEnded;
  refreshRef.current = onRefresh;
  function send(e: Record<string, unknown>) {
    if (ws.current?.readyState === WebSocket.OPEN) {
      if (ws.current.bufferedAmount > 1_000_000) {
        lost("网络积压，已暂停收音，请恢复连接");
        return;
      }
      ws.current.send(JSON.stringify({ ...e, epoch: epoch.current }));
    }
  }
  function acknowledgePlayback(packet: Record<string, any>) {
    const fixed = { ...packet, epoch: epoch.current };
    playbackQueue.current.set(packet.chunk_id, fixed);
    send(fixed);
  }
  async function flushTail() {
    const s = session.current;
    if (!s || (!audioQueue.current.size && !playbackQueue.current.size)) return;
    try {
      const result = await mutate(`sessions/${s.id}/audio-tail`, {
        epoch: epoch.current,
        audio: [...audioQueue.current.values()].map((p) => ({
          ...p,
          epoch: epoch.current,
        })),
        played: [...playbackQueue.current.values()].filter(
          (p) => p.epoch === epoch.current,
        ),
      });
      for (const id of result.audio) audioQueue.current.delete(id);
      for (const id of result.played) playbackQueue.current.delete(id);
    } catch {
      /* The recording explicitly retains unconfirmed/missing ranges. */
    }
  }
  function stopPlayback(ack = true) {
    const context = playContext.current;
    for (const p of playing.current) {
      p.node.onended = null;
      if (ack && context) {
        const ms = Math.max(
          0,
          Math.min(p.duration, (context.currentTime - p.start) * 1000),
        );
        if (ms > 0)
          acknowledgePlayback({
            type: "played",
            response_id: p.response_id,
            chunk_id: p.chunk_id,
            played_ms: ms,
            started_ms: p.started_ms,
          });
      }
      try {
        p.node.stop();
      } catch {}
      p.node.disconnect();
    }
    playing.current = [];
    nextStart.current = 0;
  }
  function interrupt() {
    stopPlayback();
    send({ type: "interrupt", response_id: rid.current });
    rid.current = null;
    setAudioState("listening");
  }
  function stopCapture() {
    mic.current?.stop();
    mic.current = null;
    setLevel(0);
  }
  function disconnect() {
    for (const packet of audioQueue.current.values()) packet.replay = true;
    active.current = false;
    stopPlayback();
    stopCapture();
    if (heartbeat.current) clearInterval(heartbeat.current);
    if (retry.current) clearInterval(retry.current);
    if (ws.current) {
      ws.current.onclose = null;
      ws.current.close();
      ws.current = null;
    }
    if (playContext.current) {
      void playContext.current.close();
      playContext.current = null;
    }
    scene.current++;
  }
  function lost(
    message = "连接已中断，最后一句可能未保存。网络恢复后请点击继续。",
  ) {
    disconnect();
    setState("recovery");
    setAudioState("recovery");
    setError(message);
  }
  async function connect(s: Session, isTest: boolean, takeover = false) {
    disconnect();
    const generation = scene.current;
    session.current = s;
    test.current = isTest;
    done.current = false;
    setError("");
    setState("connecting");
    setAudioState("recovery");
    try {
      const context = new AudioContext();
      await context.resume();
      if (generation !== scene.current) {
        await context.close();
        return;
      }
      playContext.current = context;
      if (!isTest) {
        const captured = await capture(
          (pcm, volume) => {
            if (
              generation !== scene.current ||
              !active.current ||
              mutedRef.current
            )
              return;
            setLevel(volume);
            if (volume > 0.025 && Date.now() - lastVad.current > 350) {
              lastVad.current = Date.now();
              interrupt();
            }
            const chunk_no = crypto.randomUUID();
            if (audioQueue.current.size >= 40) {
              lost("录音尚未保存，已暂停。请恢复连接后重试。");
              return;
            }
            const packet = {
              type: "audio",
              chunk_no,
              pcm: base64(pcm),
              duration_ms: 200,
              start_ms: Math.max(
                0,
                Date.now() - new Date(s.started_at!).getTime() - 200,
              ),
            };
            audioQueue.current.set(chunk_no, packet);
            send(packet);
          },
          () => {
            if (generation === scene.current)
              lost("麦克风或音频设备中断，请检查设备后继续。");
          },
        );
        if (generation !== scene.current) {
          captured.stop();
          return;
        }
        mic.current = captured;
        mic.current.mute(mutedRef.current);
      }
      if (generation !== scene.current) return;
      const { ticket } = await mutate(`sessions/${s.id}/ticket`);
      if (generation !== scene.current) return;
      const socket = new WebSocket(
        process.env.NEXT_PUBLIC_RELAY_URL ??
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:3101`,
      );
      ws.current = socket;
      socket.onopen = () =>
        socket.send(JSON.stringify({ type: "init", ticket, takeover }));
      socket.onclose = () => {
        if (generation === scene.current && !done.current)
          lost("连接已断开或被其他页面接管，请点击继续。");
      };
      socket.onerror = () => setError("暂时无法连接语音服务，请重试。");
      socket.onmessage = (event) => {
        if (generation !== scene.current) return;
        let e;
        try {
          e = serverEvent.parse(JSON.parse(event.data));
        } catch {
          return;
        }
        if (e.type === "ready") {
          epoch.current = e.epoch;
          send({ type: "go" });
          heartbeat.current = setInterval(
            () => send({ type: "heartbeat" }),
            5000,
          );
          retry.current = setInterval(() => {
            if (!active.current) return;
            for (const item of queue.current.batch())
              send({ type: "text", ...item });
            for (const packet of audioQueue.current.values()) send(packet);
            for (const packet of playbackQueue.current.values())
              if (packet.epoch === epoch.current) send(packet);
          }, 2500);
          return;
        }
        if (e.epoch !== epoch.current) return;
        if (e.type === "active") {
          active.current = true;
          setState("active");
          setAudioState("listening");
          refreshRef.current();
          return;
        }
        if (e.type === "thinking") {
          rid.current = e.response_id;
          setAudioState("thinking");
          return;
        }
        if (e.type === "cancel") {
          if (rid.current === e.response_id) {
            stopPlayback();
            rid.current = null;
            setAudioState("listening");
          }
          return;
        }
        if (e.type === "saved") {
          queue.current.acknowledge(e.event_ids);
          return;
        }
        if (e.type === "playback_saved") {
          if (
            (playbackQueue.current.get(e.chunk_id)?.played_ms ?? Infinity) <=
            e.played_ms
          )
            playbackQueue.current.delete(e.chunk_id);
          return;
        }
        if (e.type === "audio_saved") {
          audioQueue.current.delete(e.chunk_no);
          return;
        }
        if (e.type === "error") {
          lost(e.message);
          return;
        }
        if (e.type === "end_confirmation") {
          setEndConfirm(true);
          return;
        }
        if (e.type === "ended") {
          done.current = true;
          stopPlayback();
          void flushTail();
          disconnect();
          setState("ended");
          endedRef.current();
          return;
        }
        if (e.type === "paused") {
          active.current = false;
          stopPlayback();
          stopCapture();
          setState(e.status === "paused" ? "paused" : "recovery");
          setAudioState("paused");
          return;
        }
        if (e.type === "generation_done") {
          if (e.response_id !== rid.current) return;
          if (!playing.current.length) setAudioState("listening");
          return;
        }
        if (e.type === "listening") {
          if (e.response_id === rid.current) setAudioState("listening");
          return;
        }
        if (e.type === "audio") {
          if (e.response_id !== rid.current || !active.current) return;
          const ctx = playContext.current;
          if (!ctx) return;
          if (playing.current.length >= 12) {
            lost("播放队列过长，请恢复后继续。");
            return;
          }
          const node = ctx.createBufferSource();
          node.buffer = pcmBuffer(ctx, e.pcm, e.sample_rate);
          node.connect(ctx.destination);
          const start = Math.max(ctx.currentTime + 0.03, nextStart.current);
          nextStart.current = start + node.buffer.duration;
          const started_ms = Math.max(
            0,
            Date.now() -
              new Date(s.started_at!).getTime() +
              (start - ctx.currentTime) * 1000,
          );
          const item = {
            node,
            start,
            duration: e.duration_ms,
            chunk_id: e.chunk_id,
            response_id: e.response_id,
            started_ms,
          };
          playing.current.push(item);
          node.onended = () => {
            if (generation !== scene.current || rid.current !== e.response_id)
              return;
            acknowledgePlayback({
              type: "played",
              response_id: e.response_id,
              chunk_id: e.chunk_id,
              played_ms: e.duration_ms,
              started_ms,
            });
            playing.current = playing.current.filter((p) => p !== item);
            node.disconnect();
            if (!playing.current.length) setAudioState("listening");
          };
          setTimeout(
            () => {
              if (
                generation === scene.current &&
                rid.current === e.response_id
              ) {
                setAudioState("speaking");
                setSubtitle(e.text);
              }
            },
            Math.max(0, (start - ctx.currentTime) * 1000),
          );
          node.start(start);
        }
      };
    } catch (e) {
      if (generation === scene.current)
        lost(
          e instanceof Error ? e.message : "麦克风无法开启，请检查权限后重试。",
        );
    }
  }
  async function control(action: string, role_id?: string) {
    const s = session.current;
    if (!s || controlLock.current) return;
    controlLock.current = true;
    setControlling(true);
    interrupt();
    active.current = false;
    stopCapture();
    try {
      const next = await mutate<Session>(`sessions/${s.id}/control`, {
        action,
        role_id,
      });
      session.current = next;
      refreshRef.current();
      if (next.status === "ended") {
        done.current = true;
        await flushTail();
        disconnect();
        endedRef.current();
      } else {
        setState(action === "pause" ? "paused" : "recovery");
        setAudioState("paused");
      }
      return next;
    } catch (e) {
      lost((e as Error).message);
      refreshRef.current();
      return undefined;
    } finally {
      controlLock.current = false;
      setControlling(false);
    }
  }
  function mute() {
    const value = !mutedRef.current;
    mutedRef.current = value;
    setMuted(value);
    mic.current?.mute(value);
  }
  function sendText(text: string) {
    if (!text.trim() || !active.current) return;
    interrupt();
    const event_id = crypto.randomUUID();
    try {
      queue.current.add({ event_id, text });
      send({ type: "text", event_id, text });
    } catch (e) {
      lost((e as Error).message);
    }
  }
  useEffect(() => {
    const offline = () =>
      lost("网络已断开，收音与播报已停止。恢复网络后请点击继续。");
    const hidden = () => {
      if (document.hidden && active.current)
        lost("页面进入后台，已暂停声音。返回后请继续面试。");
    };
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      disconnect();
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  return {
    state,
    audioState,
    level,
    subtitle,
    error,
    setError,
    muted,
    mute,
    connect,
    control,
    controlling,
    sendText,
    disconnect,
    interrupt,
    endConfirm,
    setEndConfirm,
  };
}

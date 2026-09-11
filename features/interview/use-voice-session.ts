"use client";
import { useEffect, useRef, useState } from "react";
import { capture, type Capture, base64, pcmBuffer } from "./audio";
import { api, mutate } from "./api";
import { pendingVoice } from "./pending-voice";
import { serverEvent, type Session } from "@/shared/contracts";
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
    [controlling, setControlling] = useState(false),
    [unsavedMs, setUnsavedMs] = useState(0);
  const pending = useRef(pendingVoice(initialSession.id));
  const ws = useRef<WebSocket | null>(null),
    mic = useRef<Capture | null>(null),
    playContext = useRef<AudioContext | null>(null),
    epoch = useRef(pending.current.epoch),
    rid = useRef<string | null>(null),
    active = useRef(false),
    mutedRef = useRef(false),
    scene = useRef(0),
    session = useRef(initialSession),
    done = useRef(false),
    controlLock = useRef(false),
    disconnecting = useRef(false),
    lastVad = useRef(0),
    lastFrameAt = useRef(0),
    generationDone = useRef(false),
    muteLock = useRef(false);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null),
    retry = useRef<ReturnType<typeof setInterval> | null>(null),
    nextStart = useRef(0);
  type Playing = {
    node: AudioBufferSourceNode;
    start: number;
    duration: number;
    chunk_id: string;
    response_id: string;
    started_ms: number;
    source_epoch: number;
    receipt?: string;
  };
  const playing = useRef<Playing[]>([]),
    endedRef = useRef(onEnded),
    refreshRef = useRef(onRefresh);
  endedRef.current = onEnded;
  refreshRef.current = onRefresh;
  useEffect(() => {
    if (!active.current || initialSession.epoch === epoch.current)
      session.current = initialSession;
  }, [initialSession]);
  const backlog = () =>
    [...pending.current.audio.values()].reduce((n, p) => n + p.duration_ms, 0);
  function send(e: Record<string, unknown>) {
    const socket = ws.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 1_000_000) {
      if (!disconnecting.current) {
        const generation = scene.current;
        setTimeout(() => {
          if (generation === scene.current)
            lost("网络积压，已暂停收音，请恢复连接");
        }, 0);
      }
      return false;
    }
    socket.send(JSON.stringify({ ...e, epoch: epoch.current }));
    return true;
  }
  function telemetry(stage: string, elapsed_ms?: number, response_id?: string) {
    send({
      type: "telemetry",
      stage,
      elapsed_ms,
      response_id,
      frame_seq: pending.current.frame,
    });
  }
  function acknowledgePlayback(packet: Record<string, any>) {
    const previous = pending.current.played.get(packet.chunk_id);
    if (previous && previous.played_ms > packet.played_ms) return;
    const fixed = { ...packet, epoch: packet.source_epoch ?? epoch.current };
    pending.current.played.set(packet.chunk_id, fixed);
    send(fixed);
  }
  async function syncPending(tail = false) {
    const store = pending.current;
    const audio = [...store.audio.values()],
      played = [...store.played.values()],
      text = store.text.batch(),
      inputs = [...store.inputs.values()];
    if (!audio.length && !played.length && !text.length && !inputs.length)
      return;
    const result = await api(
      `sessions/${session.current.id}/${tail ? "audio-tail" : "audio-sync"}`,
      { epoch: epoch.current, audio, played, text, inputs },
    );
    for (const id of result.audio) store.audio.delete(id);
    for (const id of result.played) {
      const fixed = played.find((p) => p.chunk_id === id);
      if (fixed && store.played.get(id)?.played_ms <= fixed.played_ms)
        store.played.delete(id);
    }
    store.text.acknowledge(result.text ?? []);
    for (const id of result.inputs ?? []) store.inputs.delete(id);
    setUnsavedMs(backlog());
  }
  function stopPlayback(ack = true) {
    const context = playContext.current;
    const current = playing.current;
    playing.current = [];
    nextStart.current = 0;
    for (const p of current) {
      p.node.onended = null;
      if (ack && context) {
        const ms = Math.max(
          0,
          Math.min(p.duration, (context.currentTime - p.start) * 1000),
        );
        acknowledgePlayback({
          type: "played",
          response_id: p.response_id,
          chunk_id: p.chunk_id,
          played_ms: ms,
          started_ms: p.started_ms,
          source_epoch: p.source_epoch,
          receipt: p.receipt,
        });
      }
      try {
        p.node.stop();
      } catch {}
      p.node.disconnect();
    }
  }
  function interrupt() {
    if (!rid.current && !playing.current.length) return;
    const started = performance.now(),
      response = rid.current;
    stopPlayback();
    send({ type: "interrupt", response_id: response });
    rid.current = null;
    setAudioState("listening");
    telemetry(
      "local_cancel",
      performance.now() - started,
      response ?? undefined,
    );
  }
  function stopCapture() {
    if (mic.current) telemetry("capture_stop");
    mic.current?.stop();
    mic.current = null;
    setLevel(0);
  }
  function disconnect() {
    if (disconnecting.current) return;
    disconnecting.current = true;
    active.current = false;
    // Detach transport before stopping nodes: backpressure cannot recursively disconnect through receipts.
    const socket = ws.current;
    ws.current = null;
    stopPlayback();
    stopCapture();
    rid.current = null;
    for (const packet of pending.current.audio.values()) packet.replay = true;
    if (heartbeat.current) clearInterval(heartbeat.current);
    if (retry.current) clearInterval(retry.current);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    if (playContext.current) {
      void playContext.current.close();
      playContext.current = null;
    }
    scene.current++;
    disconnecting.current = false;
  }
  function lost(
    message = "连接已中断，收音与播放已停止。请点击继续补传待保存内容。",
  ) {
    disconnect();
    setState("recovery");
    setAudioState("recovery");
    setError(message);
    setUnsavedMs(backlog());
  }
  function inputState(value: boolean) {
    const packet = {
      type: "input_state",
      event_id: crypto.randomUUID(),
      epoch: epoch.current,
      muted: value,
      frame_seq: pending.current.frame,
      monotonic_ms: performance.now(),
    };
    pending.current.inputs.set(packet.event_id, packet);
    send(packet);
  }
  async function finish() {
    done.current = true;
    active.current = false;
    stopPlayback();
    stopCapture();
    try {
      await syncPending(true);
    } catch {
      setError("部分片段尚未确认保存，请保留此页面并重试。");
      setState("recovery");
      done.current = false;
      return;
    }
    disconnect();
    setState("ended");
    endedRef.current();
  }
  async function connect(s: Session, isTest: boolean, takeover = false) {
    disconnect();
    const generation = scene.current;
    session.current = s;
    done.current = false;
    setError("");
    setState("connecting");
    setAudioState("saving");
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
          (pcm, volume, final) => {
            if (
              generation !== scene.current ||
              !active.current ||
              (mutedRef.current && !final)
            )
              return;
            const duration = pcm.byteLength / 32;
            if (backlog() + duration > 8000) {
              lost("录音尚未保存，已暂停。点击继续后会先补传再开启麦克风。");
              return;
            }
            const now = Date.now();
            if (lastFrameAt.current && now - lastFrameAt.current > 1000)
              telemetry("capture_gap", now - lastFrameAt.current);
            lastFrameAt.current = now;
            const packet = {
              type: "audio",
              chunk_no: crypto.randomUUID(),
              frame_seq: ++pending.current.frame,
              epoch: epoch.current,
              source_epoch: epoch.current,
              pcm: base64(pcm),
              duration_ms: duration,
              start_ms: Math.max(
                0,
                now - new Date(s.started_at!).getTime() - duration,
              ),
              replay: false,
            };
            pending.current.audio.set(packet.chunk_no, packet);
            if (packet.frame_seq % 5 === 0) telemetry("capture_end", duration);
            if (send(packet) && packet.frame_seq % 5 === 0)
              telemetry("audio_send");
            setUnsavedMs(backlog());
            if (backlog() >= 8000)
              lost("录音尚未保存，已暂停。点击继续后会先补传再开启麦克风。");
          },
          () => {
            if (generation === scene.current)
              lost("麦克风或音频设备中断，请检查设备后继续。");
          },
          (volume, voiced) => {
            if (
              generation !== scene.current ||
              !active.current ||
              mutedRef.current
            )
              return;
            setLevel(volume);
            if (voiced && performance.now() - lastVad.current > 120) {
              lastVad.current = performance.now();
              interrupt();
              send({
                type: "voice_activity",
                frame_seq: pending.current.frame,
                monotonic_ms: performance.now(),
              });
            }
          },
        );
        if (generation !== scene.current) {
          captured.stop();
          return;
        }
        mic.current = captured;
        await captured.mute(true);
      }
      if (generation !== scene.current) return;
      if (s.status === "ended") {
        await finish();
        return;
      }
      const { ticket } = await mutate(`sessions/${s.id}/ticket`);
      if (generation !== scene.current) return;
      const socket = new WebSocket(
        process.env.NEXT_PUBLIC_RELAY_URL ??
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:3101`,
      );
      ws.current = socket;
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ type: "init", ticket, takeover, protocol: 2 }),
        );
      socket.onclose = () => {
        if (
          generation === scene.current &&
          !done.current &&
          !controlLock.current
        )
          lost("连接已断开或被其他页面接管，请点击继续。");
      };
      socket.onerror = () => setError("暂时无法连接语音服务，请重试。");
      socket.onmessage = (event) => {
        if (generation !== scene.current) return;
        const parsed = serverEvent.safeParse(JSON.parse(event.data));
        if (!parsed.success) {
          lost("语音服务响应格式异常，请重试。");
          return;
        }
        const e = parsed.data;
        if (e.type === "ready") {
          epoch.current = e.epoch;
          pending.current.epoch = e.epoch;
          session.current = {
            ...session.current,
            epoch: e.epoch,
            version: e.version ?? session.current.version,
          };
          heartbeat.current = setInterval(() => {
            send({ type: "heartbeat" });
            send({ type: "ping", client_ms: Date.now() });
          }, 5000);
          // Drain old epochs through the authenticated evidence endpoint before GO and before new capture.
          void syncPending()
            .then(() => {
              if (generation === scene.current) send({ type: "go" });
            })
            .catch((e) => lost(e.message));
          retry.current = setInterval(() => {
            if (!active.current) return;
            for (const item of pending.current.text.batch())
              send({ type: "text", ...item });
            for (const packet of pending.current.audio.values())
              send({ ...packet, replay: true });
            for (const packet of pending.current.played.values()) send(packet);
            for (const packet of pending.current.inputs.values())
              if (packet.epoch === epoch.current) send(packet);
            if (pending.current.played.size > 40)
              lost("播放确认暂未保存，请点击继续补传。");
          }, 2000);
          return;
        }
        if (e.epoch !== epoch.current) return;
        if (e.type === "pong") {
          const now = Date.now(),
            rtt = now - e.client_ms;
          send({
            type: "telemetry",
            stage: "clock_sync",
            elapsed_ms: rtt,
            clock_error_ms: rtt / 2,
            clock_offset_ms: e.server_ms - (e.client_ms + now) / 2,
          });
          return;
        }
        if (e.type === "active") {
          active.current = true;
          session.current = {
            ...session.current,
            version: e.version ?? session.current.version,
            epoch: e.epoch,
            status: "active",
          };
          setState("active");
          setAudioState("listening");
          inputState(mutedRef.current);
          lastFrameAt.current = 0;
          telemetry("capture_start");
          void mic.current
            ?.mute(mutedRef.current)
            .catch((e) => lost(e.message));
          refreshRef.current();
          return;
        }
        if (e.type === "stage") {
          if (!playing.current.length) setAudioState(e.stage);
          return;
        }
        if (e.type === "thinking") {
          rid.current = e.response_id;
          generationDone.current = false;
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
          pending.current.text.acknowledge(e.event_ids);
          for (const id of e.event_ids) pending.current.inputs.delete(id);
          return;
        }
        if (e.type === "playback_saved") {
          if (
            (pending.current.played.get(e.chunk_id)?.played_ms ?? Infinity) <=
            e.played_ms
          )
            pending.current.played.delete(e.chunk_id);
          return;
        }
        if (e.type === "audio_saved") {
          pending.current.audio.delete(e.chunk_no);
          setUnsavedMs(backlog());
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
          void finish();
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
          if (rid.current === e.response_id) {
            generationDone.current = true;
            if (!playing.current.length) {
              rid.current = null;
              setAudioState("listening");
            }
          }
          return;
        }
        if (e.type === "listening") {
          if (rid.current === e.response_id) {
            rid.current = null;
            setAudioState("listening");
          }
          return;
        }
        if (e.type === "audio") {
          if (e.response_id !== rid.current || !active.current) return;
          const ctx = playContext.current;
          if (!ctx) return;
          if (
            Math.max(0, nextStart.current - ctx.currentTime) * 1000 +
              e.duration_ms >
            4000
          ) {
            lost("播放队列过长，请恢复后继续。");
            return;
          }
          const node = ctx.createBufferSource();
          node.buffer = pcmBuffer(ctx, e.pcm, e.sample_rate);
          node.connect(ctx.destination);
          const start = Math.max(
            ctx.currentTime + (playing.current.length ? 0.02 : 0.14),
            nextStart.current,
          );
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
            source_epoch: e.epoch,
            receipt: e.receipt,
          };
          playing.current.push(item);
          node.onended = () => {
            if (generation !== scene.current || rid.current !== e.response_id)
              return;
            telemetry("play_end", e.duration_ms, e.response_id);
            acknowledgePlayback({
              type: "played",
              response_id: e.response_id,
              chunk_id: e.chunk_id,
              played_ms: e.duration_ms,
              started_ms,
              source_epoch: e.epoch,
              receipt: e.receipt,
            });
            playing.current = playing.current.filter((p) => p !== item);
            node.disconnect();
            if (!playing.current.length) {
              setAudioState("listening");
              if (generationDone.current) rid.current = null;
            }
          };
          setTimeout(
            () => {
              if (
                generation === scene.current &&
                rid.current === e.response_id
              ) {
                setAudioState("speaking");
                setSubtitle(e.text);
                telemetry("play_start", undefined, e.response_id);
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
    if (controlLock.current) return;
    controlLock.current = true;
    setControlling(true);
    interrupt();
    try {
      await mic.current?.mute(true);
      active.current = false;
      stopCapture();
      const s = session.current;
      const next = await mutate<Session>(`sessions/${s.id}/control`, {
        action,
        role_id,
        expected_version: s.version,
        expected_epoch: epoch.current || s.epoch,
      });
      session.current = next;
      disconnect();
      refreshRef.current();
      if (next.status === "ended") await finish();
      else {
        await syncPending();
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
  async function mute() {
    if (muteLock.current) return;
    muteLock.current = true;
    const value = !mutedRef.current;
    mutedRef.current = value;
    setMuted(value);
    try {
      await mic.current?.mute(value);
      inputState(value);
    } catch (e) {
      lost((e as Error).message);
    } finally {
      muteLock.current = false;
    }
  }
  function sendText(text: string) {
    if (!text.trim() || !active.current) return;
    interrupt();
    const event_id = crypto.randomUUID();
    try {
      pending.current.text.add({ event_id, text });
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
    const unload = (event: BeforeUnloadEvent) => {
      if (
        pending.current.audio.size ||
        pending.current.played.size ||
        pending.current.text.size
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("offline", offline);
    window.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      disconnect();
      window.removeEventListener("offline", offline);
      window.removeEventListener("beforeunload", unload);
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
    unsavedMs,
  };
}

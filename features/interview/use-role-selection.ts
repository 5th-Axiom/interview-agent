"use client";
import { useEffect, useRef, useState } from "react";
import { capture, base64, pcmBuffer } from "./audio";
import { mutate } from "./api";
export function useRoleSelection(
  enabled: boolean,
  testMode: boolean,
  entry: string,
  onSelect: (id: string, text: string) => void,
) {
  const [message, setMessage] = useState("请说出想面试的岗位"),
    [testText, setTestText] = useState("");
  const history = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  async function select(text: string) {
    const r = await mutate("selection", {
      entry,
      text,
      history: history.current,
    });
    history.current = [
      ...history.current,
      { role: "user", content: r.text },
      { role: "assistant", content: r.message },
    ].slice(-6) as typeof history.current;
    setMessage(r.message);
    if (r.role_id) callback.current(r.role_id, r.text);
  }
  useEffect(() => {
    if (!enabled || testMode) return;
    let closed = false,
      busy = false,
      frames: ArrayBuffer[] = [],
      voiced = false,
      lastVoice = 0;
    let cap: Awaited<ReturnType<typeof capture>> | null = null;
    const abort = new AbortController();
    let playback: AudioContext | null = null;
    const submit = async () => {
      if (busy || !frames.length) return;
      busy = true;
      const data = frames;
      frames = [];
      voiced = false;
      const buf = new Uint8Array(data.reduce((n, b) => n + b.byteLength, 0));
      let offset = 0;
      for (const f of data) {
        buf.set(new Uint8Array(f), offset);
        offset += f.byteLength;
      }
      try {
        setMessage("正在理解你的岗位意向…");
        const r = await mutate(
          "selection",
          { entry, pcm: base64(buf.buffer), history: history.current },
          crypto.randomUUID(),
          abort.signal,
        );
        if (closed) return;
        history.current = [
          ...history.current,
          { role: "user", content: r.text },
          { role: "assistant", content: r.message },
        ].slice(-6) as typeof history.current;
        setMessage(r.message);
        if (r.role_id) {
          cap?.stop();
          callback.current(r.role_id, r.text);
        } else if (r.pcm) {
          await cap?.mute(true);
          playback = new AudioContext();
          await playback.resume();
          if (closed) {
            await playback.close();
            return;
          }
          const node = playback.createBufferSource();
          node.buffer = pcmBuffer(playback, r.pcm, 24000);
          node.connect(playback.destination);
          setMessage("AI 正在说话");
          await new Promise<void>((resolve) => {
            node.onended = () => resolve();
            abort.signal.addEventListener(
              "abort",
              () => {
                try {
                  node.stop();
                } catch {}
                resolve();
              },
              { once: true },
            );
            node.start();
          });
          await playback.close();
          playback = null;
          if (!closed) {
            await cap?.mute(false);
            setMessage(r.message);
          }
        }
      } catch {
        if (!closed) setMessage("语音选岗暂时不可用，请直接点击岗位。");
      } finally {
        if (playback && playback.state !== "closed")
          await playback.close().catch(() => {});
        playback = null;
        if (!closed) await cap?.mute(false).catch(() => {});
        busy = false;
      }
    };
    void capture(
      (pcm, level) => {
        if (closed || busy) return;
        if (level > 0.02) {
          voiced = true;
          lastVoice = Date.now();
          setMessage("正在聆听");
        }
        if (voiced) frames.push(pcm);
        if (voiced && (Date.now() - lastVoice > 1400 || frames.length >= 50))
          void submit();
      },
      () => setMessage("麦克风已断开，可以直接点击岗位。"),
    )
      .then((c) => {
        cap = c;
        if (closed) c.stop();
      })
      .catch(() => setMessage("麦克风不可用，可以直接点击岗位。"));
    return () => {
      closed = true;
      abort.abort();
      if (playback && playback.state !== "closed") void playback.close();
      cap?.stop();
    };
  }, [enabled, testMode, entry]);
  return { message, testText, setTestText, select };
}

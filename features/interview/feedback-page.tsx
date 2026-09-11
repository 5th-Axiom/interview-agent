"use client";
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { CheckCircle2, Mic, Square, Star } from "lucide-react";
import { Shell } from "@/components/business/shell";
import {
  Button,
  Dialog,
  Field,
  FieldGroup,
  Notice,
  Tag,
} from "@/components/base/ui";
import { api, mutate } from "./api";
import { capture, Capture, base64 } from "./audio";
import { feedbackTags } from "@/shared/contracts";
export function FeedbackPage({ id }: { id: string }) {
  const router = useRouter();
  const detail = useQuery({
    queryKey: ["feedback", id],
    queryFn: () => api(`sessions/${id}`),
    refetchInterval: 5000,
  });
  const [rating, setRating] = useState<number | null>(null),
    [tags, setTags] = useState<string[]>([]),
    [text, setText] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false),
    [done, setDone] = useState(false),
    [skipConfirm, setSkipConfirm] = useState(false),
    [retryAudio, setRetryAudio] = useState<ArrayBuffer | null>(null);
  const [audioIds, setAudioIds] = useState<string[]>([]);
  const captureGeneration = useRef(0);
  const mic = useRef<Capture | null>(null),
    frames = useRef<ArrayBuffer[]>([]),
    alive = useRef(true),
    lock = useRef(false),
    recordingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      captureGeneration.current++;
      mic.current?.stop();
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await detail.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save(skipped = false) {
    await run(async () => {
      await mutate(
        `sessions/${id}/feedback`,
        skipped
          ? { skipped: true }
          : { rating, tags, text, audio_ids: audioIds },
      );
      setDone(true);
    });
  }
  function cancelRecord() {
    captureGeneration.current++;
    recordingRef.current = false;
    mic.current?.stop();
    mic.current = null;
    frames.current = [];
    setRecording(false);
  }
  async function transcribe(buffer: ArrayBuffer) {
    setRetryAudio(buffer);
    await run(async () => {
      const result = await mutate(`sessions/${id}/feedback-audio`, {
        pcm: base64(buffer),
      });
      if (!alive.current) return;
      if (result.chunk_id)
        setAudioIds((ids) => [...new Set([...ids, result.chunk_id])]);
      if (result.text) setText((t) => t + (t ? "\n" : "") + result.text);
      setRetryAudio(null);
      setNotice(
        result.text
          ? "转写完成，可修改后提交。"
          : result.testMode
            ? "测试录音已保存；测试模式不生成转写文字。"
            : "没有识别到清晰的文字，请检查麦克风后重新录制，也可以直接填写说明。",
      );
    });
  }
  async function stopRecord() {
    if (!recordingRef.current) return;
    captureGeneration.current++;
    recordingRef.current = false;
    mic.current?.stop();
    mic.current = null;
    setRecording(false);
    const length = frames.current.reduce((n, b) => n + b.byteLength, 0),
      buffer = new Uint8Array(length);
    let offset = 0;
    for (const frame of frames.current) {
      buffer.set(new Uint8Array(frame), offset);
      offset += frame.byteLength;
    }
    frames.current = [];
    await transcribe(buffer.buffer);
  }
  async function record() {
    if (recordingRef.current) return;
    const generation = ++captureGeneration.current;
    recordingRef.current = true;
    setRecording(true);
    setError("");
    frames.current = [];
    try {
      const captured = await capture(
        (pcm) => {
          if (!recordingRef.current || generation !== captureGeneration.current)
            return;
          frames.current.push(pcm);
          if (frames.current.length >= 100) void stopRecord();
        },
        () => {
          if (generation !== captureGeneration.current) return;
          captureGeneration.current++;
          recordingRef.current = false;
          mic.current?.stop();
          setRecording(false);
          setError("录音设备中断，请重新录制。");
        },
      );
      if (
        !alive.current ||
        !recordingRef.current ||
        generation !== captureGeneration.current
      )
        captured.stop();
      else mic.current = captured;
    } catch {
      if (generation !== captureGeneration.current) return;
      recordingRef.current = false;
      setRecording(false);
      setError("无法开启麦克风，请检查权限。");
    }
  }
  if (detail.isPending)
    return (
      <Shell>
        <div className="loading">正在读取反馈…</div>
      </Shell>
    );
  if (detail.error)
    return (
      <Shell>
        <div className="candidate-wrap">
          <Notice error>{detail.error.message}</Notice>
          <Button
            onClick={() =>
              router.push(
                `/interview?entry=${encodeURIComponent(detail.data?.session?.entry_id ?? new URLSearchParams(location.search).get("entry") ?? "demo")}`,
              )
            }
          >
            返回面试入口
          </Button>
        </div>
      </Shell>
    );
  const s = detail.data.session;
  const retry = detail.data.retries[0];
  const finished = done || !!detail.data.feedback;
  const count = Array.from(text).length;
  const hasContent = !!rating || tags.length > 0 || !!text.trim();
  const title =
    s.end_reason === "completed"
      ? "面试已完成"
      : s.end_reason === "timeout"
        ? "面试时间已到，本次面试已结束"
        : "本次面试已结束";
  return (
    <Shell>
      <Dialog
        open={skipConfirm}
        onClose={() => setSkipConfirm(false)}
        title="放弃当前反馈？"
      >
        <p>已填写的内容和正在录制的语音不会作为反馈提交。</p>
        <div className="row">
          <Button onClick={() => setSkipConfirm(false)}>继续填写</Button>
          <Button
            variant="primary"
            onClick={() => {
              cancelRecord();
              setSkipConfirm(false);
              void save(true);
            }}
          >
            放弃并跳过
          </Button>
        </div>
      </Dialog>
      <div className="candidate-wrap">
        <div className="feedback">
          <h1>
            {finished
              ? detail.data.feedback?.skipped
                ? "本次面试已结束，你可以关闭页面了"
                : "感谢反馈，你可以关闭页面了"
              : title}
          </h1>
          <p className="lead">
            {finished
              ? "本次交流已保存，招聘团队会认真查看。"
              : "感谢你的时间，后续安排将由招聘方通知。愿意告诉我们，这次交流体验如何？"}
          </p>
          <div className="stack">
            {!finished ? (
              <section className="section stack">
                <FieldGroup label="整体体验（选填）">
                  <div className="rating">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Button
                        className={rating === n ? "selected" : ""}
                        key={n}
                        onClick={() => setRating(n)}
                        aria-label={`${n} 星`}
                        aria-pressed={rating === n}
                      >
                        <Star
                          size={18}
                          fill={rating && rating >= n ? "currentColor" : "none"}
                        />
                        {n}
                      </Button>
                    ))}
                  </div>
                  <div className="row between small muted">
                    <span>不太顺畅</span>
                    <span>很顺畅</span>
                  </div>
                </FieldGroup>
                <FieldGroup label="遇到了哪些问题？（选填）">
                  <div className="chips">
                    {feedbackTags.map((t) => (
                      <Button
                        key={t}
                        className={tags.includes(t) ? "selected" : ""}
                        aria-pressed={tags.includes(t)}
                        onClick={() =>
                          setTags(
                            tags.includes(t)
                              ? tags.filter((x) => x !== t)
                              : [...tags, t],
                          )
                        }
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                </FieldGroup>
                <Field label="补充说明（选填）">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="哪里可以做得更好？你的建议对我们很有帮助。"
                    aria-describedby="feedback-count"
                    aria-invalid={count > 500}
                  />
                </Field>
                <p
                  id="feedback-count"
                  className="small"
                  role={count > 500 ? "alert" : undefined}
                >
                  {count} / 500 字
                  {count > 500 ? "，请精简后提交，已输入内容会保留。" : ""}
                </p>
                <div className="row">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      recording ? void stopRecord() : void record()
                    }
                  >
                    {recording ? <Square /> : <Mic />}
                    {recording ? "停止并转写" : "录制语音说明"}
                  </Button>
                  {recording && (
                    <Button onClick={cancelRecord}>取消录音</Button>
                  )}
                  {retryAudio && !recording && (
                    <Button
                      disabled={busy}
                      onClick={() => void transcribe(retryAudio)}
                    >
                      重试转写
                    </Button>
                  )}
                  <span className="small muted">最多 20 秒</span>
                </div>
                <Notice>{notice}</Notice>
                <div className="row">
                  <Button
                    variant="primary"
                    disabled={busy || recording || !hasContent || count > 500}
                    onClick={() => void save()}
                  >
                    {busy ? "保存中…" : "提交反馈"}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => {
                      if (
                        hasContent ||
                        recording ||
                        retryAudio ||
                        audioIds.length
                      )
                        setSkipConfirm(true);
                      else void save(true);
                    }}
                  >
                    跳过，直接完成
                  </Button>
                </div>
              </section>
            ) : (
              <section className="section row">
                <CheckCircle2 />
                <div>
                  <h3>本次面试已保存</h3>
                  <p className="small">
                    反馈只用于改进体验，不会进入面试能力评估。
                  </p>
                </div>
              </section>
            )}
            <Notice error>{error}</Notice>
            <section className="section stack">
              <div>
                <h2>希望再聊一次？</h2>
                <p className="small">
                  如果设备或环境影响了发挥，可以申请再次面试。招聘团队审核通过后，即可开启新一轮。
                </p>
              </div>
              {retry && (
                <div className="notice">
                  <div className="row">
                    <Tag status={retry.status} />
                    {retry.used_by && <span className="small">资格已使用</span>}
                  </div>
                  {retry.review_reason && (
                    <p className="small">审核说明：{retry.review_reason}</p>
                  )}
                </div>
              )}
              {retry?.status === "approved" && !retry.used_by ? (
                <Button
                  variant="primary"
                  onClick={() =>
                    router.push(
                      `/interview?entry=${encodeURIComponent(detail.data?.session?.entry_id ?? new URLSearchParams(location.search).get("entry") ?? "demo")}`,
                    )
                  }
                >
                  进入新一轮面试
                </Button>
              ) : retry?.used_by ? (
                <Button
                  onClick={() =>
                    router.push(
                      `/interview?entry=${encodeURIComponent(detail.data?.session?.entry_id ?? new URLSearchParams(location.search).get("entry") ?? "demo")}`,
                    )
                  }
                >
                  查看最新面试
                </Button>
              ) : (
                retry?.status !== "pending" && (
                  <>
                    <Field label="申请原因（选填）">
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="请简要说明为什么希望再次面试"
                        maxLength={1000}
                      />
                    </Field>
                    <Button
                      disabled={busy || recording}
                      onClick={() =>
                        void run(async () => {
                          await mutate(`sessions/${id}/retry`, { reason });
                          setReason("");
                        })
                      }
                    >
                      提交再次面试申请
                    </Button>
                  </>
                )
              )}
            </section>
          </div>
        </div>
      </div>
    </Shell>
  );
}

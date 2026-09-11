"use client";
import Link from "next/link";
import { useEffect, useState, useRef } from "react";
import { ArrowLeft, Headphones, RefreshCw } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { Button, Dialog, Field, Notice, Tag } from "@/components/base/ui";
import { useAdminQuery } from "./use-admin";
import { mutate } from "./api";
import type { InterviewEvent } from "@/shared/contracts";
import { useReviewDraft, useUnsavedChanges } from "./use-unsaved-changes";
export function RecordDetail({ id }: { id: string }) {
  const q = useAdminQuery("record", `sessions/${id}`, 4000);
  const [prompt, setPrompt] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [url, setUrl] = useState(""),
    [confirmAssessment, setConfirmAssessment] = useState(false),
    [confirmRetry, setConfirmRetry] = useState<{
      id: string;
      status: "approved" | "rejected";
      reason: string;
    } | null>(null),
    [feedbackUrls, setFeedbackUrls] = useState<string[]>([]);
  const [review, setReview] = useReviewDraft(id);
  const leave = useUnsavedChanges(
    !!review.trim() ||
      (!!q.data &&
        prompt !==
          (q.data.session.assessment_prompt ??
            q.data.assessments[0]?.prompt ??
            "")),
  );
  const editingPrompt = useRef(false);
  const promptRef = useRef(prompt),
    reviewRef = useRef(review),
    reasonRef = useRef(reason);
  promptRef.current = prompt;
  reviewRef.current = review;
  reasonRef.current = reason;
  const lock = useRef(false);
  const [promptVersion, setPromptVersion] = useState(0);
  const latest = q.data?.assessments?.[0];
  const assessment =
    q.data?.assessments?.find((a: any) => a.status === "ready") ?? latest;
  useEffect(() => {
    if (q.data && !editingPrompt.current) {
      setPrompt(q.data.session.assessment_prompt ?? latest?.prompt ?? "");
      setPromptVersion(q.data.session.assessment_prompt_version);
    }
  }, [q.data?.session.assessment_prompt_version, latest?.version]);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (q.isPending)
    return (
      <Shell admin>
        <div className="loading">正在读取面试记录…</div>
      </Shell>
    );
  if (!q.data)
    return (
      <Shell admin>
        <Notice error>{q.error?.message}</Notice>
        <Button onClick={() => void q.refetch()}>重试</Button>
      </Shell>
    );
  const { session: s, events, retries, reviews, recording, feedback } = q.data;
  const retry = retries.find((r: any) => r.status === "pending");
  const speech = events.filter((e: InterviewEvent) =>
    [
      "utterance",
      "transcription_recovery",
      "generated",
      "role_selected",
    ].includes(e.kind),
  );
  const sourceIds = new Set(
    q.data.assessments.flatMap(
      (a: any) => a.result?.items?.flatMap((item: any) => item.sources) ?? [],
    ),
  );
  const auxiliary = events.filter(
    (e: InterviewEvent) =>
      sourceIds.has(e.event_id) &&
      !speech.some((v: InterviewEvent) => v.event_id === e.event_id),
  );
  return (
    <Shell admin>
      <Dialog open={leave.open} onClose={leave.cancel} title="有尚未保存的修改">
        <p>评估要求或人工复核意见尚未保存，是否继续编辑？</p>
        <div className="row">
          <Button onClick={leave.cancel}>继续编辑</Button>
          <Button
            variant="danger"
            onClick={() => {
              setReview("");
              leave.discard();
            }}
          >
            放弃修改
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={!!confirmRetry}
        onClose={() => !busy && setConfirmRetry(null)}
        title={
          confirmRetry?.status === "approved"
            ? "通过再次面试申请？"
            : "拒绝再次面试申请？"
        }
      >
        <p>
          {confirmRetry?.status === "approved"
            ? "候选人将获得一次新面试资格，原面试记录会保留。"
            : "候选人会在反馈页看到以下拒绝说明。"}
        </p>
        {confirmRetry?.reason && <p>{confirmRetry.reason}</p>}
        <div className="row">
          <Button disabled={busy} onClick={() => setConfirmRetry(null)}>
            取消
          </Button>
          <Button
            variant={confirmRetry?.status === "approved" ? "primary" : "danger"}
            disabled={busy}
            onClick={() => {
              const decision = confirmRetry!;
              void run(async () => {
                await mutate(`sessions/${id}/retry-review`, {
                  retry_id: decision.id,
                  status: decision.status,
                  reason: decision.reason,
                });
                if (reasonRef.current === decision.reason) setReason("");
                setConfirmRetry(null);
                setNotice(
                  decision.status === "approved"
                    ? "已通过，下次进入可兑换一次新面试。"
                    : "已拒绝，候选人可以查看审核说明。",
                );
              });
            }}
          >
            {confirmRetry?.status === "approved" ? "确认通过" : "确认拒绝"}
          </Button>
        </div>
        <Notice error>{confirmRetry ? error : ""}</Notice>
      </Dialog>
      <Dialog
        open={confirmAssessment}
        onClose={() => setConfirmAssessment(false)}
        title="按当前要求重新生成评估？"
      >
        <p>将创建新版本，旧草稿和人工复核意见会保留。</p>
        <div className="row">
          <Button onClick={() => setConfirmAssessment(false)}>取消</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setConfirmAssessment(false);
              void run(async () => {
                await mutate(`sessions/${id}/assessment`, {
                  prompt,
                  expected_prompt_version: promptVersion,
                  expected_assessment_version: s.assessment_version,
                });
                editingPrompt.current = promptRef.current !== prompt;
                setPromptVersion(promptVersion + 1);
                setNotice("已安排重新生成，原评估和人工意见仍保留。");
              });
            }}
          >
            确认重新生成
          </Button>
        </div>
      </Dialog>
      <Link className="back" href="/admin/interviews">
        <ArrowLeft />
        返回面试记录
      </Link>
      <header className="page-heading">
        <div>
          <h1>{s.name} · 面试记录</h1>
          <p>
            {new Date(s.started_at).toLocaleString("zh-CN")} · 编号{" "}
            {s.id.slice(0, 8)} · 有效时长{" "}
            {Math.floor(Number(s.active_ms) / 60000)} 分{" "}
            {Math.floor((Number(s.active_ms) / 1000) % 60)} 秒
          </p>
        </div>
        <Tag status={s.end_reason ?? s.status} />
      </header>
      <Notice error>{error}</Notice>
      <Notice>{notice}</Notice>
      <div className="details-grid">
        <div className="stack">
          <section className="section">
            <div className="row between">
              <h2>对话录音</h2>
              {recording && <Tag status={recording.status} />}
            </div>
            <p className="small">
              按时间轴保留停顿。AI
              音频只拼入已确认播放的范围，未确认部分有缺失标记。
            </p>
            {url ? (
              <audio
                controls
                src={url}
                onError={() => {
                  setUrl("");
                  setNotice("播放地址可能已过期，请重新获取。");
                }}
              />
            ) : (
              <Button
                disabled={busy || !recording?.object_key}
                onClick={() =>
                  void run(async () => {
                    const r = await mutate(`sessions/${id}/recording`);
                    setUrl(r.url);
                  })
                }
              >
                <Headphones />
                加载录音
              </Button>
            )}
            {recording?.missing?.length > 0 && (
              <p className="small">
                记录了 {recording.missing.length} 处未完整确认或缺失范围。
              </p>
            )}
            {["failed", "partial"].includes(recording?.status) && (
              <Button
                onClick={() =>
                  void run(async () => {
                    await mutate(`sessions/${id}/recording-retry`);
                    setNotice("已重新安排录音整理。");
                  })
                }
              >
                重新整理
              </Button>
            )}
          </section>
          <section className="section">
            <h2>原始对话</h2>
            <p className="small">
              完整保留岗位切换和原始发言。生成的文字不等于已经播放。
            </p>
            <div className="transcript">
              {speech.length ? (
                speech.map((e: InterviewEvent) => (
                  <article
                    className="utterance"
                    id={`event-${e.event_id}`}
                    key={e.event_id}
                  >
                    <div className="row between small">
                      <strong>
                        {e.kind === "role_selected"
                          ? "岗位切换"
                          : e.speaker === "user"
                            ? "候选人"
                            : "AI 面试官"}
                      </strong>
                      <span className="muted">
                        #{e.seq} ·{" "}
                        {new Date(e.created_at).toLocaleTimeString("zh-CN")}
                      </span>
                    </div>
                    <p>
                      {e.text ||
                        (e.kind === "role_selected"
                          ? `${e.role_name ?? "当前岗位"}：开始新的岗位片段，保留整场历史。`
                          : "没有识别到有效文字。")}
                    </p>
                    {e.kind === "transcription_recovery" && (
                      <span className="small muted">
                        结束后补转写 · 原音频可核对 · 未触发实时对答
                      </span>
                    )}
                    {e.kind === "generated" && (
                      <span className="small muted">
                        {events.some(
                          (v: InterviewEvent) =>
                            v.kind === "playback" &&
                            v.metadata.event_id === e.event_id,
                        )
                          ? "有播放回执，精确范围见录音"
                          : "已生成 · 尚无播放确认"}
                      </span>
                    )}
                  </article>
                ))
              ) : (
                <div className="empty">还没有保存的对话</div>
              )}
            </div>
            {auxiliary.length > 0 && (
              <div className="stack">
                <h3>评估引用的辅助记录</h3>
                {auxiliary.map((e: InterviewEvent) => (
                  <article
                    className="evidence small"
                    id={`event-${e.event_id}`}
                    key={e.event_id}
                  >
                    <strong>
                      #{e.seq} ·{" "}
                      {e.kind === "playback" ? "播放确认" : "会话记录"}
                    </strong>
                    <p>
                      {e.kind === "playback"
                        ? `已确认 ${e.metadata.played_ms} / ${e.metadata.duration_ms} 毫秒`
                        : e.text ||
                          ({
                            ended: "面试已结束",
                            resume: "继续面试",
                            pause: "面试已暂停",
                            choose: "返回岗位选择",
                            audio_verified: "录音已核对",
                          }[e.kind] ??
                            "会话状态已更新")}
                    </p>
                    {typeof e.metadata.event_id === "string" && (
                      <a href={`#event-${e.metadata.event_id}`}>
                        定位对应 AI 话语
                      </a>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
          {feedback && (
            <section className="section">
              <h2>使用体验反馈</h2>
              <p className="small">
                {feedback.skipped
                  ? "候选人跳过了反馈"
                  : `体验评分：${feedback.rating ?? "未评分"} · ${(feedback.tags ?? []).join("、")}`}
              </p>
              <p>{feedback.text}</p>
              {!feedback.skipped && feedback.audio_ids?.length > 0 && (
                <Button
                  variant="quiet"
                  onClick={() =>
                    void run(async () => {
                      const r = await mutate(
                        `sessions/${id}/feedback-recordings`,
                      );
                      setFeedbackUrls(r.urls);
                      if (!r.urls.length) setNotice("没有语音反馈。");
                    })
                  }
                >
                  查看语音说明
                </Button>
              )}
              {feedbackUrls.map((u) => (
                <audio key={u} controls src={u} />
              ))}
            </section>
          )}
        </div>
        <div className="stack">
          <section className="section stack">
            <div className="row between">
              <h2>AI 评估草稿</h2>
              {latest && (
                <Tag
                  status={
                    latest.status === "pending" ? "queued" : latest.status
                  }
                />
              )}
            </div>
            <p className="small">
              供人工复核，不代表录用结论。每条观察都应回到原始对话核实。
            </p>
            {assessment?.result?.testMode && (
              <Notice>这是开发测试评估，尚未调用真实模型。</Notice>
            )}
            {assessment?.result?.note && (
              <p className="small">{assessment.result.note}</p>
            )}
            {assessment?.result?.items?.map((item: any, i: number) => (
              <div className="evidence" key={i}>
                <p>{item.text}</p>
                {item.sources.map((source: string) => (
                  <a key={source} href={`#event-${source}`}>
                    查看原文 #
                    {
                      events.find((e: InterviewEvent) => e.event_id === source)
                        ?.seq
                    }
                  </a>
                ))}
              </div>
            ))}
            {latest?.error && <Notice error>{latest.error}</Notice>}
            {assessment?.version !== latest?.version && (
              <Notice>
                第 {latest?.version} 版尚未完成，继续展示第{" "}
                {assessment?.version} 版草稿。
              </Notice>
            )}
            <Field label="本次评估要求">
              <textarea
                value={prompt}
                onChange={(e) => {
                  editingPrompt.current = true;
                  setPrompt(e.target.value);
                }}
                maxLength={16000}
              />
            </Field>
            <div className="row">
              <Button
                disabled={busy || !prompt.trim()}
                onClick={() =>
                  void run(async () => {
                    await mutate(`sessions/${id}/assessment-prompt`, {
                      prompt,
                      expected_prompt_version: promptVersion,
                    });
                    editingPrompt.current = promptRef.current !== prompt;
                    setPromptVersion(promptVersion + 1);
                    setNotice("本次评估要求已保存，尚未重新生成。");
                  })
                }
              >
                保存评估要求
              </Button>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => (
                  (editingPrompt.current = false),
                  setPromptVersion(s.assessment_prompt_version),
                  setPrompt(s.assessment_prompt ?? latest?.prompt ?? "")
                )}
              >
                取消修改
              </Button>
              <Button
                disabled={
                  busy ||
                  s.status !== "ended" ||
                  !prompt.trim() ||
                  latest?.status === "running" ||
                  latest?.status === "pending"
                }
                onClick={() => setConfirmAssessment(true)}
              >
                <RefreshCw />
                重新生成评估
              </Button>
            </div>
            <p className="small">
              当前第 {assessment?.version ?? 0} 版 · 仅影响本次面试
            </p>
            {q.data.assessments.length > 1 && (
              <details>
                <summary>查看历史评估版本</summary>
                {q.data.assessments.slice(1).map((a: any) => (
                  <div className="evidence" key={a.version}>
                    <strong>第 {a.version} 版</strong>
                    <Tag status={a.status} />
                    <p className="small">{a.prompt}</p>
                    {a.result?.items?.map((v: any, i: number) => (
                      <p key={i}>{v.text}</p>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </section>
          <section className="section stack">
            <h2>语音诊断</h2>
            <p className="small">
              记录收音、生成、合成、播放和连接阶段；耗时为对应服务内的测量，不能相加推断真人说话结束时间。
            </p>
            <details>
              <summary>
                查看最近 {q.data.telemetry?.length ?? 0} 条阶段记录
              </summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>连接</th>
                      <th>阶段</th>
                      <th>耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(q.data.telemetry ?? []).map((t: any) => (
                      <tr key={t.id}>
                        <td>
                          {new Date(t.created_at).toLocaleTimeString("zh-CN")}
                        </td>
                        <td>{t.epoch}</td>
                        <td>
                          {(
                            {
                              capture_gap: "采音间隔",
                              capture_start: "采音开始",
                              capture_stop: "采音停止",
                              capture_end: "采音进度",
                              relay_receive: "收到采音",
                              input_queue: "输入排队",
                              user_audio_durable: "采音已保存",
                              asr_send: "识别送入进度",
                              asr_interim: "识别临时结果",
                              asr_final: "识别最终结果",
                              llm_request: "请求模型",
                              speakable_text: "可朗读文本",
                              tts_request: "请求合成",
                              input_gap: "音频序号缺口",
                              input_starved: "输入中断",
                              utterance_committed: "回答已保存",
                              llm_first_delta: "模型首段",
                              tts_first_pcm: "合成首包",
                              first_audio_sent: "首包已发送",
                              play_start: "开始播放",
                              local_cancel: "本地停止播放",
                              cancel: "回复已取消",
                              output_repair: "朗读内容重试",
                              control_dispatch: "控制处理",
                              clock_sync: "时钟校准",
                              context_ready: "上下文就绪",
                              first_audio_durable: "首包已持久保存",
                              audio_send: "音频发送",
                              play_end: "播放结束",
                            } as Record<string, string>
                          )[t.stage] ?? t.stage}
                        </td>
                        <td>
                          {t.elapsed_ms == null
                            ? "—"
                            : `${Math.round(t.elapsed_ms)} ms`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
          <section className="section stack">
            <h2>人工复核意见</h2>
            <Field label="招聘方判断">
              <textarea
                placeholder="记录你的观察、需要进一步确认的事项，以及后续建议。"
                value={review}
                onChange={(e) => setReview(e.target.value)}
                maxLength={10000}
              />
            </Field>
            <Button
              variant="primary"
              disabled={busy || !review.trim()}
              onClick={() =>
                void run(async () => {
                  await mutate(`sessions/${id}/review`, { text: review });
                  if (reviewRef.current === review) setReview("");
                  setNotice("人工复核意见已独立保存。");
                })
              }
            >
              保存复核意见
            </Button>
            {reviews.map((r: any) => (
              <div className="evidence" key={r.id}>
                <p>{r.text}</p>
                <span className="small muted">
                  {new Date(r.created_at).toLocaleString("zh-CN")}
                </span>
              </div>
            ))}
          </section>
          {retries.length > 0 && (
            <section className="section stack">
              <h2>再次面试申请</h2>
              {retries.map((r: any) => (
                <div key={r.id}>
                  <div className="row">
                    <Tag status={r.status} />
                    {r.used_by && <span className="small">资格已使用</span>}
                  </div>
                  <p>{r.reason}</p>
                  <p className="small muted">
                    申请时间：{new Date(r.created_at).toLocaleString("zh-CN")}
                  </p>
                  {r.review_reason && (
                    <p className="small">审核说明：{r.review_reason}</p>
                  )}
                </div>
              ))}
              {retry && (
                <>
                  <Field label="审核说明（拒绝时必填）">
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={1000}
                    />
                  </Field>
                  <div className="row">
                    <Button
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        setConfirmRetry({
                          id: retry.id,
                          status: "rejected",
                          reason,
                        })
                      }
                    >
                      拒绝申请
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        setConfirmRetry({
                          id: retry.id,
                          status: "approved",
                          reason,
                        })
                      }
                    >
                      通过申请
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}
          {!retries.length && (
            <section className="section stack">
              <h2>再次面试申请</h2>
              <p className="small muted">暂无申请</p>
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}

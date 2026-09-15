"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Notice } from "@/components/base/ui";
import {
  VoicePanel,
  type VoicePanelHandle,
} from "@/components/business/voice-panel";
import type { Session } from "@/shared/contracts";
import { usePreviewHistory } from "./use-preview-history";

export function RolePreview({
  session,
  open,
  onClose,
  onFinished,
}: {
  session: Session;
  open: boolean;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [finished, setFinished] = useState(false);
  const voicePanel = useRef<VoicePanelHandle>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const history = usePreviewHistory(session.id, open, finished);
  const current = history.data?.session ?? session;
  const turns = history.data?.turns ?? [];
  const pending = ["pending", "running"].includes(
    history.data?.transcription_status ?? "",
  );
  useEffect(() => {
    if (finished && open) transcript.current?.focus();
  }, [finished, open]);
  return (
    <Dialog
      className={finished ? "preview preview-history" : "preview"}
      open={open}
      onClose={() => (finished ? onClose() : void voicePanel.current?.end())}
      title={finished ? "试聊记录" : "岗位试聊"}
    >
      {finished ? (
        <>
          <p className="preview-history-summary">
            {session.name} · 本次试聊已结束，可对照记录继续修改 Prompt。
          </p>
          {session.test_mode && (
            <Notice>开发测试模式，本次对话使用测试适配器。</Notice>
          )}
          <div
            className="preview-transcript"
            ref={transcript}
            tabIndex={0}
            role="region"
            aria-label="本次试聊对话记录"
            aria-busy={!history.data && history.isFetching}
          >
            {turns.map((turn) => (
              <article className="utterance" key={turn.event_id}>
                <div className="row between small">
                  <strong>
                    {turn.speaker === "user" ? "我" : "AI 面试官"}
                  </strong>
                  <time className="muted mono" dateTime={turn.created_at}>
                    {new Date(turn.created_at).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                </div>
                <p>{turn.text}</p>
                {turn.recovered && (
                  <span className="small muted">结束后补转写</span>
                )}
                {turn.playback && turn.playback !== "heard" && (
                  <span className="small muted">
                    {turn.playback === "partial"
                      ? "部分播放 · 显示生成全文"
                      : "已生成 · 尚无播放确认"}
                  </span>
                )}
              </article>
            ))}
            {!turns.length && (
              <div className="empty">
                {!history.data
                  ? history.isFetching
                    ? "正在读取试聊记录…"
                    : "暂时无法读取试聊记录，请重试。"
                  : pending
                    ? "暂未识别到对话文字，正在检查录音中的待转写内容。"
                    : "本次试聊还没有对话文字。"}
              </div>
            )}
          </div>
          <div className="preview-history-status" role="status">
            {history.isError
              ? "记录更新失败，已显示的内容仍保留，请重试。"
              : pending
                ? turns.length
                  ? "已显示保存的对话，补转写完成后会自动更新。"
                  : "正在检查待转写内容，完成后会自动更新。"
                : history.data?.transcription_status === "failed"
                  ? "部分录音补转写未完成，已保存的对话可正常查看。"
                  : history.isFetching
                    ? "正在更新记录…"
                    : "试聊记录独立保留，不计入正式面试记录。"}
          </div>
          <div className="actions">
            <Button
              disabled={history.isFetching}
              onClick={() => void history.refetch()}
            >
              {history.isError ? "重试加载" : "刷新记录"}
            </Button>
            <Button variant="primary" onClick={onClose}>
              返回编辑
            </Button>
          </div>
        </>
      ) : (
        <VoicePanel
          ref={voicePanel}
          session={{ ...current, name: session.name }}
          testMode={session.test_mode}
          preview
          autoStart
          onEnded={() => {
            setFinished(true);
            onFinished();
            void history.refetch();
          }}
          onRefresh={() => void history.refetch()}
        />
      )}
    </Dialog>
  );
}

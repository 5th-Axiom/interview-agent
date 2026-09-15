"use client";
import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import {
  Mic,
  MicOff,
  Pause,
  Play,
  PhoneOff,
  Captions,
  ArrowLeft,
  AudioLines,
} from "lucide-react";
import { Button, Notice, Dialog } from "@/components/base/ui";
import { VoiceOrb } from "./voice-orb";
import { useVoiceSession } from "@/features/interview/use-voice-session";
import { Session } from "@/shared/contracts";
export type VoicePanelHandle = {
  end: () => Promise<Session | undefined>;
};
export function VoicePanel({
  ref,
  session,
  testMode,
  onEnded,
  onRefresh,
  onChoose,
  autoStart = false,
  preview = false,
}: {
  ref?: Ref<VoicePanelHandle>;
  session: Session;
  testMode: boolean;
  onEnded: () => void;
  onRefresh: () => void;
  onChoose?: (session: Session) => void;
  autoStart?: boolean;
  preview?: boolean;
}) {
  const voice = useVoiceSession(session, onEnded, onRefresh);
  useImperativeHandle(ref, () => ({ end: () => voice.control("end") }));
  const [captions, setCaptions] = useState(false),
    [text, setText] = useState(""),
    [time, setTime] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (autoStart) void voice.connect(session, testMode);
  }, [autoStart]);
  const active = voice.state === "active";
  const ms =
    (Number.isFinite(Number(session.active_ms))
      ? Number(session.active_ms)
      : 0) +
    (active && session.active_since
      ? Math.max(
          0,
          time -
            (Number.isFinite(new Date(session.active_since).getTime())
              ? new Date(session.active_since).getTime()
              : time),
        )
      : 0);
  const duration = `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
  const status =
    voice.state === "connecting"
      ? "正在连接"
      : !active
        ? voice.state === "paused"
          ? "面试已暂停"
          : "准备好后，接着聊"
        : voice.muted
          ? "麦克风已静音"
          : voice.audioState === "speaking"
            ? "AI 正在说话"
            : voice.audioState === "thinking"
              ? "正在组织回答"
              : ((
                  {
                    saving: "正在补传待保存的录音",
                    generating: "正在组织回答",
                    synthesizing: "正在准备语音",
                    buffering: "正在缓冲语音",
                    recognizing: "正在识别回答",
                  } as Record<string, string>
                )[voice.audioState] ?? "正在聆听，你可以随时打断");
  return (
    <section className="candidate">
      <header className="row between session-header">
        {onChoose ? (
          <Button
            variant="quiet"
            disabled={voice.controlling}
            onClick={async () => {
              const next = await voice.control("choose");
              if (!next) return;
              voice.disconnect();
              onChoose(next);
            }}
          >
            <ArrowLeft />
            重新选岗
          </Button>
        ) : (
          <span className="tag">{preview ? "岗位试聊" : "语音面试"}</span>
        )}
        <strong>{session.name ?? "面试进行中"}</strong>
        <span className="mono muted" title="有效对话时长">
          {duration}
        </span>
      </header>
      <VoiceOrb
        state={active ? voice.audioState : voice.state}
        level={voice.level}
      />
      <div className="voice-status" role="status">
        <AudioLines />
        {status}
      </div>
      <Notice error>{voice.error}</Notice>
      {voice.unsavedMs >= 4000 && (
        <Notice>
          还有 {(voice.unsavedMs / 1000).toFixed(1)}{" "}
          秒录音待保存，请保留此页面。连接恢复后会先补传。
        </Notice>
      )}
      {!active && voice.state !== "connecting" && (
        <div className="stack">
          <p>
            {voice.state === "paused"
              ? "暂停期间仍按原截止时间结束。"
              : preview
                ? "准备好麦克风后即可开始试聊；连接中断时可重试。"
                : "你有一场未完成的面试，之前的交流已保留。"}
          </p>
          <div className="row" style={{ justifyContent: "center" }}>
            <Button
              variant="primary"
              disabled={voice.controlling}
              onClick={() => void voice.connect(session, testMode)}
            >
              <Play />
              {preview ? "开始 / 继续试聊" : "继续面试"}
            </Button>
            {voice.error.includes("接管") ||
            voice.error.includes("已有页面") ? (
              <Button
                disabled={voice.controlling}
                onClick={() => void voice.connect(session, testMode, true)}
              >
                接管此会话
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {captions && voice.subtitle && (
        <p className="subtitle">{voice.subtitle}</p>
      )}
      <div className="voice-controls">
        <div className="voice-control">
          <Button
            aria-label={voice.muted ? "取消静音" : "静音"}
            disabled={!active || voice.controlling}
            onClick={voice.mute}
          >
            {voice.muted ? <MicOff /> : <Mic />}
          </Button>
          <span>{voice.muted ? "取消静音" : "静音"}</span>
        </div>
        <div className="voice-control">
          <Button
            aria-label={active ? "暂停" : "继续"}
            disabled={voice.state === "connecting" || voice.controlling}
            onClick={() =>
              active
                ? void voice.control("pause")
                : void voice.connect(session, testMode)
            }
          >
            {active ? <Pause /> : <Play />}
          </Button>
          <span>{active ? "暂停" : "继续"}</span>
        </div>
        <div className="voice-control">
          <Button
            variant="danger"
            aria-label={preview ? "结束试聊" : "结束面试"}
            disabled={voice.controlling}
            onClick={() => voice.setEndConfirm(true)}
          >
            <PhoneOff />
          </Button>
          <span>结束</span>
        </div>
      </div>
      <Button variant="quiet" onClick={() => setCaptions(!captions)}>
        <Captions />
        {captions ? "隐藏字幕" : "显示字幕"}
      </Button>
      {testMode && active && (
        <form
          className="test-input"
          onSubmit={(e) => {
            e.preventDefault();
            voice.sendText(text);
            setText("");
          }}
        >
          <label className="field">
            <span>测试输入 · 替代语音识别</span>
            <div className="row">
              <input
                className="input"
                aria-label="测试回答"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="输入回答，验证对话与保存"
                style={{ flex: 1 }}
              />
              <Button disabled={!text.trim()} type="submit">
                发送
              </Button>
            </div>
          </label>
          <p className="small">测试模式合成静音音频；开启字幕查看测试回复。</p>
        </form>
      )}
      <p className="candidate-footer">
        {preview
          ? "试聊不占正式面试资格"
          : "首次开始后一小时结束 · 暂停、换岗和断线不延长截止时间"}
      </p>
      <Dialog
        open={voice.endConfirm}
        onClose={() => voice.setEndConfirm(false)}
        title={preview ? "结束本次试聊？" : "确认结束面试？"}
      >
        <p>
          {preview
            ? "结束后立即查看本次对话记录，再返回修改面试说明。"
            : "结束后会保存本次记录。你可以反馈体验，也可以申请再次面试。"}
        </p>
        <div className="actions">
          <Button onClick={() => voice.setEndConfirm(false)}>继续交流</Button>
          <Button
            variant="danger"
            disabled={voice.controlling}
            onClick={() => {
              voice.setEndConfirm(false);
              void voice.control("end");
            }}
          >
            确认结束
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

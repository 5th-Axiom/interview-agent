"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Mic, ShieldCheck } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { VoiceOrb } from "@/components/business/voice-orb";
import { VoicePanel } from "@/components/business/voice-panel";
import { Button, Notice } from "@/components/base/ui";
import { api, mutate, RequestError } from "./api";
import { useRoleSelection } from "./use-role-selection";
import { capture, Capture } from "./audio";
import { Session, Role } from "@/shared/contracts";
export function CandidatePage({ id }: { id?: string }) {
  const router = useRouter();
  const [entry, setEntry] = useState("demo"),
    [stage, setStage] = useState("prepare"),
    [error, setError] = useState(""),
    [level, setLevel] = useState(0),
    [busy, setBusy] = useState(false),
    [auto, setAuto] = useState(false),
    [testBypass, setTestBypass] = useState(false);
  const mic = useRef<Capture | null>(null),
    probeEpoch = useRef(0);
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api("config"),
  });
  const boot = useQuery({
    queryKey: ["bootstrap", entry],
    queryFn: () => api(`bootstrap?entry=${entry}`),
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["session", id],
    queryFn: () => api(`sessions/${id}`),
    enabled: !!id,
    refetchInterval: 5000,
  });
  useEffect(() => {
    setEntry(new URLSearchParams(location.search).get("entry") ?? "demo");
    if (sessionStorage.getItem(`auto:${id}`) === "true") setAuto(true);
    if (id) sessionStorage.removeItem(`auto:${id}`);
    return () => {
      probeEpoch.current++;
      mic.current?.stop();
    };
  }, [id]);
  useEffect(() => {
    if (
      boot.error instanceof RequestError &&
      [401, 403].includes(boot.error.status)
    )
      router.replace(`/interview/login?entry=${entry}`);
  }, [boot.error, router, entry]);
  useEffect(() => {
    // Eligibility can change while this page is unmounted (e.g. an approved
    // retry). Do not redirect using the previous cached bootstrap response.
    if (!id && (boot.isFetching || boot.error)) return;
    const s = id ? detail.data?.session : boot.data?.session;
    if (s?.status === "ended" && (id || !boot.data?.eligible))
      router.replace(`/interview/session/${s.id}/feedback`);
    else if (!id && s && s.status !== "ended")
      router.replace(`/interview/session/${s.id}`);
  }, [boot.data, boot.isFetching, boot.error, detail.data, id, router]);
  async function testMic() {
    const generation = ++probeEpoch.current;
    setError("");
    setStage("testing");
    mic.current?.stop();
    let hits = 0;
    try {
      const c = await capture(
        (_, volume) => {
          if (probeEpoch.current !== generation) return;
          setLevel(volume);
          if (volume > 0.015 && ++hits >= 2) {
            probeEpoch.current++;
            mic.current?.stop();
            setStage("choose");
          }
        },
        () => {
          if (probeEpoch.current !== generation) return;
          setError("麦克风已断开，请重新测试。");
          setStage("prepare");
        },
      );
      if (probeEpoch.current !== generation) {
        c.stop();
        return;
      }
      mic.current = c;
      setTimeout(() => {
        c.stop();
        if (probeEpoch.current !== generation) return;
        setStage((old) => {
          if (old === "testing") {
            setError("没有听到声音，请检查输入设备后重新测试。");
            return "prepare";
          }
          return old;
        });
      }, 8000);
    } catch {
      if (probeEpoch.current !== generation) return;
      setError("无法开启麦克风，请在浏览器权限中允许访问后重试。");
      setStage("prepare");
    }
  }
  const s = detail.data?.session as Session | undefined;
  async function choose(role: Role, selection_text?: string) {
    setBusy(true);
    setError("");
    try {
      const next = await mutate<Session>(
        s ? `sessions/${s.id}/control` : "sessions/start",
        s
          ? { action: "role", role_id: role.id }
          : { entry, role_id: role.id, selection_text },
      );
      mic.current?.stop();
      if (s) {
        await detail.refetch();
        setStage("prepare");
        setAuto(true);
      } else {
        sessionStorage.setItem(`auto:${next.id}`, "true");
        router.replace(`/interview/session/${next.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selection = useRoleSelection(
    stage === "choose",
    !!config.data?.testMode,
    entry,
    (rid, text) => {
      const r = boot.data?.roles.find((r: Role) => r.id === rid);
      if (r) void choose(r, text);
    },
  );
  if (boot.isPending || (!id && boot.isFetching) || (id && detail.isPending))
    return (
      <Shell>
        <div className="loading">正在读取面试信息…</div>
      </Shell>
    );
  if (boot.error)
    return (
      <Shell>
        <div className="candidate-wrap">
          <Notice error>{boot.error.message}</Notice>
          <Button onClick={() => void boot.refetch()}>重试</Button>
        </div>
      </Shell>
    );
  if (id && detail.error && !detail.data)
    return (
      <Shell>
        <div className="candidate-wrap stack">
          <h1>无法读取这场面试</h1>
          <Notice error>{detail.error.message}</Notice>
          <Button onClick={() => void detail.refetch()}>重试加载</Button>
          <Button onClick={() => router.replace("/interview")}>
            返回面试入口
          </Button>
        </div>
      </Shell>
    );
  return (
    <Shell>
      <div className="candidate-wrap">
        {s && stage !== "choose" ? (
          <VoicePanel
            key={`${s.id}:${s.current_segment}`}
            session={s}
            testMode={s.test_mode}
            autoStart={auto}
            onEnded={() =>
              router.replace(`/interview/session/${s.id}/feedback`)
            }
            onRefresh={() => void detail.refetch()}
            onChoose={() => setStage("choose")}
          />
        ) : (
          <section className="candidate">
            <header>
              <h1>
                {stage === "choose"
                  ? "你想面试哪个岗位？"
                  : stage === "testing"
                    ? "请说一句话，测试麦克风"
                    : "准备好，开始一段对话"}
              </h1>
              <p className="intro">
                {stage === "choose"
                  ? "点击岗位或说出岗位名称，面试就会开始。"
                  : stage === "testing"
                    ? "说一句“你好”，让我们确认能听清你的声音。"
                    : "本次由 AI 面试官与你交流。请在安静的环境中开启麦克风，记录将供招聘团队了解你的经历。"}
              </p>
            </header>
            <VoiceOrb
              state={stage === "testing" ? "listening" : "idle"}
              level={level}
            />
            <Notice error>{error}</Notice>
            {stage === "choose" ? (
              <>
                <div className="role-list">
                  {boot.data?.roles.map((role: Role) => (
                    <button
                      className="role-choice"
                      key={role.id}
                      disabled={busy}
                      onClick={() => void choose(role)}
                    >
                      <div>
                        <h3>{role.name}</h3>
                        <p>{role.description}</p>
                      </div>
                      <ArrowRight />
                    </button>
                  ))}
                </div>
                {!boot.data?.roles.length && (
                  <Notice>暂时没有开放的岗位，请联系招聘团队。</Notice>
                )}
                <p className="small muted">
                  {busy ? "正在准备面试…" : selection.message}
                </p>
                {config.data?.testMode && (
                  <form
                    className="test-input row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void selection
                        .select(selection.testText)
                        .catch((e) => setError(e.message));
                    }}
                  >
                    <input
                      className="input"
                      aria-label="测试岗位意向"
                      placeholder="测试语音意向：我想面试前端工程师"
                      value={selection.testText}
                      onChange={(e) => selection.setTestText(e.target.value)}
                    />
                    <Button disabled={busy || !selection.testText.trim()}>
                      测试选岗意向
                    </Button>
                  </form>
                )}
              </>
            ) : (
              <Button
                variant="primary"
                disabled={stage === "testing"}
                onClick={() => void testMic()}
              >
                <Mic />
                {stage === "testing"
                  ? "正在检测声音…"
                  : error
                    ? "重新测试"
                    : "开始对话"}
              </Button>
            )}
            {config.data?.testMode && stage !== "choose" && (
              <Button
                variant="quiet small"
                onClick={() => {
                  mic.current?.stop();
                  setTestBypass(true);
                  setStage("choose");
                }}
              >
                开发测试：跳过麦克风，使用文字输入
              </Button>
            )}
            <p className="candidate-footer">
              <ShieldCheck size={14} />{" "}
              {testBypass
                ? "已选择显式开发测试模式"
                : "仅采集声音，不需要开启摄像头"}
            </p>
          </section>
        )}
      </div>
    </Shell>
  );
}

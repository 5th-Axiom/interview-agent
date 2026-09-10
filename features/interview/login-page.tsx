"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { VoiceOrb } from "@/components/business/voice-orb";
import { Button, Field, Notice } from "@/components/base/ui";
import { api } from "./api";
export function LoginPage({ admin = false }: { admin?: boolean }) {
  const router = useRouter();
  const [phone, setPhone] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [count, setCount] = useState(0),
    [test, setTest] = useState(false);
  useEffect(() => {
    void api("config")
      .then((c) => setTest(c.otp))
      .catch(() => setError("无法读取登录配置，请刷新重试。"));
  }, []);
  useEffect(() => {
    if (!count) return;
    const timer = setTimeout(() => setCount(count - 1), 1000);
    return () => clearTimeout(timer);
  }, [count]);
  async function send() {
    setError("");
    setBusy(true);
    try {
      await api("auth/code", { phone });
      setCount(60);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api(
        admin ? "auth/admin" : "auth/login",
        admin ? { password } : { phone, code },
      );
      router.replace(admin ? "/admin/roles" : `/interview${location.search}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell>
      <div className="login-layout">
        <div className="login-story">
          <h1>
            {admin ? "每一段对话，都是了解的开始。" : "放轻松，聊聊你的经历。"}
          </h1>
          <p>
            {admin
              ? "用岗位说明定义面试，在真实对话中发现候选人的能力与潜力。"
              : "这里没有倒计时抢答。与 AI 面试官自然交流，让你的思考与经验被认真听见。"}
          </p>
          <VoiceOrb />
        </div>
        <section className="login-form">
          <h2>{admin ? "登录招聘工作台" : "欢迎参加面试"}</h2>
          <p className="small">
            {admin
              ? "管理岗位、面试记录与人工复核"
              : "登录后开启麦克风，准备好就可以开始"}
          </p>
          <form className="stack" onSubmit={submit}>
            {admin ? (
              <Field label="工作台密码">
                <input
                  autoComplete="current-password"
                  type="password"
                  className="input"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入工作台密码"
                />
              </Field>
            ) : (
              <>
                <Field label="手机号">
                  <input
                    className="input"
                    autoComplete="tel"
                    inputMode="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="请输入手机号"
                  />
                </Field>
                <Field label="短信验证码">
                  <div className="code-row">
                    <input
                      className="input"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="6 位验证码"
                    />
                    <Button
                      type="button"
                      disabled={busy || count > 0 || !phone.trim()}
                      onClick={send}
                    >
                      {count ? `${count}s 后重发` : "获取验证码"}
                    </Button>
                  </div>
                </Field>
              </>
            )}
            <Notice error>{error}</Notice>
            <Button variant="primary full" disabled={busy}>
              {busy ? "正在处理…" : admin ? "登录工作台" : "登录并继续"}
              <ArrowRight />
            </Button>
            {test && (
              <Notice>
                {admin
                  ? "开发账号密码：local-recruiter"
                  : "测试环境请先获取验证码，再输入 123456。手机号可填写测试标识。"}
              </Notice>
            )}
          </form>
          <p className="login-note">
            <LockKeyhole size={13} /> 面试记录仅供本次招聘团队查看
          </p>
        </section>
      </div>
    </Shell>
  );
}

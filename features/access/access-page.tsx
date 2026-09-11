"use client";
import { useState } from "react";
import { Shell } from "@/components/business/shell";
import { Button, Field, Notice } from "@/components/base/ui";
import { testAccess } from "./api";

export function AccessPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Shell access>
      <section className="access-layout">
        <div className="login-form">
          <h1>登录测试环境</h1>
          <p className="muted">使用分配的账号，进入 AI 面试测试环境。</p>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                const result = await testAccess({
                  username,
                  password,
                  next: new URLSearchParams(location.search).get("next"),
                });
                window.location.assign(result.next ?? "/interview");
              } catch (e) {
                setError(
                  e instanceof Error && e.name !== "TimeoutError"
                    ? e.message
                    : "连接超时，请重试",
                );
                setBusy(false);
              }
            }}
          >
            <Field label="用户名">
              <input
                className="input"
                autoComplete="username"
                required
                maxLength={128}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </Field>
            <Field label="密码">
              <input
                className="input"
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                required
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <label className="row access-password-toggle">
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => setVisible(e.target.checked)}
              />
              显示密码
            </label>
            <Notice error>{error}</Notice>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "正在登录…" : "登录并进入"}
            </Button>
          </form>
          <p className="login-note muted">
            仅供授权测试人员使用。没有账号请联系项目负责人。
          </p>
        </div>
      </section>
    </Shell>
  );
}

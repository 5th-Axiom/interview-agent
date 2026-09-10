"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, ReactNode } from "react";
import {
  AudioLines,
  Moon,
  Sun,
  BriefcaseBusiness,
  ClipboardList,
  ArrowUpRight,
} from "lucide-react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { Button } from "../base/ui";
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
export function Shell({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const [dark, setDark] = useState(false);
  const path = usePathname();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => fetch("/api/config").then((r) => r.json()),
    staleTime: Infinity,
  });
  useEffect(() => {
    const value = localStorage.getItem("appearance") === "dark";
    setDark(value);
    document.documentElement.dataset.theme = value ? "dark" : "light";
  }, []);
  function toggle() {
    const value = !dark;
    setDark(value);
    localStorage.setItem("appearance", value ? "dark" : "light");
    document.documentElement.dataset.theme = value ? "dark" : "light";
  }
  return (
    <>
      <div className="topbar">
        <Link className="brand" href={admin ? "/admin/roles" : "/interview"}>
          <span className="brandmark">
            <AudioLines />
          </span>
          AI 面试
          <span className="subbrand">
            {admin ? "招聘工作台" : "让每一段经历，都被认真听见"}
          </span>
        </Link>
        <div className="row">
          <Link
            className="btn quiet small"
            href={admin ? "/interview" : "/admin/roles"}
            aria-label={admin ? "候选人入口" : "招聘方工作台"}
          >
            <span className="desktop-label">
              {admin ? "候选人入口" : "招聘方工作台"}
            </span>
            <ArrowUpRight />
          </Link>
          <Button
            variant="quiet icon"
            aria-label={dark ? "切换浅色" : "切换深色"}
            onClick={toggle}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </div>
      {config.data?.testMode && (
        <div className="test-banner">
          开发测试模式 · 测试对话不代表真实面试评估 · ASR / TTS 未调用真实供应商
        </div>
      )}
      {!config.data?.testMode && config.data?.otp && (
        <div className="test-banner">
          供应商联调环境 · 使用真实 AI 语音与评估 · 登录使用测试验证码
        </div>
      )}
      {admin ? (
        <div className="admin-layout">
          <nav className="sidebar" aria-label="招聘管理">
            <Link
              className={path.includes("/roles") ? "active" : ""}
              href="/admin/roles"
            >
              <BriefcaseBusiness />
              岗位管理
            </Link>
            <Link
              className={path.includes("/interviews") ? "active" : ""}
              href="/admin/interviews"
            >
              <ClipboardList />
              面试记录
            </Link>
          </nav>
          <main className="admin-main">{children}</main>
        </div>
      ) : (
        <main>{children}</main>
      )}
    </>
  );
}

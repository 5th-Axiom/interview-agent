"use client";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { Button, Notice } from "@/components/base/ui";
import { useAdminQuery } from "./use-admin";
import { TemplateBrowser } from "./template-browser";

export function TemplatesPage() {
  const q = useAdminQuery("roles", "roles");
  return (
    <Shell admin>
      <header className="page-heading">
        <div>
          <h1>Prompt 模板</h1>
          <p>固定问题、主题引导、开放访谈，选择适合的方式开始。</p>
        </div>
      </header>
      {q.isPending ? (
        <div className="loading">正在读取模板…</div>
      ) : q.error ? (
        <>
          <Notice error>{q.error.message}</Notice>
          <Button onClick={() => void q.refetch()}>重试加载</Button>
        </>
      ) : (
        <TemplateBrowser
          action={(template) => (
            <Link
              className="btn primary"
              href={"/admin/roles/new?template=" + template.id}
            >
              <Plus />
              用此模板创建岗位
            </Link>
          )}
        />
      )}
    </Shell>
  );
}

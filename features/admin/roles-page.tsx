"use client";
import Link from "next/link";
import { useState } from "react";
import {
  Plus,
  Copy,
  ArrowUpRight,
  BriefcaseBusiness,
  Search,
} from "lucide-react";
import { Shell } from "@/components/business/shell";
import { Button, Notice, Tag, Dialog } from "@/components/base/ui";
import { useAdminQuery } from "./use-admin";
import { mutate } from "./api";
import { Role } from "@/shared/contracts";
export function RolesPage() {
  const q = useAdminQuery("roles", "roles");
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [disable, setDisable] = useState<Role | null>(null);
  const roles = (q.data ?? []).filter(
    (r: Role) => r.name.includes(search) && (!status || r.status === status),
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/interview?entry=demo`,
      );
      setNotice("面试链接已复制，可以发送给候选人。");
    } catch {
      setNotice(`请手动复制：${location.origin}/interview?entry=demo`);
    }
  }
  return (
    <Shell admin>
      <header className="page-heading">
        <div>
          <h1>岗位管理</h1>
          <p>定义一次好的面试，从清晰的岗位说明开始。</p>
        </div>
        <Link className="btn primary" href="/admin/roles/new">
          <Plus />
          新建岗位
        </Link>
      </header>
      <div className="toolbar">
        <input
          className="input"
          aria-label="搜索岗位"
          placeholder="搜索岗位名称"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="岗位状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="published">已发布</option>
          <option value="draft">草稿</option>
          <option value="disabled">已停用</option>
        </select>
      </div>
      <Notice error>{error || q.error?.message}</Notice>
      {q.error && (
        <Button onClick={() => void q.refetch()}>重试加载岗位</Button>
      )}
      {q.isPending ? (
        <div className="loading">正在读取岗位…</div>
      ) : roles.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>岗位名称</th>
                <th>发布状态</th>
                <th>最近更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r: Role) => (
                <tr key={r.id}>
                  <td>
                    <Link className="role-name" href={`/admin/roles/${r.id}`}>
                      {r.name}
                    </Link>
                    <small>{r.description}</small>
                  </td>
                  <td data-label="状态">
                    <Tag status={r.status} />
                    {r.dirty && r.published_version && (
                      <small>有未发布修改</small>
                    )}
                  </td>
                  <td data-label="更新">
                    {new Date(r.updated_at!).toLocaleDateString("zh-CN")}
                  </td>
                  <td>
                    <div className="row">
                      <Link className="btn quiet" href={`/admin/roles/${r.id}`}>
                        编辑
                      </Link>
                      <Link
                        className="btn quiet"
                        href={`/admin/interviews?role=${r.id}`}
                      >
                        记录
                      </Link>
                      {r.status === "published" && (
                        <Button variant="quiet" onClick={() => setDisable(r)}>
                          停用
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <BriefcaseBusiness />
          <h2>{search || status ? "没有找到匹配岗位" : "还没有面试岗位"}</h2>
          <p>
            {search || status
              ? "调整搜索条件，或清空筛选。"
              : "创建一个岗位，用 Prompt 定义面试方式。"}
          </p>
          <Button
            onClick={() => {
              setSearch("");
              setStatus("");
              void q.refetch();
            }}
          >
            清空筛选并刷新
          </Button>
        </div>
      )}
      <div className="entry-strip">
        <div>
          <h3>候选人面试入口</h3>
          <p>一个链接，展示所有已发布岗位。</p>
        </div>
        <div className="row">
          <Button onClick={() => void copy()}>
            <Copy />
            复制面试链接
          </Button>
          <Link
            className="btn quiet"
            target="_blank"
            href="/interview?entry=demo"
          >
            查看入口
            <ArrowUpRight />
          </Link>
        </div>
      </div>
      <Notice>{notice}</Notice>
      <Dialog
        open={!!disable}
        onClose={() => setDisable(null)}
        title={`停用「${disable?.name ?? ""}」？`}
      >
        <p>停用后不再接收该岗位的新面试，已经开始的面试仍可继续。</p>
        <div className="actions">
          <Button onClick={() => setDisable(null)}>取消</Button>
          <Button
            variant="danger"
            onClick={async () => {
              try {
                await mutate(`roles/${disable!.id}/disable`);
                setDisable(null);
                await q.refetch();
              } catch (e) {
                setDisable(null);
                setError((e as Error).message);
              }
            }}
          >
            确认停用
          </Button>
        </div>
      </Dialog>
    </Shell>
  );
}

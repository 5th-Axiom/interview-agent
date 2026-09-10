"use client";
import Link from "next/link";
import { ClipboardList, ArrowRight } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { Button, Notice, Tag } from "@/components/base/ui";
import { useAdminQuery } from "./use-admin";
import { Role } from "@/shared/contracts";
import { useRecordFilters } from "./use-record-filters";
export function RecordsPage() {
  const { phone, search, role, status, date, page, ready, update, clear } =
    useRecordFilters();
  const roles = useAdminQuery("roles", "roles");
  const qs = new URLSearchParams({
    phone: search,
    role,
    status,
    date,
    page: String(page),
  });
  const q = useAdminQuery("records", `records?${qs}`, 5000);
  return (
    <Shell admin>
      <header className="page-heading">
        <div>
          <h1>面试记录</h1>
          <p>回到真实的对话，了解每位候选人的经历与思考。</p>
        </div>
      </header>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          update({ search: phone });
        }}
      >
        <input
          className="input"
          aria-label="候选人手机号"
          placeholder="按完整手机号精确查找"
          value={phone}
          onChange={(e) => update({ phone: e.target.value })}
        />
        <select
          aria-label="筛选岗位"
          value={role}
          onChange={(e) => update({ role: e.target.value })}
        >
          <option value="">全部岗位</option>
          {roles.data?.map((r: Role) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          aria-label="面试状态"
          value={status}
          onChange={(e) => update({ status: e.target.value })}
        >
          <option value="">全部状态</option>
          <option value="active">进行中</option>
          <option value="completed">已完成</option>
          <option value="manual">提前结束</option>
          <option value="timeout">超时结束</option>
          <option value="recovery">异常中断 / 待恢复</option>
          <option value="paused">已暂停</option>
        </select>
        <input
          className="input"
          type="date"
          aria-label="面试日期"
          value={date}
          onChange={(e) => update({ date: e.target.value })}
        />
        <Button type="submit">查找</Button>
        <Button type="button" variant="quiet" onClick={clear}>
          清空
        </Button>
      </form>
      <Notice error>{q.error?.message}</Notice>
      {q.error && <Button onClick={() => void q.refetch()}>重试加载</Button>}
      {!ready || q.isPending ? (
        <div className="loading">正在加载记录…</div>
      ) : q.data?.items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>候选人 / 面试编号</th>
                <th>面试岗位</th>
                <th>开始时间</th>
                <th>状态</th>
                <th>查看</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((s: any) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.phone_mask}</strong>
                    <small>{s.id.slice(0, 8)}</small>
                  </td>
                  <td data-label="岗位">{s.name}</td>
                  <td data-label="开始">
                    {new Date(s.started_at).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </td>
                  <td>
                    <Tag status={s.end_reason ?? s.status} />
                    {s.pending && <span className="tag warn">重面待审核</span>}
                  </td>
                  <td>
                    <Link
                      className="btn quiet"
                      href={`/admin/interviews/${s.id}`}
                    >
                      查看记录
                      <ArrowRight />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row between">
            <Button
              disabled={page === 1}
              onClick={() => update({ page: page - 1 })}
            >
              上一页
            </Button>
            <span className="small">第 {page} 页</span>
            <Button
              disabled={!q.data.hasMore}
              onClick={() => update({ page: page + 1 })}
            >
              下一页
            </Button>
          </div>
        </div>
      ) : (
        <div className="empty">
          <ClipboardList />
          <h2>
            {search || role || status || date
              ? "没有找到匹配的面试记录"
              : "这里还没有面试记录"}
          </h2>
          <p>
            {search || role || status || date
              ? "调整查找条件，或清空筛选后查看全部记录。"
              : "候选人开始正式面试后，记录会出现在这里。"}
          </p>
          <Button
            onClick={
              search || role || status || date ? clear : () => void q.refetch()
            }
          >
            {search || role || status || date ? "清空筛选" : "刷新记录"}
          </Button>
        </div>
      )}
    </Shell>
  );
}

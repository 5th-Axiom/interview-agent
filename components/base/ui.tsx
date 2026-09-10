"use client";
import { ButtonHTMLAttributes, ReactNode, useEffect, useRef } from "react";
export function Button({
  variant = "",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return <button {...props} className={`btn ${variant} ${className}`} />;
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="field field-group">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}
export function Notice({
  error,
  children,
}: {
  error?: boolean;
  children: ReactNode;
}) {
  return children ? (
    <div
      role={error ? "alert" : "status"}
      className={`notice ${error ? "error" : ""}`}
    >
      {children}
    </div>
  ) : null;
}
export function Dialog({
  open,
  onClose,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    else if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      onCancel={onClose}
      onClose={onClose}
    >
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
export function Tag({ status }: { status: string }) {
  const labels: Record<string, string> = {
    published: "已发布",
    draft: "草稿",
    disabled: "已停用",
    active: "进行中",
    recovery: "待恢复",
    paused: "已暂停",
    ended: "已结束",
    manual: "提前结束",
    completed: "已完成",
    timeout: "超时结束",
    pending: "待审核",
    approved: "已通过",
    rejected: "未通过",
    ready: "可查看",
    failed: "失败",
    running: "生成中",
    queued: "等待生成",
    partial: "部分缺失",
    processing: "处理中",
  };
  return (
    <span
      className={`tag ${["published", "approved", "completed", "ready"].includes(status) ? "live" : ""} ${["failed", "pending"].includes(status) ? "warn" : ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

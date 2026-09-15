"use client";
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, Dialog, Field, Notice } from "@/components/base/ui";
import {
  interviewStyles,
  type PromptGoal,
  type PromptDraftInput,
} from "@/shared/prompt-assistant";
import { usePromptAssistant } from "./use-prompt-assistant";

export function PromptAssistant({
  name,
  description,
  open,
  disabled,
  hasPrompt,
  onClose,
  onApply,
}: {
  name: string;
  description: string;
  open: boolean;
  disabled: boolean;
  hasPrompt: boolean;
  onClose: () => void;
  onApply: (prompt: string) => void;
}) {
  const a = usePromptAssistant(name, description, open);
  const [confirm, setConfirm] = useState<"apply" | "regenerate" | null>(null);
  const blocked = disabled || !!a.busy;
  const canApply = !blocked && !a.stale && a.draft.trim().length >= 80;
  function updateGoal(index: number, update: Partial<PromptGoal>) {
    a.setGoals(
      a.goals.map((goal, i) => (i === index ? { ...goal, ...update } : goal)),
    );
  }
  function apply() {
    if (!canApply) return;
    setConfirm(null);
    onApply(a.draft.trim());
  }
  function close() {
    a.cancel();
    setConfirm(null);
    onClose();
  }
  return (
    <>
      {/* Close the top confirmation first so the main dialog restores focus. */}
      <Dialog
        open={open && !!confirm}
        onClose={() => setConfirm(null)}
        title={confirm === "apply" ? "替换当前面试说明？" : "重新生成草稿？"}
      >
        <p>
          {confirm === "apply"
            ? "将用这份草稿替换编辑框里的面试说明。岗位名称和简介会保留，填入后需要手动保存或发布。"
            : "你已修改生成的草稿。重新生成成功后，会替换这份草稿中的修改。"}
        </p>
        <div className="actions">
          <Button onClick={() => setConfirm(null)}>继续编辑</Button>
          <Button
            variant="primary"
            disabled={
              confirm === "apply" ? !canApply : blocked || !a.canGenerate
            }
            onClick={() => {
              if (confirm === "apply") apply();
              else {
                setConfirm(null);
                void a.run("draft");
              }
            }}
          >
            {confirm === "apply" ? "确认替换" : "重新生成"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={open}
        onClose={close}
        title="帮我写面试说明"
        className="prompt-assistant-dialog"
      >
        <Button
          variant="quiet icon"
          className="prompt-assistant-close"
          aria-label="关闭面试说明助手"
          onClick={close}
        >
          <X />
        </Button>
        <div className="prompt-assistant">
          <p className="small muted">
            先确认想了解的能力，再生成说明。草稿会在下方预览，由你决定是否填入。
          </p>
          {!name.trim() && <Notice>请先关闭弹窗，填写岗位名称。</Notice>}
          <fieldset disabled={blocked} className="prompt-assistant-fields">
            <div className="row between">
              <h4>想了解哪些能力？</h4>
              <Button
                disabled={blocked || !name.trim() || !description.trim()}
                onClick={() => void a.run("goals")}
              >
                {a.busy === "goals" ? "正在提取能力…" : "从岗位简介提取"}
              </Button>
            </div>
            <p className="small muted">
              可直接填写 1–6 项。标为「重点」的能力会优先深入追问。
              {!description.trim() && "填写岗位简介后，也可以自动提取。"}
            </p>
            {a.goals.map((goal, index) => (
              <div className="prompt-goal-row" key={index}>
                <input
                  className="input"
                  aria-label={`考察能力 ${index + 1}`}
                  maxLength={120}
                  value={goal.name}
                  placeholder="例如：定位并解决前端性能问题"
                  onChange={(e) => updateGoal(index, { name: e.target.value })}
                />
                <select
                  aria-label={`能力 ${index + 1} 的考察重点`}
                  value={goal.priority}
                  onChange={(e) =>
                    updateGoal(index, {
                      priority: e.target.value as PromptGoal["priority"],
                    })
                  }
                >
                  <option value="normal">常规</option>
                  <option value="high">重点</option>
                </select>
                <Button
                  variant="quiet icon"
                  aria-label={`删除考察能力 ${index + 1}`}
                  disabled={a.goals.length === 1}
                  onClick={() =>
                    a.setGoals(a.goals.filter((_, i) => i !== index))
                  }
                >
                  <X />
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="quiet"
                disabled={a.goals.length >= 6}
                onClick={() => a.addGoal()}
              >
                <Plus />
                添加能力
              </Button>
            </div>
            {a.suggestions.length > 0 && (
              <div className="prompt-suggestions">
                <p className="small">
                  提取了以下建议，点击加入；已填写的能力会保留。
                </p>
                <div className="row">
                  {a.suggestions.map((goal, index) => (
                    <Button
                      key={index}
                      disabled={
                        a.goals.length >= 6 ||
                        a.goals.some((item) => item.name.trim() === goal.name)
                      }
                      onClick={() => a.addGoal(goal)}
                    >
                      <Plus />
                      {goal.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <Field label="怎么聊？">
              <select
                value={a.style}
                onChange={(e) =>
                  a.setStyle(e.target.value as PromptDraftInput["style"])
                }
              >
                {Object.entries(interviewStyles).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <p className="small muted">
              {
                {
                  open: "从真实经历出发灵活追问，不预设固定阶段或题单。",
                  planned: "先确定主题顺序，每个主题的问题随回答调整。",
                  fixed: "生成有顺序的主问题；你已有的必问题可写在下方。",
                  scenario: "围绕一个假设工作场景，逐步了解分析和决策过程。",
                }[a.style]
              }
            </p>
            <Field label="追问重点或补充要求（选填）">
              <textarea
                maxLength={3000}
                value={a.notes}
                onChange={(e) => a.setNotes(e.target.value)}
                placeholder="例如：重点问清个人贡献、方案取舍和结果证据。已有必问题也可写在这里。"
              />
            </Field>
          </fieldset>
          <Notice error>{a.error}</Notice>
          {a.testMode && (
            <Notice>测试模式：当前内容来自测试替身，未调用真实模型。</Notice>
          )}
          <div className="row">
            <Button
              variant="primary"
              disabled={blocked || !a.canGenerate}
              onClick={() =>
                a.draftEdited && a.draft
                  ? setConfirm("regenerate")
                  : void a.run("draft")
              }
            >
              {a.busy === "draft"
                ? "正在生成说明…"
                : a.draft
                  ? "重新生成草稿"
                  : "生成面试说明"}
            </Button>
            {a.busy && <Button onClick={a.cancel}>取消生成</Button>}
          </div>
          {a.busy && (
            <p role="status" className="small muted">
              {a.busy === "goals"
                ? "正在根据岗位简介整理建议，请稍候。"
                : "正在整理考察目标、问题与追问方式，请稍候。"}
            </p>
          )}
          {a.draft && (
            <div className="prompt-assistant-result">
              <Field label="面试说明草稿（可修改）">
                <textarea
                  className="prompt-assistant-draft"
                  value={a.draft}
                  maxLength={24000}
                  disabled={!!a.busy}
                  onChange={(e) => a.setDraft(e.target.value)}
                />
              </Field>
              {a.stale && (
                <Notice>岗位信息或考察设置已修改，请重新生成后再填入。</Notice>
              )}
              {a.draft.trim().length < 80 && (
                <Notice error>请保留至少 80 字的完整面试说明。</Notice>
              )}
              <div className="row between">
                <span className="small muted">
                  填入后仍可修改、试聊和保存。
                </span>
                <Button
                  variant="primary"
                  disabled={!canApply}
                  onClick={() => (hasPrompt ? setConfirm("apply") : apply())}
                >
                  填入面试说明
                </Button>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}

"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { Button, Dialog } from "@/components/base/ui";
import { TemplateBrowser } from "./template-browser";
import type { PromptTemplate } from "./prompt-templates";

export function TemplatePicker({
  hasPrompt,
  onClose,
  onApply,
}: {
  hasPrompt: boolean;
  onClose: () => void;
  onApply: (template: PromptTemplate) => void;
}) {
  const [pending, setPending] = useState<PromptTemplate | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      className={pending ? "" : "template-dialog"}
      title={pending ? "替换当前面试说明？" : "选择 Prompt 模板"}
    >
      {pending ? (
        <>
          <p>
            「{pending.name}」将替换编辑框中的
            Prompt。已填写的岗位名称和简介会保留。
          </p>
          <div className="actions">
            <Button autoFocus onClick={() => setPending(null)}>
              返回选择
            </Button>
            <Button variant="primary" onClick={() => onApply(pending)}>
              确认替换
            </Button>
          </div>
        </>
      ) : (
        <>
          <Button
            variant="quiet icon"
            className="template-close"
            aria-label="关闭模板选择"
            onClick={onClose}
          >
            <X />
          </Button>
          <p className="template-picker-intro">
            从三种面试方式中选择模板，选用后可继续修改 Prompt 并试聊。
          </p>
          <TemplateBrowser
            action={(template) => (
              <Button
                variant="primary"
                onClick={() =>
                  hasPrompt ? setPending(template) : onApply(template)
                }
              >
                使用此模板
              </Button>
            )}
          />
          <div className="actions">
            <Button onClick={onClose}>取消</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

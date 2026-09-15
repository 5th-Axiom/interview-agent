"use client";
import { useState, type ReactNode } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";
import { Button, Notice } from "@/components/base/ui";
import { promptTemplates, type PromptTemplate } from "./prompt-templates";

export function TemplateBrowser({
  action,
}: {
  action: (template: PromptTemplate) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useState(promptTemplates[0].id);
  const [kind, setKind] = useState("");
  const kinds = [...new Set(promptTemplates.map((template) => template.kind))];
  const currentKind = kinds.some((value) => value === kind) ? kind : "";
  const templates = promptTemplates.filter(
    (template) => !currentKind || template.kind === currentKind,
  );
  const selected =
    templates.find((template) => template.id === selectedId) ?? templates[0];
  return (
    <div className="template-browser">
      <div className="template-catalog">
        <label className="field">
          <span>按面试方式浏览</span>
          <select
            aria-label="模板面试方式"
            value={currentKind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">全部模板 · {promptTemplates.length} 套</option>
            {kinds.map((value) => (
              <option key={value} value={value}>
                {value} ·{" "}
                {
                  promptTemplates.filter((template) => template.kind === value)
                    .length
                }{" "}
                套
              </option>
            ))}
          </select>
        </label>
        <div className="template-list" aria-label="内置模板">
          {templates.map((template) => (
            <button
              type="button"
              key={template.id}
              className="template-option"
              aria-pressed={selected.id === template.id}
              onClick={() => setSelectedId(template.id)}
            >
              <span className="template-option-title">
                {template.name}
                <ArrowRight aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
        <p className="small template-catalog-note">
          从固定问题、主题引导或开放访谈开始，按岗位修改 Prompt 后即可试聊。
        </p>
      </div>
      <TemplateDetail
        key={selected.id}
        template={selected}
        action={action(selected)}
      />
    </div>
  );
}

function TemplateDetail({
  template,
  action,
}: {
  template: PromptTemplate;
  action: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  return (
    <article
      className="template-detail"
      aria-label={template.name + "模板内容"}
    >
      <header className="template-heading">
        <h2>{template.name}</h2>
        <p>{template.summary}</p>
        <div className="row template-actions">
          {action}
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(template.prompt);
                setCopyState("copied");
              } catch {
                setCopyState("failed");
              }
            }}
          >
            {copyState === "copied" ? <Check /> : <Copy />}
            {copyState === "copied" ? "已复制" : "复制 Prompt"}
          </Button>
        </div>
        <Notice error={copyState === "failed"}>
          {copyState === "failed"
            ? "复制未成功，请在下方模板内容中手动选择复制。"
            : copyState === "copied"
              ? "完整 Prompt 已复制。"
              : null}
        </Notice>
      </header>
      <section className="template-prompt" aria-label="模板内容">
        <h3>模板内容</h3>
        <p className="small">
          选用后可自由修改，试聊使用编辑框中的当前 Prompt。
        </p>
        <pre>{template.prompt}</pre>
      </section>
    </article>
  );
}

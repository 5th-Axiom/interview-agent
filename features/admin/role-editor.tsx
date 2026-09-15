"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Mic, BookOpen, Check, PenLine } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { VoiceOrb } from "@/components/business/voice-orb";
import { RolePreview } from "./role-preview";
import { Button, Field, Notice, Tag, Dialog } from "@/components/base/ui";
import { useAdminQuery } from "./use-admin";
import { mutate } from "./api";
import { Role, Session } from "@/shared/contracts";
import { useUnsavedChanges } from "./use-unsaved-changes";
import { rememberCreatedRoleDraft, takeCreatedRoleDraft } from "./role-draft";
import { TemplatePicker } from "./template-picker";
import { PromptAssistant } from "./prompt-assistant";
import { findPromptTemplate, templateRoleDraft } from "./prompt-templates";
export function RoleEditor({
  id,
  templateId,
}: {
  id: string;
  templateId?: string;
}) {
  const router = useRouter(),
    q = useAdminQuery("roles", "roles");
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [prompt, setPrompt] = useState(""),
    [saved, setSaved] = useState(""),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [showTemplates, setShowTemplates] = useState(false),
    [showPromptAssistant, setShowPromptAssistant] = useState(false),
    [leave, setLeave] = useState(false),
    [previewOpen, setPreviewOpen] = useState(false),
    [previewFinished, setPreviewFinished] = useState(false),
    [preview, setPreview] = useState<Session | null>(null);
  const initializedRole = useRef<string | null>(null);
  const role = q.data?.find((r: Role) => r.id === id);
  const current = JSON.stringify({ name, description, prompt });
  const currentRef = useRef(current);
  currentRef.current = current;
  const dirty = current !== saved;
  const navigation = useUnsavedChanges(!!saved && dirty);
  useEffect(() => {
    if (role) {
      if (initializedRole.current === role.id) return;
      initializedRole.current = role.id;
      const transferred = takeCreatedRoleDraft(role.id);
      if (transferred) {
        setRevision(transferred.revision);
        setName(transferred.draft.name);
        setDescription(transferred.draft.description);
        setPrompt(transferred.draft.prompt);
        setSaved(transferred.saved);
        return;
      }
      setRevision(role.revision);
      setName(role.name);
      setDescription(role.description);
      setPrompt(role.prompt);
      setSaved(
        JSON.stringify({
          name: role.name,
          description: role.description,
          prompt: role.prompt,
        }),
      );
    } else if (id === "new") {
      if (initializedRole.current === "new") return;
      initializedRole.current = "new";
      const template = findPromptTemplate(templateId);
      const draft = template
        ? templateRoleDraft(template)
        : { name: "", description: "", prompt: "" };
      setName(draft.name);
      setDescription(draft.description);
      setPrompt(draft.prompt);
      if (template)
        setMessage("已填入「" + template.name + "」，可修改后直接试聊。");
      else if (templateId) setError("没有找到该模板，请重新选择模板。");
      setRevision(0);
      setSaved(JSON.stringify({ name: "", description: "", prompt: "" }));
    }
  }, [id, role?.id, templateId]);
  async function save(publish = false, exit = false) {
    setBusy(true);
    setError("");
    try {
      const result = await mutate(`roles/${id}${publish ? "/publish" : ""}`, {
        name,
        description,
        prompt,
        expected_revision: revision,
      });
      setRevision(result.revision);
      setSaved(current);
      setMessage(publish ? "已发布，新面试将使用本次版本。" : "草稿已保存。");
      await q.refetch();
      if (exit && currentRef.current === current) router.push("/admin/roles");
      else if (id === "new") {
        rememberCreatedRoleDraft(result.id, {
          draft: JSON.parse(currentRef.current),
          saved: current,
          revision: result.revision,
        });
        router.replace(`/admin/roles/${result.id}`);
      }
      if (exit && currentRef.current !== current) {
        setLeave(false);
        setMessage("本次提交已保存，保存期间新增的修改仍保留在编辑框中。");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function trial() {
    setBusy(true);
    setError("");
    try {
      const s = await mutate<Session>("preview", {
        name,
        description,
        prompt,
        ...(id !== "new" ? { role_id: id } : {}),
      });
      setPreview({ ...s, name });
      setPreviewFinished(false);
      setPreviewOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (id !== "new" && q.isPending)
    return (
      <Shell admin>
        <div className="loading">正在读取岗位配置…</div>
      </Shell>
    );
  if (id !== "new" && !role)
    return (
      <Shell admin>
        <Notice error>
          {q.error?.message ?? "没有找到该岗位，请返回列表选择。"}
        </Notice>
        <Button onClick={() => void q.refetch()}>重试加载岗位</Button>
        <Button onClick={() => router.push("/admin/roles")}>
          返回岗位列表
        </Button>
      </Shell>
    );
  return (
    <Shell admin>
      <Dialog
        open={navigation.open}
        onClose={navigation.cancel}
        title="有尚未保存的修改"
      >
        <p>当前岗位配置尚未保存，是否继续编辑？</p>
        <div className="row">
          <Button onClick={navigation.cancel}>继续编辑</Button>
          <Button onClick={navigation.discard}>放弃修改</Button>
        </div>
      </Dialog>
      <button
        className="btn quiet back"
        onClick={() => (dirty ? setLeave(true) : router.push("/admin/roles"))}
      >
        <ArrowLeft />
        返回岗位列表
      </button>
      <header className="page-heading">
        <div>
          <h1>{id === "new" ? "创建面试岗位" : "配置面试岗位"}</h1>
          <p>写清楚想了解什么，AI 会结合候选人的回答自然追问。</p>
        </div>
        {role && <Tag status={role.status} />}
      </header>
      <div className="editor-grid">
        <div className="editor-form stack">
          <Field label="岗位名称 *">
            <input
              className="input"
              maxLength={100}
              placeholder="例如：前端工程师"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="岗位简介（选填）">
            <textarea
              placeholder="简要介绍职责与关注的能力，帮助候选人了解岗位。"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <div className="row between">
            <h3>面试说明 Prompt *</h3>
            <div className="row">
              <Button
                variant="quiet"
                disabled={busy}
                aria-haspopup="dialog"
                onClick={() => setShowPromptAssistant(true)}
              >
                <PenLine />
                帮我写面试说明
              </Button>
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => setShowTemplates(true)}
              >
                <BookOpen />
                选择模板
              </Button>
            </div>
          </div>
          <PromptAssistant
            key={id}
            name={name}
            description={description}
            open={showPromptAssistant}
            disabled={busy}
            hasPrompt={!!prompt.trim()}
            onClose={() => setShowPromptAssistant(false)}
            onApply={(draft) => {
              setPrompt(draft);
              setShowPromptAssistant(false);
              setError("");
              setMessage("已填入生成的面试说明，可继续修改后试聊。");
            }}
          />
          <textarea
            className="prompt"
            aria-label="面试说明 Prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={24000}
            placeholder="你希望了解哪些经历？如何追问？在什么情况下结束面试？"
          />
          <p className="small">
            保存草稿不会影响已发布内容。重新发布只影响新开始的面试。
          </p>
          <Notice error>{error || q.error?.message}</Notice>
          <Notice>{message}</Notice>
        </div>
        <aside className="preview-aside">
          <h2>先聊一聊</h2>
          <p>用当前填写的说明体验一次面试，再决定是否发布。</p>
          <VoiceOrb />
          <Button
            variant="primary full"
            disabled={busy || !name.trim() || !prompt.trim()}
            onClick={() => void trial()}
          >
            <Mic />
            开始试聊
          </Button>
          <p className="small">
            试聊不会占用候选人资格，也不会出现在正式面试记录中。
          </p>
          {previewFinished && (
            <Button variant="quiet" onClick={() => setPreviewOpen(true)}>
              查看上次试聊记录
            </Button>
          )}
        </aside>
      </div>
      <footer className="sticky-actions">
        <span className="row small muted">
          <Check />
          {busy ? "正在保存…" : dirty ? "有未保存修改" : "已保存"}
        </span>
        <div className="row">
          <Button
            disabled={busy || !name.trim() || !prompt.trim()}
            onClick={() => void save()}
          >
            保存草稿
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim() || !prompt.trim()}
            onClick={() => void save(true)}
          >
            发布岗位
          </Button>
        </div>
      </footer>
      {showTemplates && (
        <TemplatePicker
          hasPrompt={!!prompt.trim()}
          onClose={() => setShowTemplates(false)}
          onApply={(template) => {
            const draft = templateRoleDraft(template);
            setPrompt(draft.prompt);
            if (!name.trim()) setName(draft.name);
            if (!description.trim()) setDescription(draft.description);
            setMessage("已填入「" + template.name + "」，可修改后直接试聊。");
            setError("");
            setShowTemplates(false);
          }}
        />
      )}
      <Dialog
        open={leave}
        onClose={() => setLeave(false)}
        title="有尚未保存的修改"
      >
        <p>是否先保存当前岗位说明？</p>
        <div className="actions">
          <Button onClick={() => router.push("/admin/roles")}>放弃修改</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void save(false, true)}
          >
            保存后离开
          </Button>
        </div>
      </Dialog>
      {preview && (
        <RolePreview
          key={preview.id}
          session={preview}
          open={previewOpen}
          onFinished={() => setPreviewFinished(true)}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </Shell>
  );
}

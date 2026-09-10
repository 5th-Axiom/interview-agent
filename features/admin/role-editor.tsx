"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Mic, Eye, Copy, Check } from "lucide-react";
import { Shell } from "@/components/business/shell";
import { VoiceOrb } from "@/components/business/voice-orb";
import { VoicePanel } from "@/components/business/voice-panel";
import { Button, Field, Notice, Tag, Dialog } from "@/components/base/ui";
import { useAdminQuery } from "./use-admin";
import { api, mutate } from "./api";
import { Role, Session } from "@/shared/contracts";
import { useUnsavedChanges } from "./use-unsaved-changes";
const example =
  "你是一位专业、友好的面试官。先邀请候选人简单介绍自己，再围绕其真实项目经历自然追问。每次只问一个问题，了解背景、个人贡献、关键取舍与结果。避免重复已讨论的话题，允许候选人要求解释。了解关键经历后，邀请候选人提问，最后礼貌地自然收尾。";
export function RoleEditor({ id }: { id: string }) {
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
    [showExample, setShowExample] = useState(false),
    [replace, setReplace] = useState(false),
    [leave, setLeave] = useState(false),
    [preview, setPreview] = useState<Session | null>(null),
    [testMode, setTestMode] = useState(false);
  const role = q.data?.find((r: Role) => r.id === id);
  const current = JSON.stringify({ name, description, prompt });
  const dirty = current !== saved;
  const navigation = useUnsavedChanges(!!saved && dirty);
  useEffect(() => {
    void api("config")
      .then((c) => setTestMode(c.testMode))
      .catch(() => setError("配置读取失败，请刷新重试。"));
  }, []);
  useEffect(() => {
    if (role) {
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
    } else if (id === "new")
      setSaved(JSON.stringify({ name: "", description: "", prompt: "" }));
  }, [role?.id]);
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
      if (exit) router.push("/admin/roles");
      else if (id === "new") router.replace(`/admin/roles/${result.id}`);
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
              <Button variant="quiet" onClick={() => setShowExample(true)}>
                <Eye />
                查看示例
              </Button>
              <Button
                variant="quiet"
                onClick={() =>
                  prompt.trim() ? setReplace(true) : setPrompt(example)
                }
              >
                <Copy />
                使用示例
              </Button>
            </div>
          </div>
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
      <Dialog
        open={showExample}
        onClose={() => setShowExample(false)}
        title="面试说明示例"
      >
        <p>{example}</p>
        <Button onClick={() => setShowExample(false)}>关闭</Button>
      </Dialog>
      <Dialog
        open={replace}
        onClose={() => setReplace(false)}
        title="替换当前面试说明？"
      >
        <p>使用示例会替换编辑框中的现有内容。</p>
        <div className="actions">
          <Button onClick={() => setReplace(false)}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              setPrompt(example);
              setReplace(false);
            }}
          >
            替换内容
          </Button>
        </div>
      </Dialog>
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
      <Dialog
        className="preview"
        open={!!preview}
        onClose={() => {
          if (preview)
            void mutate(`sessions/${preview.id}/control`, {
              action: "end",
            }).catch(() =>
              setError("试聊语音已停止，结束状态暂未保存，请稍后重试。"),
            );
          setPreview(null);
        }}
        title="岗位试聊"
      >
        {preview && (
          <VoicePanel
            session={preview}
            testMode={testMode}
            preview
            autoStart
            onEnded={() => setPreview(null)}
            onRefresh={() => {}}
          />
        )}
      </Dialog>
    </Shell>
  );
}

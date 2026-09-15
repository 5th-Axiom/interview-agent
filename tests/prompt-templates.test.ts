import { test } from "node:test";
import assert from "node:assert/strict";
import { roleSchema } from "../shared/contracts";
import {
  findPromptTemplate,
  promptTemplates,
  templateRoleDraft,
} from "../features/admin/prompt-templates";

test("built-in Prompts are complete valid role drafts and metadata never rewrites their content", () => {
  assert.equal(
    new Set(promptTemplates.map((template) => template.id)).size,
    promptTemplates.length,
  );
  for (const template of promptTemplates) {
    const draft = templateRoleDraft(template);
    assert.deepEqual(roleSchema.parse(draft), draft);
    assert.equal(draft.prompt, template.prompt);
    const relabeled = {
      ...template,
      name: "另一个显示名称",
      kind: "开放访谈" as const,
    };
    assert.equal(templateRoleDraft(relabeled).prompt, template.prompt);
  }
});

test("unknown template lookup fails closed and a freely edited draft leaves the source Prompt intact", () => {
  assert.equal(findPromptTemplate("missing-template"), undefined);
  assert.equal(findPromptTemplate(), undefined);
  const template = findPromptTemplate("frontend-fixed")!;
  const original = template.prompt;
  const draft = templateRoleDraft(template);
  draft.prompt =
    "不设置阶段或题单。\n请围绕候选人的回答自然交流，充分了解后收尾。";
  assert.equal(roleSchema.parse(draft).prompt, draft.prompt);
  assert.equal(template.prompt, original);
  assert.equal(templateRoleDraft(template).prompt, original);
});

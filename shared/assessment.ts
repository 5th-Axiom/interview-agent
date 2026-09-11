import { z } from "zod";

export const legacyAssessmentPrompt =
  "根据面试原始记录整理能力观察、优势、需进一步确认的问题。每项观察引用真实 event_id。不推断敏感属性，不给录用结论。缺少证据时明确说明。";
export const defaultAssessmentPrompt =
  "直接给出本次面试结论：是否建议进入下一轮，以及最主要的理由。先用一句话概括，再列 3～5 条关键依据，每条不超过 60 字。结合岗位要求判断能力和个人贡献，避免复述对话。证据不足时明确说明需要补充什么；不把未问到、未听清等同于能力不合格。不推断敏感属性，每项判断引用原始记录。";
export function assessmentPrompt(value?: string | null) {
  return !value || value.trim() === legacyAssessmentPrompt
    ? defaultAssessmentPrompt
    : value;
}
export const conclusionLabels = {
  advance: "建议进入下一轮",
  follow_up: "建议补充面试",
  reject: "不建议进入下一轮",
  insufficient: "信息不足，暂无法判断",
} as const;
const sources = z.array(z.string().uuid()).max(4);
export const assessmentReportSchema = z.object({
  conclusion: z.object({
    verdict: z.enum(["advance", "follow_up", "reject", "insufficient"]),
    summary: z.string().trim().min(1).max(80),
    sources,
  }),
  items: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(60),
        sources: sources.min(1),
      }),
    )
    .max(5),
});
export type AssessmentReport = z.infer<typeof assessmentReportSchema>;

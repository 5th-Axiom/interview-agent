import { z } from "zod";

export const interviewStyles = {
  open: "开放访谈",
  planned: "按主题推进",
  fixed: "固定问题",
  scenario: "场景推演",
} as const;

export const promptGoalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.enum(["high", "normal"]),
});
const brief = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
};
export const promptAssistantSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goals"),
    ...brief,
    description: brief.description.min(1),
  }),
  z.object({
    action: z.literal("draft"),
    ...brief,
    goals: z.array(promptGoalSchema).min(1).max(6),
    style: z.enum(["open", "planned", "fixed", "scenario"]),
    notes: z.string().trim().max(3000),
  }),
]);
export const suggestedGoalsSchema = z.object({
  goals: z.array(promptGoalSchema).min(1).max(6),
});
export const suggestedPromptSchema = z.object({
  prompt: z.string().trim().min(80).max(24000),
});
export type PromptGoal = z.infer<typeof promptGoalSchema>;
export type PromptAssistantInput = z.infer<typeof promptAssistantSchema>;
export type PromptDraftInput = Extract<
  PromptAssistantInput,
  { action: "draft" }
>;
export type SuggestedGoals = z.infer<typeof suggestedGoalsSchema> & {
  testMode: boolean;
};
export type SuggestedPrompt = z.infer<typeof suggestedPromptSchema> & {
  testMode: boolean;
};

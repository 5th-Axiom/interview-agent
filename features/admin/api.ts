export { api, mutate, RequestError } from "../interview/api";
import { api } from "../interview/api";
import type { PreviewHistory } from "@/shared/contracts";
import type {
  PromptDraftInput,
  SuggestedGoals,
  SuggestedPrompt,
} from "@/shared/prompt-assistant";

export function suggestPromptGoals(
  brief: { name: string; description: string },
  signal: AbortSignal,
) {
  return api<SuggestedGoals>(
    "admin/prompt-assistant",
    { action: "goals", ...brief },
    signal,
  );
}

export function generatePromptDraft(
  input: PromptDraftInput,
  signal: AbortSignal,
) {
  // Generation has no saved command and is retried only by an explicit click.
  return api<SuggestedPrompt>("admin/prompt-assistant", input, signal);
}

export function getPreviewHistory(id: string, signal?: AbortSignal) {
  return api<PreviewHistory>(
    `sessions/${id}/preview-history`,
    undefined,
    signal,
  );
}

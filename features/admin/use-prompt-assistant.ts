"use client";
import { useEffect, useRef, useState } from "react";
import type { PromptDraftInput, PromptGoal } from "@/shared/prompt-assistant";
import { generatePromptDraft, suggestPromptGoals } from "./api";

export function usePromptAssistant(
  name: string,
  description: string,
  open: boolean,
) {
  const [goals, setGoals] = useState<PromptGoal[]>([
    { name: "", priority: "normal" },
  ]);
  const [suggestions, setSuggestions] = useState<PromptGoal[]>([]);
  const [style, setStyle] = useState<PromptDraftInput["style"]>("open");
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState("");
  const [generated, setGenerated] = useState("");
  const [draftSource, setDraftSource] = useState("");
  const [busy, setBusy] = useState<"goals" | "draft" | null>(null);
  const [error, setError] = useState("");
  const [testMode, setTestMode] = useState(false);
  const request = useRef<AbortController | null>(null);
  const source = JSON.stringify({ name, description, goals, style, notes });
  const currentSource = useRef(source);
  currentSource.current = source;

  function cancel() {
    request.current?.abort();
    request.current = null;
    setBusy(null);
  }
  useEffect(() => {
    cancel();
  }, [name, description, open]);
  useEffect(() => () => request.current?.abort(), []);

  async function run(action: "goals" | "draft") {
    cancel();
    const controller = new AbortController();
    request.current = controller;
    setBusy(action);
    setError("");
    try {
      const result =
        action === "goals"
          ? await suggestPromptGoals({ name, description }, controller.signal)
          : await generatePromptDraft(
              { action, name, description, goals, style, notes },
              controller.signal,
            );
      // Ignore cancelled work and responses based on a superseded role/brief.
      if (
        request.current !== controller ||
        controller.signal.aborted ||
        currentSource.current !== source
      )
        return;
      setTestMode(result.testMode);
      if ("goals" in result) {
        if (goals.every((goal) => !goal.name.trim())) {
          setGoals(result.goals);
          setSuggestions([]);
        } else setSuggestions(result.goals);
      } else {
        setDraft(result.prompt);
        setGenerated(result.prompt);
        setDraftSource(source);
      }
    } catch (e) {
      if (request.current === controller && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : "生成失败，请重试。");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  function addGoal(goal: PromptGoal = { name: "", priority: "normal" }) {
    setGoals((current) =>
      current.every((item) => !item.name.trim())
        ? [goal]
        : current.length < 6
          ? [...current, goal]
          : current,
    );
  }
  return {
    goals,
    setGoals,
    suggestions,
    addGoal,
    style,
    setStyle,
    notes,
    setNotes,
    draft,
    setDraft,
    busy,
    error,
    testMode,
    cancel,
    run,
    stale: !!draft && source !== draftSource,
    draftEdited: draft !== generated,
    canGenerate:
      !!name.trim() &&
      goals.length > 0 &&
      goals.every((goal) => !!goal.name.trim()),
  };
}

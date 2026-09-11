import { modelProfile } from "./runtime-profile";
// Conservative approximation, not a provider tokenizer. CJK and symbols reserve more room than ASCII.
export function estimateTokens(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0,
    other = 0;
  for (const c of text)
    if (c.codePointAt(0)! < 128) ascii++;
    else other++;
  return Math.ceil(ascii / 3 + other * 1.5) + 16;
}
export function inputLimit(profile = modelProfile("interview")) {
  return Math.max(
    0,
    Math.min(
      profile.maxInput,
      profile.contextWindow - profile.outputReserve - profile.safetyMargin,
    ),
  );
}
export function contextPressure(
  tokens: number,
  profile = modelProfile("interview"),
) {
  const ratio = tokens / inputLimit(profile);
  return ratio >= 1
    ? "blocked"
    : ratio >= 0.8
      ? "protect"
      : ratio >= 0.65
        ? "summarize"
        : "normal";
}

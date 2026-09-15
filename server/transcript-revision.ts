/** Narrow ASR formatting equivalence, only for revisions of the same input turn. */
function formattingKey(text: string) {
  return (
    text
      .normalize("NFC")
      .trim()
      .replace(/\s+/gu, " ")
      // Preserve word/number boundaries in Latin text and numeric expressions.
      .replace(/(?<=\p{Script=Han}) | (?=\p{Script=Han})/gu, "")
      // A comma after a hesitation is formatting; arbitrary commas can change meaning
      // (e.g. 不，使用缓存 vs 不使用缓存), so do not strip punctuation wholesale.
      .replace(/^(嗯|呃|哦|啊)[,，]/u, "$1")
      .replace(/[。.]$/u, "")
      .trim()
  );
}

export function sameTranscriptContent(previous: string, next: string) {
  const key = formattingKey(previous);
  return key.length > 0 && key === formattingKey(next);
}

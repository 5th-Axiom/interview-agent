const memory = new Map<string, string>();
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function pendingCommand(path: string, body: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(path + "\n" + canonical(body)),
  );
  const key =
    "interview-command:" +
    Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  let id = memory.get(key);
  try {
    id ??= sessionStorage.getItem(key) ?? undefined;
  } catch {
    /* Storage can be disabled. */
  }
  if (!id) {
    if (memory.size >= 200)
      throw new Error("待确认操作过多，请先重试未完成的操作");
    id = crypto.randomUUID();
  }
  memory.set(key, id);
  try {
    sessionStorage.setItem(key, id);
  } catch {
    /* Memory still preserves manual retries. */
  }
  return {
    id,
    finish() {
      if (memory.get(key) === id) memory.delete(key);
      try {
        if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
      } catch {}
    },
  };
}

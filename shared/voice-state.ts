export class GenerationGate {
  private generation = 0;
  private controller: AbortController | null = null;
  begin() {
    this.cancel();
    const generation = this.generation;
    this.controller = new AbortController();
    return {
      generation,
      signal: this.controller.signal,
      current: () =>
        this.generation === generation && !this.controller?.signal.aborted,
    };
  }
  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
}
export class DurableQueue<T extends { event_id: string }> {
  private pending = new Map<string, T>();
  constructor(private limit = 100) {}
  add(item: T) {
    if (this.pending.size >= this.limit && !this.pending.has(item.event_id))
      throw new Error("待保存内容过多，请暂停并恢复连接");
    this.pending.set(item.event_id, item);
  }
  batch(limit = 20) {
    return Array.from(this.pending.values())
      .slice(0, limit)
      .map((v) => ({ ...v }));
  }
  acknowledge(ids: string[]) {
    for (const id of ids) this.pending.delete(id);
  }
  get size() {
    return this.pending.size;
  }
}
export class TranscriptAccumulator {
  private fragments = new Map<string, { revision: number; text: string }>();
  update(source: string, segment: string, revision: number, text: string) {
    const key = `${source}:${segment}`,
      old = this.fragments.get(key);
    if (old && revision <= old.revision) return false;
    this.fragments.set(key, { revision, text });
    return true;
  }
  text() {
    return Array.from(this.fragments.values())
      .map((f) => f.text)
      .join(" ")
      .trim();
  }
  clear() {
    this.fragments.clear();
  }
}
export function validateSources(
  items: { sources: string[] }[],
  allowed: Set<string>,
) {
  return items.every(
    (i) => i.sources.length > 0 && i.sources.every((s) => allowed.has(s)),
  );
}

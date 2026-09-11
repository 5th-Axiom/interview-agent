/** Bounded producer/consumer queue. Cancellation wakes readers and blocked writers. */
export class AsyncQueue<T> {
  private values: { value: T; weight: number }[] = [];
  private weight = 0;
  private waiters = new Set<() => void>();
  private ended = false;
  private failure: unknown;
  constructor(
    private capacity: number,
    private weigh: (value: T) => number = () => 1,
    private maxItems = Infinity,
  ) {}
  private wake() {
    for (const fn of this.waiters) fn();
    this.waiters.clear();
  }
  private async changed(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(done);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(done);
        reject(signal?.reason);
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async push(value: T, signal?: AbortSignal) {
    const weight = this.weigh(value);
    if (!Number.isFinite(weight) || weight < 0 || weight > this.capacity)
      throw new Error("Queue item exceeds capacity");
    while (
      (this.weight + weight > this.capacity ||
        this.values.length >= this.maxItems) &&
      !this.ended
    )
      await this.changed(signal);
    signal?.throwIfAborted();
    if (this.ended) throw this.failure ?? new Error("Queue closed");
    this.values.push({ value, weight });
    this.weight += weight;
    this.wake();
  }
  close(error?: unknown) {
    this.ended = true;
    this.failure = error;
    this.wake();
  }
  async *read(signal?: AbortSignal): AsyncGenerator<T> {
    while (true) {
      signal?.throwIfAborted();
      const next = this.values.shift();
      if (next) {
        this.weight -= next.weight;
        this.wake();
        yield next.value;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await this.changed(signal);
    }
  }
  get size() {
    return this.weight;
  }
}

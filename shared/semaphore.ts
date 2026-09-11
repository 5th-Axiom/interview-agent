export class Semaphore {
  private active = 0;
  private waiters: {
    resolve: () => void;
    reject: (e: unknown) => void;
    signal?: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(
    private capacity: number,
    private backlog = 100,
  ) {}
  async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active >= this.capacity) {
      if (this.waiters.length >= this.backlog)
        throw new Error("Provider queue full");
      await new Promise<void>((resolve, reject) => {
        const item = {
          resolve,
          reject,
          signal,
          abort: () => {
            this.waiters = this.waiters.filter((w) => w !== item);
            reject(signal.reason);
          },
        };
        this.waiters.push(item);
        signal.addEventListener("abort", item.abort, { once: true });
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.abort);
        next.resolve();
      } else this.active--;
    };
  }
}

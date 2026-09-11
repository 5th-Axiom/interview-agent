/** Bounded ordered work; fast controls use a different lane from storage. */
export class TaskLane {
  private tail = Promise.resolve();
  private weight = 0;
  constructor(private maximum: number) {}
  run<T>(weight: number, task: () => Promise<T>): Promise<T> {
    if (this.weight + weight > this.maximum)
      return Promise.reject(new Error("Queue capacity exceeded"));
    this.weight += weight;
    const result = this.tail.then(task);
    this.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.weight -= weight;
      });
    return result;
  }
  get pending() {
    return this.weight;
  }
  drain() {
    return this.tail;
  }
}

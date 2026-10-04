/** Serialize async work per key; a failed task must not poison later work. */
export class SerialQueue {
  private tails = new Map<string, Promise<void>>();
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.tails.get(key) ?? Promise.resolve()).then(action);
    const settled = task.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    void settled.then(() => { if (this.tails.get(key) === settled) { this.tails.delete(key); } });
    return task;
  }
  async idle(key: string): Promise<void> {
    // Work can arrive while a caller is waiting for the current tail.
    while (this.tails.has(key)) { await this.tails.get(key); }
  }
}

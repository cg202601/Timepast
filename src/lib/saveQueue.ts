export class NoteSaveQueue<T> {
  private pending: T | null = null;
  private timer: number | undefined;
  private tail: Promise<void> = Promise.resolve();
  private version = 0;
  prepareFlush?: () => void;
  onSaved?: () => void;
  onError?: (error: unknown) => void;

  constructor(private readonly save: (value: T) => Promise<unknown>) {}

  schedule(value: T, delay: number) {
    this.version += 1;
    this.pending = value;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      void this.flush().catch(() => undefined);
    }, delay);
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.pending;
    const version = this.version;
    this.pending = null;
    if (next !== null) {
      this.tail = this.tail.catch(() => undefined)
        .then(() => this.save(next))
        .then(() => { this.onSaved?.(); })
        .catch((error) => {
          if (this.pending === null && this.version === version) this.pending = next;
          this.onError?.(error);
          throw error;
        });
    }
    return this.tail;
  }
}

export interface WorkingItem {
  readonly text: string;
  readonly lastTouchedAt: number;
  readonly activations: number;
}

export interface WorkingBufferSnapshot {
  readonly active: readonly WorkingItem[];
  readonly silent: readonly WorkingItem[];
  readonly size: number;
}

export class WorkingBuffer {
  private readonly items = new Map<string, WorkingItem>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  touch(text: string, now: number): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const previous = this.items.get(trimmed);
    this.items.set(trimmed, {
      text: trimmed,
      lastTouchedAt: now,
      activations: (previous?.activations ?? 0) + 1,
    });
    this.prune(now);
  }

  has(text: string, now: number): boolean {
    const item = this.items.get(text.trim());
    return item !== undefined && now - item.lastTouchedAt <= this.ttlMs;
  }

  reactivate(cue: string, now: number): readonly WorkingItem[] {
    this.prune(now);
    const terms = cue
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length >= 3);
    if (terms.length === 0) return [];
    return [...this.items.values()]
      .filter((item) => now - item.lastTouchedAt > this.ttlMs / 2)
      .filter((item) => terms.some((term) => item.text.toLowerCase().includes(term)))
      .toSorted((a, b) => b.activations - a.activations || (a.text < b.text ? -1 : 1));
  }

  snapshot(now: number): WorkingBufferSnapshot {
    this.prune(now);
    const all = [...this.items.values()];
    return {
      active: all
        .filter((item) => now - item.lastTouchedAt <= this.ttlMs / 2)
        .toSorted((a, b) => b.lastTouchedAt - a.lastTouchedAt),
      silent: all.filter((item) => now - item.lastTouchedAt > this.ttlMs / 2),
      size: all.length,
    };
  }

  clear(): void {
    this.items.clear();
  }

  private prune(now: number): void {
    for (const [key, item] of this.items) {
      if (now - item.lastTouchedAt > this.ttlMs) this.items.delete(key);
    }
    while (this.items.size > this.capacity) {
      const oldest = [...this.items.entries()].toSorted(
        (a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt || (a[0] < b[0] ? -1 : 1),
      )[0];
      if (oldest === undefined) break;
      this.items.delete(oldest[0]);
    }
  }
}

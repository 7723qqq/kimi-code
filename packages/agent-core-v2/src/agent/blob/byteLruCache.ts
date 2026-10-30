export class ByteLruCache {
  private readonly map = new Map<string, Buffer>();
  private currentBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): Buffer | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: Buffer): void {
    const size = value.byteLength;

    this.remove(key);

    if (size > this.maxBytes) return;

    while (this.map.size > 0 && this.currentBytes + size > this.maxBytes) {
      this.evictOldest();
    }

    this.currentBytes += size;
    this.map.set(key, value);
  }

  private evictOldest(): void {
    const oldest = this.map.keys().next().value;
    if (oldest === undefined) return;
    this.remove(oldest);
  }

  private remove(key: string): void {
    const value = this.map.get(key);
    if (value === undefined) return;
    this.currentBytes -= value.byteLength;
    this.map.delete(key);
  }
}

/**
 * `blob` domain — byte-bounded LRU cache.
 *
 * A small, dependency-free cache whose capacity is measured in **bytes** rather
 * than entries. Hits refresh an entry to most-recently-used; inserts evict the
 * least-recently-used entries until the payload fits. A single payload larger
 * than `maxBytes` is never cached.
 *
 * Supports `delete` for explicit invalidation and `has` for non-touching
 * membership checks.
 *
 * Module-private helper; not part of the package surface. Owned as a value
 * (not a DI service) so each agent keeps its own cache. Promote to a shared
 * util only when a second caller appears.
 */

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

  /** Check membership **without** refreshing LRU position. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: Buffer): void {
    const size = value.byteLength;
    const existing = this.map.get(key);

    if (size > this.maxBytes) {
      if (existing !== undefined) {
        this.currentBytes -= existing.byteLength;
        this.map.delete(key);
      }
      return;
    }

    if (existing !== undefined) {
      this.currentBytes -= existing.byteLength;
      this.map.delete(key);
    } else {
      while (this.map.size > 0 && this.currentBytes + size > this.maxBytes) {
        this.evictOldest();
      }
    }

    this.currentBytes += size;
    this.map.set(key, value);
  }

  /** Remove a single entry, re-accumulating byte accounting. Returns true if
   *  the key was present. */
  delete(key: string): boolean {
    const value = this.map.get(key);
    if (value === undefined) return false;
    this.currentBytes -= value.byteLength;
    this.map.delete(key);
    return true;
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.map.size;
  }

  /** Current bytes consumed by cached entries. */
  get bytes(): number {
    return this.currentBytes;
  }

  private evictOldest(): void {
    const oldest = this.map.keys().next().value;
    if (oldest === undefined) return;
    const value = this.map.get(oldest)!;
    this.currentBytes -= value.byteLength;
    this.map.delete(oldest);
  }
}

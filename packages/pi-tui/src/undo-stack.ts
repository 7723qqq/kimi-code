/**
 * Generic undo stack with clone-on-push semantics and a depth cap.
 *
 * Stores snapshots for undo. Popped snapshots are returned directly (no
 * re-cloning) since they are already detached.
 *
 * The clone strategy is injectable because the default (`structuredClone`)
 * copies every object the snapshot reaches. A snapshot that shares a large,
 * append-only registry (the editor's paste payloads) can hand in a shallow
 * clone instead, as long as that registry's entries are never mutated in
 * place: replacing an entry with a new string is fine, editing one is not.
 */
export class UndoStack<S> {
  private stack: S[] = [];
  private readonly clone: (state: S) => S;
  private readonly maxDepth: number;

  constructor(clone: (state: S) => S = structuredClone, maxDepth: number = 200) {
    this.clone = clone;
    this.maxDepth = maxDepth;
  }

  /** Push a clone of the given state, dropping the oldest snapshot past maxDepth. */
  push(state: S): void {
    this.stack.push(this.clone(state));
    if (this.stack.length > this.maxDepth) {
      this.stack.splice(0, this.stack.length - this.maxDepth);
    }
  }

  /** Pop and return the most recent snapshot, or undefined if empty. */
  pop(): S | undefined {
    return this.stack.pop();
  }

  /** Remove all snapshots. */
  clear(): void {
    this.stack.length = 0;
  }

  get length(): number {
    return this.stack.length;
  }
}

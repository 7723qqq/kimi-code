/**
 * Lifecycle primitives for DI-managed services: `IDisposable` interface, a
 * `Disposable` base class, plus the helper primitives (`DisposableStore`,
 * `MutableDisposable`, `DisposableMap`, `DisposableSet`, `toDisposable`,
 * `combinedDisposable`, `dispose`, `disposeOnReturn`, `Disposable.None`) that
 * `Event<T>` / `Emitter<T>` (in `base/common/event.ts`) build on top of.
 *
 * Modelled after VSCode's `base/common/lifecycle.ts`. Two intentional
 * deviations from upstream:
 *
 * 1. **Error policy** — VSCode's iterable `dispose(...)` collects per-child
 *    errors and throws an `AggregateError` at the end. Here every dispose
 *    path routes failures through `onUnexpectedError` and continues, so a
 *    single misbehaving child cannot abort sibling teardown. Same policy
 *    `Emitter.fire()` uses; keep it consistent.
 * 2. **Disposable tracker** — `IDisposableTracker` interface and the
 *    plumbing (`trackDisposable` / `markAsDisposed` / `setParentOfDisposable`)
 *    are present, but `disposableTracker` defaults to `null` so there is
 *    zero overhead. Install a `DisposableTracker` in test setup (or a custom
 *    one in a debug build) when leak hunting. We do not ship the
 *    `GCBasedDisposableTracker` variant — `FinalizationRegistry` timing is
 *    non-deterministic enough to produce noisy reports.
 *
 * Sibling teardown order is **insertion order** (`Set` iteration). Subclasses
 * that need a specific order must sequence teardown explicitly inside
 * `override dispose()` before calling `super.dispose()`.
 */

import { onUnexpectedError } from '../errors/unexpectedError';

// #region Disposable Tracking

/**
 * Hook surface for tracking living disposables, parentage, and lifecycle
 * transitions. Install via `setDisposableTracker`. Defaults to `null`
 * (zero overhead).
 */
export interface IDisposableTracker {
  /** Called on construction of every disposable. */
  trackDisposable(disposable: IDisposable): void;
  /**
   * Called when a disposable is registered as child of another. If `parent`
   * is `null`, the disposable was detached from its former parent (e.g. by
   * `DisposableStore.deleteAndLeak`).
   */
  setParent(child: IDisposable, parent: IDisposable | null): void;
  /** Called after a disposable's `dispose()` runs. */
  markAsDisposed(disposable: IDisposable): void;
  /**
   * Mark a disposable as a singleton (lives for the lifetime of the process)
   * so it isn't reported as a leak.
   */
  markAsSingleton(disposable: IDisposable): void;
}

interface DisposableInfo {
  value: IDisposable;
  source: string | null;
  parent: IDisposable | null;
  isSingleton: boolean;
  idx: number;
}

/**
 * Default tracker for test / dev use. Records a constructor stack on each
 * `trackDisposable` call and removes the entry on `markAsDisposed`. After a
 * suspected leak window (e.g. an `afterAll` hook), call
 * `getTrackedDisposables()` to inspect what's still alive.
 *
 * Roots whose ancestor was marked as a singleton are filtered out (they
 * intentionally live for the process).
 */
export class DisposableTracker implements IDisposableTracker {
  private static idx = 0;
  private readonly livingDisposables = new Map<IDisposable, DisposableInfo>();

  private getDisposableData(d: IDisposable): DisposableInfo {
    let val = this.livingDisposables.get(d);
    if (!val) {
      val = {
        parent: null,
        source: null,
        isSingleton: false,
        value: d,
        idx: DisposableTracker.idx++,
      };
      this.livingDisposables.set(d, val);
    }
    return val;
  }

  trackDisposable(d: IDisposable): void {
    const data = this.getDisposableData(d);
    if (!data.source) {
      data.source = new Error().stack ?? null;
    }
  }

  setParent(child: IDisposable, parent: IDisposable | null): void {
    this.getDisposableData(child).parent = parent;
  }

  markAsDisposed(x: IDisposable): void {
    this.livingDisposables.delete(x);
  }

  markAsSingleton(d: IDisposable): void {
    this.getDisposableData(d).isSingleton = true;
  }

  private getRootParent(
    data: DisposableInfo,
    cache: Map<DisposableInfo, DisposableInfo>,
  ): DisposableInfo {
    const cached = cache.get(data);
    if (cached) return cached;
    const result = data.parent
      ? this.getRootParent(this.getDisposableData(data.parent), cache)
      : data;
    cache.set(data, result);
    return result;
  }

  /**
   * All currently-living disposables whose root ancestor is NOT a singleton.
   * Use as the post-condition assertion in test teardown.
   */
  getTrackedDisposables(): IDisposable[] {
    const cache = new Map<DisposableInfo, DisposableInfo>();
    return [...this.livingDisposables.entries()]
      .filter(
        ([, v]) => v.source !== null && !this.getRootParent(v, cache).isSingleton,
      )
      .map(([k]) => k);
  }
}

let disposableTracker: IDisposableTracker | null = null;

export function setDisposableTracker(tracker: IDisposableTracker | null): void {
  disposableTracker = tracker;
}

export function trackDisposable<T extends IDisposable>(x: T): T {
  disposableTracker?.trackDisposable(x);
  return x;
}

export function markAsDisposed(disposable: IDisposable): void {
  disposableTracker?.markAsDisposed(disposable);
}

function setParentOfDisposable(
  child: IDisposable,
  parent: IDisposable | null,
): void {
  disposableTracker?.setParent(child, parent);
}

function setParentOfDisposables(
  children: IDisposable[],
  parent: IDisposable | null,
): void {
  if (!disposableTracker) return;
  for (const child of children) {
    disposableTracker.setParent(child, parent);
  }
}

/**
 * Indicates that the given object lives for the lifetime of the process so
 * the tracker should not report it as a leak.
 */
export function markAsSingleton<T extends IDisposable>(singleton: T): T {
  disposableTracker?.markAsSingleton(singleton);
  return singleton;
}

// #endregion

export interface IDisposable {
  dispose(): void;
}

/**
 * Type guard for heterogeneous collections. Matches VSCode `isDisposable`:
 * accepts any object with a zero-arg `dispose()` method.
 */
export function isDisposable<E>(thing: E): thing is E & IDisposable {
  return (
    typeof thing === 'object' &&
    thing !== null &&
    typeof (thing as unknown as IDisposable).dispose === 'function' &&
    (thing as unknown as IDisposable).dispose.length === 0
  );
}

/**
 * Dispose one or many `IDisposable`s. Per-child errors are routed through
 * `onUnexpectedError` and do not abort the loop (kimi-code policy — VSCode
 * collects errors into an `AggregateError` and throws; we do not, to keep
 * a single misbehaving child from breaking sibling teardown).
 *
 * Overloads mirror VSCode for ergonomic call sites.
 */
export function dispose<T extends IDisposable>(disposable: T): T;
export function dispose<T extends IDisposable>(
  disposable: T | undefined,
): T | undefined;
export function dispose<T extends IDisposable, A extends Iterable<T> = Iterable<T>>(
  disposables: A,
): A;
export function dispose<T extends IDisposable>(disposables: Array<T>): Array<T>;
export function dispose<T extends IDisposable>(
  disposables: ReadonlyArray<T>,
): ReadonlyArray<T>;
export function dispose<T extends IDisposable>(
  arg: T | Iterable<T> | undefined,
): unknown {
  if (arg === undefined || arg === null) return arg;
  if (isIterable<T>(arg)) {
    for (const d of arg) {
      if (d) {
        try {
          d.dispose();
        } catch (err) {
          onUnexpectedError(err);
        }
      }
    }
    return Array.isArray(arg) ? [] : arg;
  }
  try {
    (arg as T).dispose();
  } catch (err) {
    onUnexpectedError(err);
  }
  return arg;
}

function isIterable<T>(arg: unknown): arg is Iterable<T> {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    typeof (arg as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}

/**
 * Dispose only the entries in `disposables` that pass the `isDisposable`
 * type guard. Mirrors VSCode helper of the same name; useful when holding
 * mixed collections (e.g. legacy code that may or may not implement the
 * interface).
 */
export function disposeIfDisposable<T extends IDisposable | object>(
  disposables: Array<T>,
): Array<T> {
  for (const d of disposables) {
    if (isDisposable(d)) {
      try {
        d.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }
  return [];
}

/**
 * Wrap a function as an `IDisposable`. The returned object's `dispose()`
 * invokes `fn` at most once — repeated calls are a no-op (idempotent).
 *
 * Implemented as a class so the returned object has a stable shape for
 * debuggers / V8 hidden-class optimisation, and so the tracker can record
 * a construction stack.
 */
class FunctionDisposable implements IDisposable {
  private _isDisposed = false;
  private readonly _fn: () => void;

  constructor(fn: () => void) {
    this._fn = fn;
    trackDisposable(this);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    markAsDisposed(this);
    try {
      this._fn();
    } catch (err) {
      onUnexpectedError(err);
    }
  }
}

export function toDisposable(fn: () => void): IDisposable {
  return new FunctionDisposable(fn);
}

/**
 * Aggregate multiple disposables into a single `IDisposable`. Children are
 * disposed in insertion order via the iterable `dispose(...)` helper, so
 * one throwing child does not skip its siblings.
 */
export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
  const parent = toDisposable(() => dispose(disposables));
  setParentOfDisposables(disposables, parent);
  return parent;
}

/**
 * Container that owns multiple `IDisposable`s. Iteration / disposal order is
 * **insertion order** (`Set` semantics). Mirrors VSCode
 * `base/common/lifecycle.ts DisposableStore`.
 */
export class DisposableStore implements IDisposable {
  private readonly _toDispose = new Set<IDisposable>();
  private _isDisposed = false;

  constructor() {
    trackDisposable(this);
  }

  /**
   * Take ownership of `d`. Returns `d` for ergonomic chaining
   * (`const x = store.add(new Foo())`). After the store has been disposed,
   * `add` disposes the incoming child immediately and still returns it.
   * Adding the store to itself throws.
   */
  add<T extends IDisposable>(d: T): T {
    if ((d as unknown as DisposableStore) === this) {
      throw new Error('Cannot register a disposable on itself!');
    }
    setParentOfDisposable(d, this);
    if (this._isDisposed) {
      try {
        d.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
      return d;
    }
    this._toDispose.add(d);
    return d;
  }

  /**
   * Remove `d` from the store AND dispose it. Matches VSCode
   * `DisposableStore.delete`. Use `deleteAndLeak` to detach without
   * disposing.
   */
  delete<T extends IDisposable>(d: T): void {
    if (this._isDisposed) return;
    if ((d as unknown as DisposableStore) === this) {
      throw new Error('Cannot dispose a disposable on itself!');
    }
    this._toDispose.delete(d);
    try {
      d.dispose();
    } catch (err) {
      onUnexpectedError(err);
    }
  }

  /**
   * Remove `d` from the store WITHOUT disposing. Caller takes ownership of
   * `d`'s lifetime. Matches VSCode `DisposableStore.deleteAndLeak`.
   */
  deleteAndLeak<T extends IDisposable>(d: T): void {
    if (this._isDisposed) return;
    if (this._toDispose.delete(d)) {
      setParentOfDisposable(d, null);
    }
  }

  /**
   * Dispose every currently-held child but keep the store usable.
   */
  clear(): void {
    if (this._isDisposed) return;
    if (this._toDispose.size === 0) return;
    const items = Array.from(this._toDispose);
    this._toDispose.clear();
    dispose(items);
  }

  /**
   * Dispose every currently-held child and mark the store as disposed.
   * Idempotent.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    markAsDisposed(this);
    const items = Array.from(this._toDispose);
    this._toDispose.clear();
    dispose(items);
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }
}

/**
 * Base class for services that own other disposables. Subclasses call
 * `this._register(child)` to take ownership; `dispose()` tears children down
 * in **insertion order** (matching VSCode) and is idempotent.
 *
 * Subclasses inspect "have I been disposed yet?" via `this._store.isDisposed`.
 */
export abstract class Disposable implements IDisposable {
  protected readonly _store = new DisposableStore();

  constructor() {
    trackDisposable(this);
    setParentOfDisposable(this._store, this);
  }

  protected _register<T extends IDisposable>(d: T): T {
    if ((d as unknown as Disposable) === this) {
      throw new Error('Cannot register a disposable on itself!');
    }
    return this._store.add(d);
  }

  dispose(): void {
    markAsDisposed(this);
    this._store.dispose();
  }
}

/**
 * Static zero-value disposable. `Disposable.None.dispose()` is a no-op and
 * is safe to call repeatedly. The object is frozen so callers can't mutate
 * the shared instance. Modelled after VSCode `base/common/lifecycle.ts`.
 *
 * Declared as a namespace merger rather than a static class property so we
 * don't pull `DisposableStore` allocation into module load just to read
 * `Disposable.None`.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Disposable {
  export const None: IDisposable = Object.freeze({
    dispose(): void {
      /* no-op */
    },
  });
}

/**
 * Mutable slot that owns a single `IDisposable`. Assigning a new value
 * disposes the previous one; assigning `undefined` disposes the current
 * value. After this store has itself been disposed any subsequent value
 * is disposed immediately on assignment.
 *
 * Mirrors VSCode `base/common/lifecycle.ts MutableDisposable`.
 */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  private _value: T | undefined;
  private _isDisposed = false;

  constructor() {
    trackDisposable(this);
  }

  get value(): T | undefined {
    return this._isDisposed ? undefined : this._value;
  }

  set value(value: T | undefined) {
    if (this._isDisposed) {
      if (value !== undefined) {
        try {
          value.dispose();
        } catch (err) {
          onUnexpectedError(err);
        }
      }
      return;
    }
    if (this._value === value) return;
    const prev = this._value;
    this._value = value;
    if (value) setParentOfDisposable(value, this);
    if (prev !== undefined) {
      try {
        prev.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    markAsDisposed(this);
    const prev = this._value;
    this._value = undefined;
    if (prev !== undefined) {
      try {
        prev.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  /**
   * Clear the held value (dispose if present) without disposing the store
   * itself — subsequent assignments still work.
   */
  clear(): void {
    if (this._isDisposed) return;
    const prev = this._value;
    this._value = undefined;
    if (prev !== undefined) {
      try {
        prev.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  /**
   * Clear the slot WITHOUT disposing the current value; returns the old
   * value. Caller takes ownership of its lifetime.
   */
  clearAndLeak(): T | undefined {
    if (this._isDisposed) return undefined;
    const prev = this._value;
    this._value = undefined;
    if (prev !== undefined) setParentOfDisposable(prev, null);
    return prev;
  }
}

/**
 * Map whose values are `IDisposable`. Overwriting a key disposes the previous
 * value; `deleteAndDispose(key)` removes and disposes; `dispose()` disposes
 * every value and marks the map as disposed. Mirrors VSCode
 * `base/common/lifecycle.ts DisposableMap`.
 *
 * Use this to collapse the "Map of per-entity state + manual teardown loop in
 * `override dispose()`" pattern that recurs across daemon services.
 */
export class DisposableMap<K, V extends IDisposable = IDisposable>
  implements IDisposable
{
  private readonly _store: Map<K, V>;
  private _isDisposed = false;

  constructor(store: Map<K, V> = new Map<K, V>()) {
    this._store = store;
    trackDisposable(this);
  }

  /**
   * Dispose every stored value and mark this object as disposed. Subsequent
   * mutation (`set`) is a no-op + warning.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    markAsDisposed(this);
    this.clearAndDisposeAll();
  }

  /**
   * Dispose every stored value and clear the map, but DO NOT mark the map
   * itself as disposed (subsequent `set` calls still work).
   */
  clearAndDisposeAll(): void {
    if (this._store.size === 0) return;
    try {
      dispose(this._store.values());
    } finally {
      this._store.clear();
    }
  }

  has(key: K): boolean {
    return this._store.has(key);
  }

  get size(): number {
    return this._store.size;
  }

  get(key: K): V | undefined {
    return this._store.get(key);
  }

  /**
   * Insert `value` at `key`. If `key` already has a value, that previous
   * value is disposed unless `skipDisposeOnOverwrite` is set.
   */
  set(key: K, value: V, skipDisposeOnOverwrite = false): void {
    if (this._isDisposed) {
      // eslint-disable-next-line no-console
      console.warn(
        new Error(
          'Trying to add a disposable to a DisposableMap that has already been disposed of. The added object will be leaked!',
        ).stack,
      );
      return;
    }
    if (!skipDisposeOnOverwrite) {
      const prev = this._store.get(key);
      if (prev !== undefined && prev !== value) {
        try {
          prev.dispose();
        } catch (err) {
          onUnexpectedError(err);
        }
      }
    }
    this._store.set(key, value);
    setParentOfDisposable(value, this);
  }

  /**
   * Remove the value stored for `key` AND dispose it.
   */
  deleteAndDispose(key: K): void {
    const value = this._store.get(key);
    if (value !== undefined) {
      try {
        value.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
    this._store.delete(key);
  }

  /**
   * Remove the value stored for `key` and return it. Caller takes
   * ownership of the lifetime.
   */
  deleteAndLeak(key: K): V | undefined {
    const value = this._store.get(key);
    if (value !== undefined) setParentOfDisposable(value, null);
    this._store.delete(key);
    return value;
  }

  keys(): IterableIterator<K> {
    return this._store.keys();
  }

  values(): IterableIterator<V> {
    return this._store.values();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this._store[Symbol.iterator]();
  }
}

/**
 * Set whose values are `IDisposable`. `add(v)` takes ownership;
 * `deleteAndDispose(v)` removes and disposes; `dispose()` disposes every
 * value. Mirrors VSCode `base/common/lifecycle.ts DisposableSet`.
 */
export class DisposableSet<V extends IDisposable = IDisposable>
  implements IDisposable
{
  private readonly _store: Set<V>;
  private _isDisposed = false;

  constructor(store: Set<V> = new Set<V>()) {
    this._store = store;
    trackDisposable(this);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    markAsDisposed(this);
    this.clearAndDisposeAll();
  }

  clearAndDisposeAll(): void {
    if (this._store.size === 0) return;
    try {
      dispose(this._store.values());
    } finally {
      this._store.clear();
    }
  }

  has(value: V): boolean {
    return this._store.has(value);
  }

  get size(): number {
    return this._store.size;
  }

  add(value: V): void {
    if (this._isDisposed) {
      // eslint-disable-next-line no-console
      console.warn(
        new Error(
          'Trying to add a disposable to a DisposableSet that has already been disposed of. The added object will be leaked!',
        ).stack,
      );
      return;
    }
    this._store.add(value);
    setParentOfDisposable(value, this);
  }

  deleteAndDispose(value: V): void {
    if (this._store.delete(value)) {
      try {
        value.dispose();
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  deleteAndLeak(value: V): V | undefined {
    if (this._store.delete(value)) {
      setParentOfDisposable(value, null);
      return value;
    }
    return undefined;
  }

  values(): IterableIterator<V> {
    return this._store.values();
  }

  [Symbol.iterator](): IterableIterator<V> {
    return this._store[Symbol.iterator]();
  }
}

/**
 * Scoped `using` helper: construct a `DisposableStore`, run `fn(store)`, then
 * tear the store down in a `finally`. Lets callers register transient
 * disposables for the duration of a function without writing
 * `try { ... } finally { store.dispose(); }` by hand.
 *
 *   disposeOnReturn(store => {
 *     const a = store.add(new Foo());
 *     doStuff(a);
 *   });
 */
export function disposeOnReturn(fn: (store: DisposableStore) => void): void {
  const store = new DisposableStore();
  try {
    fn(store);
  } finally {
    store.dispose();
  }
}

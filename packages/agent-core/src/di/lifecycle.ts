/**
 * Lifecycle primitives for DI-managed services: `IDisposable` interface and a
 * `Disposable` base class that owns a stack of sub-disposables and tears them
 * down in reverse register order. Modelled after VSCode's `lifecycle.ts`.
 */

export interface IDisposable {
  dispose(): void;
}

/**
 * Base class for services that own other disposables. Subclasses call
 * `this._register(child)` to take ownership; `dispose()` tears children down
 * in reverse register order (LIFO) and is idempotent.
 */
export abstract class Disposable implements IDisposable {
  private _disposed = false;
  protected _toDispose: IDisposable[] = [];

  /**
   * Take ownership of a child disposable. Returns the child for ergonomic
   * one-liner chaining (`const x = this._register(new Foo())`).
   */
  protected _register<T extends IDisposable>(d: T): T {
    if (this._disposed) {
      // Don't silently hold a reference after disposal; tear down immediately
      // so we don't leak the child if someone calls `_register` post-dispose.
      try {
        d.dispose();
      } catch {
        // Swallow: dispose() must be idempotent / forgiving.
      }
      return d;
    }
    this._toDispose.push(d);
    return d;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    // Reverse order: most-recently-registered tears down first (LIFO).
    while (this._toDispose.length > 0) {
      const child = this._toDispose.pop();
      if (!child) continue;
      try {
        child.dispose();
      } catch {
        // Continue tearing down siblings even if one throws.
      }
    }
  }

  protected get _isDisposed(): boolean {
    return this._disposed;
  }
}

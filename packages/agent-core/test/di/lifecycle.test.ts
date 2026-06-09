import { describe, expect, it } from 'vitest';

import {
  Disposable,
  DisposableStore,
  MutableDisposable,
  combinedDisposable,
  toDisposable,
  type IDisposable,
} from '#/di/lifecycle';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/errors/unexpectedError';

function makeRecorder(label: string, store: string[]): IDisposable {
  return {
    dispose() {
      store.push(label);
    },
  };
}

describe('Disposable.None', () => {
  it('dispose is a no-op and is idempotent', () => {
    expect(() => Disposable.None.dispose()).not.toThrow();
    expect(() => Disposable.None.dispose()).not.toThrow();
  });
});

describe('toDisposable', () => {
  it('invokes fn exactly once', () => {
    let calls = 0;
    const d = toDisposable(() => {
      calls += 1;
    });
    d.dispose();
    d.dispose();
    expect(calls).toBe(1);
  });
});

describe('combinedDisposable', () => {
  it('disposes all children in insertion order', () => {
    const order: string[] = [];
    const d = combinedDisposable(
      makeRecorder('a', order),
      makeRecorder('b', order),
      makeRecorder('c', order),
    );
    d.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('continues even if a child throws (route through onUnexpectedError)', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    const order: string[] = [];
    const d = combinedDisposable(
      makeRecorder('a', order),
      {
        dispose() {
          throw new Error('child-boom');
        },
      },
      makeRecorder('c', order),
    );
    d.dispose();
    expect(order).toEqual(['a', 'c']);
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('child-boom');
    resetUnexpectedErrorHandler();
  });

  it('is idempotent — second dispose is a no-op', () => {
    const order: string[] = [];
    const d = combinedDisposable(makeRecorder('a', order));
    d.dispose();
    d.dispose();
    expect(order).toEqual(['a']);
  });
});

describe('MutableDisposable', () => {
  it('value setter disposes the prior value', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeRecorder('a', order);
    expect(order).toEqual([]);
    slot.value = makeRecorder('b', order);
    expect(order).toEqual(['a']);
    slot.value = undefined;
    expect(order).toEqual(['a', 'b']);
  });

  it('same value assignment is a no-op (does not dispose itself)', () => {
    const order: string[] = [];
    const rec = makeRecorder('a', order);
    const slot = new MutableDisposable<IDisposable>();
    slot.value = rec;
    slot.value = rec;
    expect(order).toEqual([]);
  });

  it('dispose disposes the current value and is idempotent', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeRecorder('a', order);
    slot.dispose();
    slot.dispose();
    expect(order).toEqual(['a']);
  });

  it('post-dispose assignment disposes the new value immediately', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.dispose();
    slot.value = makeRecorder('a', order);
    expect(order).toEqual(['a']);
    // The slot's `value` getter returns undefined after dispose to keep
    // callers honest about ownership.
    expect(slot.value).toBeUndefined();
  });

  it('clear disposes without closing the slot', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeRecorder('a', order);
    slot.clear();
    expect(order).toEqual(['a']);
    slot.value = makeRecorder('b', order);
    slot.dispose();
    expect(order).toEqual(['a', 'b']);
  });
});

describe('DisposableStore', () => {
  it('add returns the child', () => {
    const store = new DisposableStore();
    const rec = makeRecorder('a', []);
    expect(store.add(rec)).toBe(rec);
    store.dispose();
  });

  it('dispose tears down children in insertion order', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add(makeRecorder('b', order));
    store.add(makeRecorder('c', order));
    store.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('clear disposes children but keeps the store usable', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add(makeRecorder('b', order));
    store.clear();
    expect(order).toEqual(['a', 'b']);
    store.add(makeRecorder('c', order));
    store.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('delete removes a child AND disposes it', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    const rec = makeRecorder('a', order);
    store.add(rec);
    store.delete(rec);
    expect(order).toEqual(['a']);
    // No second dispose when the store itself is later torn down.
    store.dispose();
    expect(order).toEqual(['a']);
  });

  it('deleteAndLeak removes a child WITHOUT disposing it', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    const rec = makeRecorder('a', order);
    store.add(rec);
    store.deleteAndLeak(rec);
    store.dispose();
    expect(order).toEqual([]);
  });

  it('post-dispose add disposes the incoming child immediately', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.dispose();
    store.add(makeRecorder('a', order));
    expect(order).toEqual(['a']);
    expect(store.isDisposed).toBe(true);
  });

  it('is idempotent — second dispose is a no-op', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.dispose();
    store.dispose();
    expect(order).toEqual(['a']);
  });

  it('continues even if a child throws (routes through onUnexpectedError)', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add({
      dispose() {
        throw new Error('store-child-boom');
      },
    });
    store.add(makeRecorder('c', order));
    store.dispose();
    // Insertion order: a, throwing-child, c
    expect(order).toEqual(['a', 'c']);
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('store-child-boom');
    resetUnexpectedErrorHandler();
  });
});

describe('Disposable base class', () => {
  it('insertion-order teardown', () => {
    const order: string[] = [];
    class Owner extends Disposable {
      add(label: string): void {
        this._register(makeRecorder(label, order));
      }
    }
    const owner = new Owner();
    owner.add('a');
    owner.add('b');
    owner.add('c');
    owner.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('registering self throws', () => {
    class Owner extends Disposable {
      registerSelf(): void {
        this._register(this);
      }
    }
    const owner = new Owner();
    expect(() => owner.registerSelf()).toThrow(
      /Cannot register a disposable on itself/,
    );
    owner.dispose();
  });
});

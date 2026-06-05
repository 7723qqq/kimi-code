import { describe, expect, it } from 'vitest';

import { InstantiationType, SyncDescriptor, SyncDescriptor0 } from '#/di/descriptors';

class MyClass {
  constructor(
    public readonly a: string,
    public readonly b: number,
  ) {}
}

describe('SyncDescriptor', () => {
  it('exposes ctor verbatim', () => {
    const d = new SyncDescriptor(MyClass);
    expect(d.ctor).toBe(MyClass);
  });

  it('defaults staticArguments to empty array', () => {
    const d = new SyncDescriptor(MyClass);
    expect(d.staticArguments).toEqual([]);
  });

  it('defaults supportsDelayedInstantiation to false', () => {
    const d = new SyncDescriptor(MyClass);
    expect(d.supportsDelayedInstantiation).toBe(false);
  });

  it('accepts staticArguments tuple', () => {
    const d = new SyncDescriptor(MyClass, ['hello', 42]);
    expect(d.staticArguments).toEqual(['hello', 42]);
  });

  it('accepts supportsDelayedInstantiation=true', () => {
    const d = new SyncDescriptor(MyClass, [], true);
    expect(d.supportsDelayedInstantiation).toBe(true);
  });
});

describe('SyncDescriptor0 (P0.4)', () => {
  it('is a SyncDescriptor with empty staticArguments', () => {
    class Zero {
      constructor() {}
    }
    const d = new SyncDescriptor0(Zero);
    expect(d).toBeInstanceOf(SyncDescriptor);
    expect(d.ctor).toBe(Zero);
    expect(d.staticArguments).toEqual([]);
  });
});

describe('InstantiationType', () => {
  it('Eager === 0, Delayed === 1', () => {
    expect(InstantiationType.Eager).toBe(0);
    expect(InstantiationType.Delayed).toBe(1);
  });
});

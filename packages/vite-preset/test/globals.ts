import { afterEach, beforeEach } from 'bun:test';

export function createPropertyStubs(target: object = globalThis) {
  const targetWindow = (globalThis as { window?: unknown }).window;
  const mirror =
    target === globalThis &&
    targetWindow !== undefined &&
    targetWindow !== globalThis &&
    typeof targetWindow === 'object'
      ? (targetWindow as object)
      : undefined;
  const originals = new Map<
    string,
    { target: object; descriptor: PropertyDescriptor | undefined }[]
  >();
  function restore(): void {
    for (const [name, entries] of originals) {
      for (const { target: owner, descriptor } of entries) {
        if (descriptor) Object.defineProperty(owner, name, descriptor);
        else Reflect.deleteProperty(owner, name);
      }
    }
    originals.clear();
  }
  function define(name: string, descriptor: PropertyDescriptor): void {
    const owners = [target];
    if (mirror !== undefined) {
      const existing = Object.getOwnPropertyDescriptor(mirror, name);
      if (existing === undefined || existing.configurable !== false) owners.push(mirror);
    }
    if (!originals.has(name)) {
      originals.set(
        name,
        owners.map((owner) => ({
          target: owner,
          descriptor: Object.getOwnPropertyDescriptor(owner, name),
        })),
      );
    }
    for (const owner of owners) {
      Object.defineProperty(owner, name, { ...descriptor, configurable: true });
    }
  }
  function stub(name: string, value: unknown): void {
    define(name, { writable: true, value });
  }
  function getter<T>(name: string, get: (this: T) => unknown): void {
    define(name, { get });
  }
  return Object.assign(stub, { getter, restore });
}

export function stubGlobals(target: object = globalThis) {
  const stubs = createPropertyStubs(target);
  afterEach(stubs.restore);
  return stubs;
}

export function stubLocalStorage(): Map<string, string> {
  const stubs = stubGlobals();
  const entries = new Map<string, string>();
  beforeEach(() => {
    entries.clear();
    stubs('localStorage', {
      get length() {
        return entries.size;
      },
      key: (index) => [...entries.keys()][index] ?? null,
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, String(value));
      },
      removeItem: (key) => {
        entries.delete(key);
      },
      clear: () => entries.clear(),
    } satisfies Storage);
  });
  return entries;
}

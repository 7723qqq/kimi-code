/**
 * Global replacement for `bun:test`.
 *
 * The original is captured as a property descriptor and restored with
 * `Object.defineProperty`, so the property comes back exactly as it was —
 * including accessor properties, and names that did not exist before, which
 * are removed again rather than left behind as `undefined`.
 */
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

const globalHolder = globalThis as unknown as Record<string, unknown>;

export function setGlobal(name: string, value: unknown): void {
  if (!savedDescriptors.has(name)) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalHolder, name));
  }
  Object.defineProperty(globalHolder, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function restoreGlobals(): void {
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor === undefined) delete globalHolder[name];
    else Object.defineProperty(globalHolder, name, descriptor);
  }
  savedDescriptors.clear();
}

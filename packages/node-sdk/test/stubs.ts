/**
 * Test doubles for the Node SDK suite, built on Bun primitives.
 *
 * A replaced global is restored from its property descriptor, so the
 * original value comes back exactly as it was — including accessor
 * properties and names that did not exist before. Environment variables go
 * through `env`, the native environment view: it stays in sync with
 * `process.env` in both directions, and deleting a key from it removes the
 * variable instead of leaving the string "undefined" behind.
 */

const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
const savedEnvs = new Map<string, string | undefined>();

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

export function setEnv(name: string, value: string | undefined): void {
  if (!savedEnvs.has(name)) savedEnvs.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function restoreEnvs(): void {
  for (const [name, original] of savedEnvs) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  savedEnvs.clear();
}

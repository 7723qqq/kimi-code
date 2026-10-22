/**
 * Test-only global and env stubbing for Bun.
 *
 * Built on Bun's own primitives rather than a hand-kept registry: a replaced
 * global is restored from its property descriptor, so the original comes back
 * exactly as it was — including accessor properties and names that did not
 * exist before. Environment variables go through `env`, the native
 * environment view, which stays in sync with `process.env` in both
 * directions and deletes a variable instead of leaving "undefined" behind.
 *
 * `bun test` shares one process across files, so every file that stubs MUST
 * call the matching `unstub*` helper in `afterEach` — a leaked `fetch` stub
 * would silence the real network for every file that runs afterwards.
 */

const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();
const stubbedEnv = new Map<string, string | undefined>();

const globalHolder = globalThis as unknown as Record<string, unknown>;

export function setGlobal(name: string, value: unknown): void {
  if (!stubbedGlobals.has(name)) {
    stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalHolder, name));
  }
  Object.defineProperty(globalHolder, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function restoreGlobals(): void {
  for (const [name, descriptor] of stubbedGlobals) {
    if (descriptor === undefined) delete globalHolder[name];
    else Object.defineProperty(globalHolder, name, descriptor);
  }
  stubbedGlobals.clear();
}

export function setEnv(name: string, value: string | undefined): void {
  if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function restoreEnvs(): void {
  for (const [name, original] of stubbedEnv) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  stubbedEnv.clear();
}

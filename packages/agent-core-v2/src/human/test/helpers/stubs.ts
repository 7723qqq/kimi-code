/**
 * Global / env stubs shared by the `human` kernel tests.
 *
 * The kernel tests must stay free of vitest-specific helpers, so the stub
 * bookkeeping lives here instead of in a test framework's `vi.stub*` API.
 */

interface Undo {
  (): void;
}

const globalUndo: Undo[] = [];
const envUndo: Undo[] = [];

export function setGlobal(name: string, value: unknown): void {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const previous = (globalThis as Record<string, unknown>)[name];
  (globalThis as Record<string, unknown>)[name] = value;
  globalUndo.push(() => {
    if (had) (globalThis as Record<string, unknown>)[name] = previous;
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

export function restoreGlobals(): void {
  for (const undo of globalUndo.splice(0).reverse()) undo();
}

export function setEnv(name: string, value: string | undefined): void {
  const had = name in process.env;
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  envUndo.push(() => {
    if (had && previous !== undefined) process.env[name] = previous;
    else delete process.env[name];
  });
}

export function restoreEnvs(): void {
  for (const undo of envUndo.splice(0).reverse()) undo();
}

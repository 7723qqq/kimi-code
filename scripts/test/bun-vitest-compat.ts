import { jest, vi } from 'bun:test';

type UnknownRecord = Record<string, unknown>;

const bunVi = vi as unknown as UnknownRecord;
const savedGlobals = new Map<string, { had: boolean; value: unknown }>();
const savedEnvs = new Map<string, string | undefined>();

function stubGlobal(name: string, value: unknown): void {
  if (!savedGlobals.has(name)) {
    savedGlobals.set(name, { had: name in globalThis, value: (globalThis as UnknownRecord)[name] });
  }
  (globalThis as UnknownRecord)[name] = value;
}

function unstubAllGlobals(): void {
  for (const [name, saved] of savedGlobals) {
    if (saved.had) (globalThis as UnknownRecord)[name] = saved.value;
    else delete (globalThis as UnknownRecord)[name];
  }
  savedGlobals.clear();
}

function stubEnv(name: string, value: string | undefined): void {
  if (!savedEnvs.has(name)) savedEnvs.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function unstubAllEnvs(): void {
  for (const [name, value] of savedEnvs) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvs.clear();
}

interface WaitOptions {
  readonly timeout?: number;
  readonly interval?: number;
}

async function waitFor(
  callback: () => unknown,
  options?: WaitOptions,
): Promise<void> {
  const timeout = options?.timeout ?? 1000;
  const interval = options?.interval ?? 50;
  const started = Date.now();
  for (;;) {
    try {
      await callback();
      return;
    } catch (error) {
      if (Date.now() - started >= timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

async function waitUntil(
  callback: () => unknown,
  options?: WaitOptions,
): Promise<void> {
  await waitFor(() => {
    if (!callback()) throw new Error('waitUntil condition was not met');
  }, options);
}

Object.assign(bunVi, {
  stubGlobal,
  unstubAllGlobals,
  stubEnv,
  unstubAllEnvs,
  setSystemTime: (time?: number | Date) =>
    time === undefined ? jest.setSystemTime() : jest.setSystemTime(time),
  mocked: <T>(value: T): T => value,
  hoisted: <T>(factory: () => T): T => factory(),
  importActual: <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>,
  doMock: bunVi['mock'],
  waitFor,
  waitUntil,
});

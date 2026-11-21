
import { jest, mock, spyOn } from 'bun:test';
import { expect, vi } from '@moonshot-ai/testkit/vitest';

const viShim = vi as unknown as Record<string, unknown>;
const runtimeVi = vi as typeof vi & {
  hoisted?: <T>(factory: () => T) => T;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
  waitFor?: <T>(check: () => T | Promise<T>, options?: { timeout?: number; interval?: number }) => Promise<T>;
};

if (typeof runtimeVi.hoisted !== 'function') {
  viShim['hoisted'] = (factory: () => unknown) => factory();
}

if (typeof runtimeVi.waitFor !== 'function') {
  viShim['waitFor'] = async <T>(
    check: () => T | Promise<T>,
    options: { timeout?: number; interval?: number } = {},
  ): Promise<T> => {
    const timeout = options.timeout ?? 1_000;
    const interval = options.interval ?? 10;
    const started = Date.now();
    for (;;) {
      try {
        return await check();
      } catch (error) {
        if (Date.now() - started >= timeout) throw error;
        if ((jest as unknown as { isFakeTimers?: () => boolean }).isFakeTimers?.() === true) {
          jest.advanceTimersByTime(interval);
          for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        } else {
          await Bun.sleep(interval);
        }
      }
    }
  };
}

const savedEnv = new Map<string, string | undefined>();

viShim['fn'] = (implementation?: (...args: never[]) => unknown) =>
  implementation === undefined ? mock() : mock(implementation);
viShim['spyOn'] = (target: object, key: string) => spyOn(target as never, key as never);
viShim['mocked'] = (value: unknown) => value;
viShim['stubEnv'] = (key: string, value: string) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};
viShim['unstubAllEnvs'] = () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
};
viShim['useFakeTimers'] = (...args: unknown[]) => (jest.useFakeTimers as (...values: unknown[]) => unknown)(...args);
viShim['useRealTimers'] = () => jest.useRealTimers();
viShim['advanceTimersByTime'] = (ms: number) => jest.advanceTimersByTime(ms);
viShim['advanceTimersByTimeAsync'] = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};
viShim['runAllTimers'] = () => jest.runAllTimers();
viShim['runAllTimersAsync'] = async () => {
  jest.runAllTimers();
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};
viShim['clearAllTimers'] = () => jest.clearAllTimers();
viShim['getTimerCount'] = () => jest.getTimerCount();
viShim['setSystemTime'] = (time: number | Date) => jest.setSystemTime(time);
viShim['getRealSystemTime'] = () => Date.now();
viShim['restoreAllMocks'] = () => jest.restoreAllMocks();
viShim['clearAllMocks'] = () => jest.clearAllMocks();
viShim['resetAllMocks'] = () => jest.resetAllMocks();

const savedGlobals = new Map<string, { readonly had: boolean; readonly value: unknown }>();
viShim['stubGlobal'] = (key: string, value: unknown) => {
  if (!savedGlobals.has(key)) {
    savedGlobals.set(key, { had: key in globalThis, value: (globalThis as Record<string, unknown>)[key] });
  }
  (globalThis as Record<string, unknown>)[key] = value;
};
viShim['unstubAllGlobals'] = () => {
  for (const [key, saved] of savedGlobals) {
    if (saved.had) (globalThis as Record<string, unknown>)[key] = saved.value;
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals.clear();
};
viShim['mock'] = (specifier: string, factory: () => unknown) => mock.module(specifier, factory);
viShim['doMock'] = viShim['mock'];

expect.extend({
  toHaveBeenCalledExactlyOnceWith(
    received: { mock?: { calls?: unknown[][] } },
    ...expected: unknown[]
  ) {
    const calls = received?.mock?.calls;
    const pass = Array.isArray(calls) && calls.length === 1 && Bun.deepEquals(calls[0], expected);
    return {
      pass,
      message: () => JSON.stringify({ calls: received?.mock?.calls, expected }, null, 2),
    };
  },
});

process.env['KIMI_LOG_LEVEL'] = 'off';
process.env['KIMI_LANG'] = 'en';

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { vi } from '@moonshot-ai/testkit/vitest';

type Hoisted = <T>(factory: () => T) => T;

const runtimeVi = vi as typeof vi & {
  hoisted?: Hoisted;
  waitFor?: <T>(check: () => T | Promise<T>, options?: { timeout?: number; interval?: number }) => Promise<T>;
  setSystemTime?: (time: number | Date) => void;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
  importActual?: <T = unknown>(path: string) => Promise<T>;
};

if (typeof runtimeVi.advanceTimersByTimeAsync !== 'function') {
  runtimeVi.advanceTimersByTimeAsync = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  };
}

if (typeof runtimeVi.hoisted !== 'function') {
  runtimeVi.hoisted = ((factory: () => unknown) => factory()) as Hoisted;
}

if (typeof runtimeVi.waitFor !== 'function') {
  runtimeVi.waitFor = async <T>(
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
        await Bun.sleep(interval);
      }
    }
  };
}

if (typeof runtimeVi.setSystemTime !== 'function') {
  runtimeVi.setSystemTime = (time: number | Date) => {
    vi.useFakeTimers({ now: time });
  };
}

if (typeof runtimeVi.importActual !== 'function') {
  const setupFile = fileURLToPath(import.meta.url);

  const callerFile = (): string | undefined => {
    const stack = new Error().stack ?? '';
    for (const line of stack.split('\n').slice(1)) {
      const match = /\((.*):\d+:\d+\)$/.exec(line) ?? /^\s*at (.*):\d+:\d+$/.exec(line);
      const candidate = match?.[1]?.replace(/^file:\/\//, '');
      if (!candidate || !isAbsolute(candidate)) continue;
      if (candidate === setupFile || candidate.includes('node_modules')) continue;
      return candidate;
    }
    return undefined;
  };

  const importFromCaller = async <T>(specifier: string): Promise<T> => {
    if (!specifier.startsWith('.')) return import(specifier) as Promise<T>;
    const base = callerFile();
    const target = base ? resolve(dirname(base), specifier) : specifier;
    const candidates = target.endsWith('.js') ? [target, target.slice(0, -3)] : [target];
    for (const candidate of candidates) {
      try {
        return (await import(pathToFileURL(candidate).href)) as T;
      } catch (error) {
        if (candidate === candidates.at(-1)) throw error;
      }
    }
    throw new Error(`Cannot resolve ${specifier}`);
  };

  runtimeVi.importActual = <T = unknown>(path: string): Promise<T> => importFromCaller<T>(path);
}

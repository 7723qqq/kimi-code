import { expect, vi } from '@moonshot-ai/testkit/vitest';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_')) {
    delete process.env[key];
  }
}

process.env['KIMI_CODE_SEARCH_WORKER'] = 'false';

process.env['KIMI_CODE_PERSISTENCE_MINIDB_READMODEL'] = 'false';

type RuntimeVi = typeof vi & {
  waitFor?: <T>(check: () => T | Promise<T>, options?: { timeout?: number; interval?: number }) => Promise<T>;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
  stubEnv?: (name: string, value: string | undefined) => void;
  unstubAllEnvs?: () => void;
  stubGlobal?: (name: string, value: unknown) => void;
  mocked?: <T>(value: T) => T;
  unstubAllGlobals?: () => void;
};

type RuntimeExpect = typeof expect & {
  poll?: <T>(
    check: () => T | Promise<T>,
    options?: { timeout?: number; interval?: number },
  ) => Record<string, (...args: unknown[]) => Promise<void>>;
};

const runtimeVi = vi as RuntimeVi;
const viShim = vi as unknown as Record<string, unknown>;
const expectShim = expect as unknown as Record<string, unknown>;

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
        await Bun.sleep(interval);
      }
    }
  };
}

if (typeof runtimeVi.advanceTimersByTimeAsync !== 'function') {
  viShim['advanceTimersByTimeAsync'] = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  };
}

const envOriginals = new Map<string, string | undefined>();

if (typeof runtimeVi.stubEnv !== 'function') {
  viShim['stubEnv'] = (name: string, value: string | undefined) => {
    if (!envOriginals.has(name)) envOriginals.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
}

if (typeof runtimeVi.unstubAllEnvs !== 'function') {
  viShim['unstubAllEnvs'] = () => {
    for (const [name, value] of envOriginals) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    envOriginals.clear();
  };
}

const globalOriginals = new Map<string, PropertyDescriptor | undefined>();

if (typeof runtimeVi.stubGlobal !== 'function') {
  viShim['stubGlobal'] = (name: string, value: unknown) => {
    if (!globalOriginals.has(name)) {
      globalOriginals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  };
}

if (typeof runtimeVi.unstubAllGlobals !== 'function') {
  viShim['unstubAllGlobals'] = () => {
    for (const [name, descriptor] of globalOriginals) {
      if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
    globalOriginals.clear();
  };
}

if (typeof (expect as RuntimeExpect).poll !== 'function') {
  expectShim['poll'] = <T>(
    check: () => T | Promise<T>,
    options: { timeout?: number; interval?: number } = {},
  ) => {
    const timeout = options.timeout ?? 1_000;
    const interval = options.interval ?? 50;
    return new Proxy(
      {},
      {
        get(_target, matcher: string) {
          return async (...args: unknown[]) => {
            const started = Date.now();
            for (;;) {
              try {
                const value = await check();
                const assertion = expect(value) as unknown as Record<string, (...a: unknown[]) => void>;
                const assert = assertion[matcher];
                if (typeof assert !== 'function') throw new Error(`expect.poll: unsupported matcher ${matcher}`);
                assert.apply(assertion, args);
                return;
              } catch (error) {
                if (Date.now() - started >= timeout) throw error;
                await Bun.sleep(interval);
              }
            }
          };
        },
      },
    );
  };
}

if (typeof runtimeVi.mocked !== 'function') {
  viShim['mocked'] = <T>(value: T): T => value;
}

const originalSpyOn = vi.spyOn.bind(vi);

viShim['spyOn'] = (object: object, key: PropertyKey, accessType?: 'get' | 'set') => {
  if (accessType !== 'get' && accessType !== 'set') {
    return originalSpyOn(object as never, key as never, accessType as never);
  }
  const own = Object.getOwnPropertyDescriptor(object, key);
  const inherited =
    own ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object) as object, key);
  if (inherited === undefined) throw new Error(`spyOn: property ${String(key)} not found`);
  const original = accessType === 'get' ? inherited.get : inherited.set;
  if (original === undefined) throw new Error(`spyOn: ${String(key)} has no ${accessType}ter`);
  const mock = vi.fn(original) as unknown as {
    apply(thisArg: unknown, args: unknown[]): unknown;
    mockRestore(): void;
  };
  const restore = () => {
    if (own !== undefined) Object.defineProperty(object, key, own);
    else delete (object as Record<PropertyKey, unknown>)[key];
  };
  Object.defineProperty(mock, 'mockRestore', { value: restore, configurable: true });
  Object.defineProperty(object, key, {
    ...inherited,
    [accessType]: (...args: unknown[]) => mock.apply(object, args),
  });
  return mock;
};

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

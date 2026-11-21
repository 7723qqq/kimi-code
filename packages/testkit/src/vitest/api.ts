import { ok as assertOk } from 'node:assert';
import * as bt from 'bun:test';
import { createRequire } from 'node:module';

/**
 * vitest-compatible facade over `bun:test`.
 *
 * The fork's tests were written against vitest, which has a wider surface than
 * Bun's jest-compatible one. Rather than rewriting ~1200 files, this module maps
 * the missing vitest API onto Bun primitives. Everything is implemented here
 * once, so a test file only ever imports from `@moonshot-ai/testkit/vitest`.
 *
 * Ground rules (each learned the hard way):
 *
 *  - `it` / `describe` / hooks are Bun's own objects. Bun's `.each` requires
 *    `this` to be its internal ScopeFunctions, so they are never proxied; only
 *    `runIf` / `skipIf` are attached in place and the type is widened.
 *  - Matchers are read from a real `expect(...)` bag with the bag as receiver,
 *    because Bun's matchers use `this` internally.
 *  - `mock.module` factories receive no argument (vitest's `importOriginal` does
 *    not exist); `requireActual` is the synchronous escape hatch.
 *  - Async matchers (`resolves` / `rejects`) are Bun's, except for the two cases
 *    Bun does not unwrap for us: `toEqual`-style pruning and `toSatisfy`.
 */

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

const requireSync = createRequire(import.meta.url);

/** Synchronously read the *real* module, bypassing a registered mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requireActual<T = any>(specifier: string): T {
  return requireSync(specifier) as T;
}

export function importActual<T>(specifier: string): Promise<T> {
  try {
    return Promise.resolve(requireSync(specifier) as T);
  } catch {
    return import(specifier) as Promise<T>;
  }
}

// ---------------------------------------------------------------------------
// Test registration
// ---------------------------------------------------------------------------

export {
  expectTypeOf,
  jest,
  mock,
  onTestFinished,
  setDefaultTimeout,
  setSystemTime,
} from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithScope<T> = T & ((...args: any[]) => unknown) & {
  runIf(condition: unknown): WithScope<T>;
  skipIf(condition: unknown): WithScope<T>;
};

/**
 * vitest allows a trailing `timeout` argument and spells dynamic skipping as
 * `describe.runIf` / `it.skipIf`. Bun honours the argument at runtime (it is
 * simply ignored) but does not declare it, and has no `runIf`; widen the type
 * and attach the two helpers to the original object.
 */
function withScope<T extends AnyFn>(target: T): WithScope<T> {
  const asRecord = target as unknown as Record<string, unknown>;
  const define = (name: 'runIf' | 'skipIf', pick: (condition: unknown) => AnyFn): void => {
    if (typeof asRecord[name] === 'function') return;
    Object.defineProperty(target, name, { configurable: true, writable: true, value: pick });
  };
  define('runIf', (condition) => (condition ? target : skipOf(target)));
  define('skipIf', (condition) => (condition ? skipOf(target) : target));
  return target as unknown as WithScope<T>;
}

function skipOf(target: AnyFn): AnyFn {
  const skip = (target as unknown as Record<string, unknown>)['skip'];
  return typeof skip === 'function' ? (skip as AnyFn) : target;
}

export const afterAll = withScope(bt.afterAll);
export const afterEach = withScope(bt.afterEach);
export const beforeAll = withScope(bt.beforeAll);
export const beforeEach = withScope(bt.beforeEach);
export const describe = withScope(bt.describe);
export const it = withScope(bt.it);
export const test = withScope(bt.test);

// ---------------------------------------------------------------------------
// Mocks and spies
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mock<T extends (...args: any[]) => any = (...args: any[]) => any> = bt.Mock<T> & T;
export type { Matchers, AsymmetricMatchers } from 'bun:test';

/** Bun's mock plus the looser implementation signature vitest accepts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompatMock<F extends (...args: any[]) => any> = bt.Mock<F> & F & {
  mockImplementation(fn: (...args: Parameters<F>) => ReturnType<F>): CompatMock<F>;
  mockImplementationOnce(fn: (...args: Parameters<F>) => ReturnType<F>): CompatMock<F>;
  // Bun types rejection reasons narrowly (sometimes `never`); a rejection can
  // carry any value, so widen these the way vitest callers expect.
  mockRejectedValue(reason: unknown): CompatMock<F>;
  mockRejectedValueOnce(reason: unknown): CompatMock<F>;
};

function findDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

/** `vi.spyOn(obj, key, 'get' | 'set')` — bun's spyOn has no accessor support. */
function spyOnAccessor(object: object, key: PropertyKey, accessType: 'get' | 'set'): unknown {
  const descriptor = findDescriptor(object, key);
  const original =
    accessType === 'get' ? descriptor?.get?.bind(descriptor) : descriptor?.set?.bind(descriptor);
  const mockFn = bt.mock((...args: unknown[]) =>
    original === undefined
      ? undefined
      : (original as (...a: unknown[]) => unknown).apply(object, args),
  ) as unknown as Record<string, unknown>;
  const replacement: PropertyDescriptor = {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    [accessType](this: unknown, ...args: unknown[]) {
      return (mockFn as unknown as (...a: unknown[]) => unknown).apply(this, args);
    },
  };
  Object.defineProperty(object, key, replacement);
  mockFn['mockRestore'] = (): void => {
    if (descriptor === undefined) delete (object as Record<string, unknown>)[key as string];
    else Object.defineProperty(object, key, descriptor);
  };
  return mockFn;
}

export const spyOn = ((
  object: object,
  key: PropertyKey,
  accessType?: 'get' | 'set',
): unknown => {
  if (accessType !== undefined) return spyOnAccessor(object, key, accessType);
  return bt.spyOn(object as never, key as never);
}) as unknown as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <T extends object, K extends keyof T>(object: T, key: K): CompatMock<Extract<T[K], (...args: any[]) => any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (object: any, key: any, accessType?: 'get' | 'set'): any;
};

export function assert(value: unknown, message?: string): asserts value {
  assertOk(value, message);
}

// ---------------------------------------------------------------------------
// Process / global stubs
// ---------------------------------------------------------------------------

type GlobalKey = string | symbol;

interface Restorer {
  restore(): void;
}

const restorers: Restorer[] = [];

function stubGlobal(name: GlobalKey, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  restorers.push({
    restore() {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    },
  });
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}

function stubEnv(name: string, value: string | undefined): void {
  const existed = name in process.env;
  const previous = process.env[name];
  restorers.push({
    restore() {
      if (!existed || previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    },
  });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function unstubAll(): void {
  for (const restorer of restorers.splice(0)) restorer.restore();
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/** Let every microtask queued by the timers that just ran execute. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function runAllTimersAsync(): Promise<void> {
  bt.vi.runAllTimers();
  await flushMicrotasks();
}

async function runOnlyPendingTimersAsync(): Promise<void> {
  bt.vi.runOnlyPendingTimers();
  await flushMicrotasks();
}

/**
 * Step one millisecond at a time so a timer scheduled from a microtask still
 * lands in the right order; jump the remaining window when nothing is queued.
 */
async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  if (ms <= 0) {
    bt.vi.advanceTimersByTime(0);
    await flushMicrotasks();
    return;
  }
  for (let elapsed = 0; elapsed < ms; elapsed++) {
    if (bt.vi.getTimerCount() === 0) {
      bt.vi.advanceTimersByTime(ms - elapsed);
      await flushMicrotasks();
      return;
    }
    bt.vi.advanceTimersByTime(1);
    await flushMicrotasks();
  }
}

async function waitFor<T>(
  callback: () => T | Promise<T>,
  options: { readonly timeout?: number; readonly interval?: number } = {},
): Promise<T> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 50;
  const started = Date.now();
  for (;;) {
    try {
      return await callback();
    } catch (error) {
      if (Date.now() - started >= timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

// ---------------------------------------------------------------------------
// Failure tracking (feeds onTestFailed)
// ---------------------------------------------------------------------------

let currentTestFailed = false;
let failureCallbacks: Array<(error: unknown) => void> = [];

bt.beforeEach(() => {
  currentTestFailed = false;
  failureCallbacks = [];
});

function markFailed(): void {
  currentTestFailed = true;
}

export function onTestFailed(callback: (error: unknown) => void): void {
  failureCallbacks.push(callback);
}

bt.afterEach(() => {
  if (!currentTestFailed) return;
  for (const callback of failureCallbacks.splice(0)) callback(new Error('test failed'));
});

export interface TestContext {
  readonly task?: { readonly name: string };
  onTestFinished(callback: () => unknown): void;
  onTestFailed(callback: (error: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

const bunExpect = bt.expect;

/** Deep copy dropping `undefined`-valued keys, the way jest's `toEqual` does. */
function pruneUndefined<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) return value;
  const cached = seen.get(value as object);
  if (cached !== undefined) return cached as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(pruneUndefined(item, seen));
    return copy as unknown as T;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    copy[key] = pruneUndefined(item, seen);
  }
  return copy as unknown as T;
}

/** Matchers where vitest ignores `undefined` properties but Bun does not. */
const PRUNED_MATCHERS = new Set([
  'toEqual',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
]);

type MatcherBag = Record<string | symbol, unknown>;
type Mode = 'value' | 'resolves' | 'rejects';

interface MatcherView {
  readonly subject: unknown;
  readonly mode: Mode;
  readonly negated: boolean;
  readonly label?: string;
}

function bagFor(view: MatcherView, subject: unknown = view.subject): MatcherBag {
  let bag = bunExpect(subject as never) as unknown as MatcherBag;
  if (view.mode !== 'value') bag = bag[view.mode] as MatcherBag;
  if (view.negated) bag = bag['not'] as MatcherBag;
  return bag;
}

function annotate(fn: (...args: unknown[]) => unknown, label?: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    try {
      return fn(...args);
    } catch (error) {
      markFailed();
      if (label !== undefined && error instanceof Error) error.message = `${error.message}\n${label}`;
      throw error;
    }
  };
}

/**
 * `expect(promise).resolves|rejects.toThrow(...)`.
 *
 * Verified against vitest 4's contract:
 *  - the `resolves` / `rejects` prefix must hold (the promise settles that way);
 *  - `toThrow` then applies to the SETTLED VALUE. For `resolves` a function
 *    value is called and must throw (matching `expected` when given); a
 *    non-function value counts as "does not throw". For `rejects` the
 *    rejection reason is the "thrown" value and is matched against `expected`.
 * bun's `toThrow` instead requires a callable and fails on any other type, so
 * intercept the matcher here and keep vitest's contract.
 */
function settlementThrowMatcher(view: MatcherView): (expected?: unknown) => Promise<void> {
  return async (expected?: unknown): Promise<void> => {
    let rejected = false;
    let settled: unknown;
    try {
      settled = await view.subject;
    } catch (error) {
      rejected = true;
      settled = error;
    }
    const wantsRejection = view.mode === 'rejects';
    let detail: string;
    let base: boolean;
    if (rejected !== wantsRejection) {
      detail = wantsRejection ? 'reject' : 'resolve';
      base = false;
    } else if (wantsRejection) {
      const matched = expected === undefined || thrownMatches(settled, expected);
      detail = `reject with ${describeExpected(expected)}`;
      base = matched;
    } else {
      let threw = false;
      let thrown: unknown;
      if (typeof settled === 'function') {
        try {
          (settled as () => unknown)();
        } catch (error) {
          threw = true;
          thrown = error;
        }
      }
      const matched = !threw || expected === undefined || thrownMatches(thrown, expected);
      detail = threw ? `throw ${describeExpected(expected)}` : 'not throw';
      base = threw && matched;
    }
    const pass = view.negated ? !base : base;
    if (pass) return;
    markFailed();
    throw new Error(
      `expected the promise to ${wantsRejection ? 'reject' : 'resolve'} and ${view.negated ? `not ${detail}` : detail}`,
    );
  };
}

function describeExpected(expected: unknown): string {
  if (expected === undefined) return 'anything';
  if (typeof expected === 'string') return expected;
  if (expected instanceof RegExp) return expected.source;
  if (typeof expected === 'function') return 'a matching error';
  return 'the value';
}

function thrownMatches(value: unknown, expected: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  if (typeof expected === 'string') return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === 'function') return value instanceof (expected as new (...a: never[]) => unknown);
  return false;
}

/** `expect(promise).rejects.toSatisfy(fn)`: Bun does not unwrap for this matcher. */
function satisfiedMatcher(view: MatcherView): (predicate: (value: unknown) => boolean) => Promise<void> {
  return async (predicate) => {
    let outcome: { readonly rejected: boolean; readonly value: unknown };
    try {
      outcome = { rejected: false, value: await view.subject };
    } catch (error) {
      outcome = { rejected: true, value: error };
    }
    const expectedToReject = view.mode === 'rejects';
    const pass = outcome.rejected === expectedToReject && predicate(outcome.value);
    if (pass !== view.negated) return;
    markFailed();
    const expectation = expectedToReject ? 'rejection' : 'resolved value';
    throw new Error(`expected the ${expectation} to satisfy the predicate`);
  };
}

function prunedMatcher(view: MatcherView, name: string): (...args: unknown[]) => unknown {
  return (...expected: unknown[]) => {
    const bag = bagFor(view, pruneUndefined(view.subject));
    try {
      return (bag[name] as (...args: unknown[]) => unknown).call(
        bag,
        ...expected.map((item) => pruneUndefined(item)),
      );
    } catch (error) {
      markFailed();
      throw error;
    }
  };
}

function matcherView(view: MatcherView): unknown {
  const bag = bagFor(view);
  return new Proxy(bag, {
    get(target, prop) {
      if (prop === 'not') return matcherView({ ...view, negated: !view.negated });
      if (prop === 'resolves' || prop === 'rejects') {
        return matcherView({ ...view, mode: prop, negated: false });
      }
      if (prop === 'toSatisfy' && view.mode !== 'value') return satisfiedMatcher(view);
      if (prop === 'toThrow' && view.mode !== 'value') return settlementThrowMatcher(view);
      if (typeof prop === 'string' && PRUNED_MATCHERS.has(prop)) return prunedMatcher(view, prop);
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      // `Function.prototype.bind.call` tolerates exotic callables that lack a
      // `bind` property of their own.
      return annotate(
        Function.prototype.bind.call(value, target) as (...args: unknown[]) => unknown,
        view.label,
      );
    },
  });
}

interface AsymmetricMatchers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any: (constructor?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anything: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arrayContaining: <T = unknown>(items: T[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  objectContaining: <T = Record<string, unknown>>(value: Partial<T>) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stringContaining: <T = string>(value: T) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stringMatching: <T = string | RegExp>(value: T) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  closeTo: (value: number, precision?: number) => any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseExpect = ((actual: any, message?: string) => any) &
  AsymmetricMatchers & {
    not: AsymmetricMatchers;
    extend: (matchers: Record<string, unknown>) => void;
    assertions: (count: number) => void;
    hasAssertions: () => void;
    unreachable: (message?: string) => never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    poll: (callback: () => unknown, options?: { timeout?: number; interval?: number }) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };

function pollMatcher(callback: () => unknown, options?: { timeout?: number; interval?: number }): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        return async (...args: unknown[]): Promise<void> => {
          await waitFor(async () => {
            const subject = matcherView({
              subject: await callback(),
              mode: 'value',
              negated: false,
            }) as Record<string, ((...a: unknown[]) => unknown) | undefined>;
            subject[prop]?.(...args);
          }, options);
        };
      },
    },
  );
}

export const expect = new Proxy(bunExpect as unknown as MatcherBag, {
  apply(_target, _thisArg, args: unknown[]) {
    return matcherView({
      subject: args[0],
      mode: 'value',
      negated: false,
      label: typeof args[1] === 'string' ? args[1] : undefined,
    });
  },
  get(target, prop) {
    if (prop === 'poll') {
      return (callback: () => unknown, options?: { timeout?: number; interval?: number }) =>
        pollMatcher(callback, options);
    }
    if (prop === 'unreachable') {
      return (message?: string): never => {
        throw new Error(message ?? 'expected the code path to be unreachable');
      };
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
}) as unknown as LooseExpect;

// ---------------------------------------------------------------------------
// The `vi` object
// ---------------------------------------------------------------------------

export const vi = {
  fn: bt.mock as unknown as <T extends AnyFn>(
    implementation?: (...args: Parameters<T>) => ReturnType<T>,
  ) => CompatMock<T>,
  spyOn,
  mock: bt.mock.module.bind(bt.mock),
  doMock: (specifier: string, factory?: unknown): void => {
    void bt.mock.module(specifier, factory as never);
  },
  doUnmock: (_specifier?: string): void => {
    bt.mock.restore();
  },
  restoreAllMocks: bt.mock.restore.bind(bt.mock),
  clearAllMocks: bt.mock.clearAllMocks.bind(bt.mock),
  resetAllMocks: bt.mock.restore.bind(bt.mock),
  mocked: <T extends AnyFn>(value: T): Mock<T> => value as unknown as Mock<T>,
  hoisted: <T>(factory: () => T): T => factory(),
  importActual,
  requireActual,
  // 1.4.4 has no global module-cache reset. It does invalidate the ESM entry of a
  // *mocked* specifier (`removeEntry` after `overrideLoadedModuleExports`), so the
  // import that follows a `mock.module` re-instantiates on its own; anything else
  // stays cached, which is why this is a no-op rather than a real reset.
  resetModules: (): void => {},
  stubGlobal,
  stubEnv,
  unstubAllGlobals: unstubAll,
  unstubAllEnvs: unstubAll,
  waitFor,
  useFakeTimers: bt.vi.useFakeTimers as unknown as (options?: Record<string, unknown>) => void,
  useRealTimers: bt.vi.useRealTimers,
  setSystemTime: bt.setSystemTime as unknown as (time: number | Date) => void,
  advanceTimersByTime: bt.vi.advanceTimersByTime,
  advanceTimersByTimeAsync,
  advanceTimersToNextTimer: bt.vi.advanceTimersToNextTimer,
  runAllTimers: bt.vi.runAllTimers,
  runAllTimersAsync,
  runOnlyPendingTimers: bt.vi.runOnlyPendingTimers,
  runOnlyPendingTimersAsync,
  getTimerCount: bt.vi.getTimerCount,
  clearAllTimers: bt.vi.clearAllTimers,
  isFakeTimers: bt.vi.isFakeTimers,
};

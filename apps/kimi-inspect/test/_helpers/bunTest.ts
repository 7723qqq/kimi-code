export interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

const DEFAULT_INTERVAL_MS = 10;

export async function waitFor(
  assertion: () => void | Promise<void>,
  options: PollOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline) throw failure;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitUntil<T>(
  probe: () => T | Promise<T>,
  options: PollOptions & { readonly until?: (value: T) => boolean } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const until = options.until ?? ((value: T) => Boolean(value));
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  let lastError: unknown;
  let observed = false;
  for (;;) {
    try {
      const value = await probe();
      if (until(value)) return value;
      last = value;
      observed = true;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      observed = false;
    }
    if (Date.now() >= deadline) {
      if (observed) throw new Error(`waitUntil timed out after ${timeoutMs}ms with ${String(last)}`);
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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

import { jest, mock, vi } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

type UnknownRecord = Record<string, unknown>;

const repoRoot = join(import.meta.dirname, '../..');
const iconSpecifiers = new Set<string>();
function collectIcons(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectIcons(path);
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.vue')) continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/~icons\/[A-Za-z0-9_./?=&-]+/g)) {
      iconSpecifiers.add(match[0]);
    }
  }
}
collectIcons(join(repoRoot, 'packages'));
function rawIconSvg(specifier: string): string {
  const match = /^~icons\/([^/]+)\/([^?]+)\?raw$/.exec(specifier);
  if (match === null) return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const [, set, name] = match;
  if (set === 'kimi') {
    try {
      return readFileSync(join(repoRoot, 'packages/app-client/src/icons/kimi', `${name}.svg`), 'utf8');
    } catch {}
  }
  try {
    const iconSet = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules/@iconify-json', set!, 'icons.json'), 'utf8'),
    ) as {
      readonly viewBox?: string;
      readonly icons?: Record<string, { readonly body?: string }>;
      readonly aliases?: Record<string, { readonly parent?: string }>;
    };
    const alias = iconSet.aliases?.[name!];
    const resolved = alias?.parent ?? name!;
    const body = iconSet.icons?.[resolved]?.body;
    if (body !== undefined) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${iconSet.viewBox ?? '0 0 24 24'}">${body}</svg>`;
    }
  } catch {}
  return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
}
for (const specifier of iconSpecifiers) {
  if (specifier.includes('?raw')) {
    mock.module(specifier, () => ({ default: rawIconSvg(specifier) }));
  } else {
    mock.module(specifier, async () => {
      const { defineComponent } = await import('vue');
      return { default: defineComponent({ name: 'TestkitIconStub', render: () => null }) };
    });
  }
}
for (const specifier of [
  'markstream-vue/workers/katexRenderer.worker?worker&type=module',
  'markstream-vue/workers/mermaidParser.worker?worker&type=module',
]) {
  mock.module(specifier, () => ({ default: class TestkitWorker {} }));
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const domWindow = dom.window as unknown as UnknownRecord;
for (const key of [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'Event',
  'CustomEvent',
  'UIEvent',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'FocusEvent',
  'InputEvent',
  'DragEvent',
  'ClipboardEvent',
  'WheelEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
] as const) {
  const value = domWindow[key];
  if (value === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, {
      value: typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(domWindow) : value,
      configurable: true,
      writable: true,
    });
  } catch {}
}
for (const key of Object.getOwnPropertyNames(domWindow)) {
  if (key in globalThis) continue;
  const value = domWindow[key];
  if (typeof value !== 'function' && typeof value !== 'object') continue;
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {}
}
(globalThis as UnknownRecord)['self'] = domWindow;



if ((globalThis as UnknownRecord)['matchMedia'] === undefined) {
  Object.defineProperty(globalThis, 'matchMedia', {
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
    writable: true,
  });
}

class TestkitObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
for (const key of ['ResizeObserver', 'IntersectionObserver']) {
  if ((globalThis as UnknownRecord)[key] === undefined) {
    Object.defineProperty(globalThis, key, {
      value: TestkitObserverStub,
      configurable: true,
      writable: true,
    });
  }
}

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

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => process.nextTick(resolve));
}

async function advanceTimersByTimeAsync(milliseconds: number): Promise<typeof vi> {
  vi.advanceTimersByTime(milliseconds);
  await settleMicrotasks();
  return vi;
}

async function runAllTimersAsync(): Promise<typeof vi> {
  vi.runAllTimers();
  await settleMicrotasks();
  return vi;
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
  advanceTimersByTimeAsync,
  runAllTimersAsync,
  waitFor,
  waitUntil,
});

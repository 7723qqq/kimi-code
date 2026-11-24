import { jest, mock, vi } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { compileScript, compileTemplate, parse, registerTS } from '@vue/compiler-sfc';

type UnknownRecord = Record<string, unknown>;

// Vue's compiler resolves a type imported from a package through the
// TypeScript compiler API. This repository's TypeScript is the native 7.x
// preview, which ships no JavaScript API, so the resolution is done here: the
// package's own `types` entry is the file the compiler needs.
function resolvePackageTypes(source: string, containingFile: string): string | undefined {
  const separator = source.indexOf('/');
  const packageName =
    source.startsWith('@') && separator > 0
      ? source.slice(0, separator)
      : (source.split('/')[0] as string);
  const subpath = source === packageName ? '.' : `.${source.slice(packageName.length)}`;
  let directory = dirname(containingFile);
  for (;;) {
    const manifest = join(directory, 'node_modules', packageName, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as UnknownRecord;
      const candidates: string[] = [];
      const exportsField = parsed['exports'];
      if (typeof exportsField === 'object' && exportsField !== null) {
        const record = exportsField as UnknownRecord;
        const entry = record[subpath] ?? record['.'];
        if (typeof entry === 'string') candidates.push(entry);
        else if (typeof entry === 'object' && entry !== null) {
          const types = (entry as UnknownRecord)['types'];
          if (typeof types === 'string') candidates.push(types);
        }
      }
      for (const field of ['types', 'typings'] as const) {
        const value = parsed[field];
        if (typeof value === 'string') candidates.push(value);
      }
      for (const candidate of candidates) {
        const file = join(dirname(manifest), candidate);
        if (existsSync(file)) return file;
      }
      return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

registerTS(() =>
  ({
    versionMajorMinor: '5.9',
    findConfigFile: () => undefined,
    sys: { useCaseSensitiveFileNames: true },
    resolveModuleName: (source: string, containingFile: string) => {
      const resolved = resolvePackageTypes(source, containingFile);
      return resolved === undefined ? {} : { resolvedModule: { resolvedFileName: resolved } };
    },
  }) as never,
);

// Bun has no loader for Vue single-file components: an import of a `.vue`
// file resolves to the file path as a string, so a component renders as an
// unknown element instead of a component. Upstream runs these suites under
// Vitest, where @vitejs/plugin-vue compiles them. This plugin gives the Bun
// test runtime the same treatment, so the component suites actually run.
Bun.plugin({
  name: 'vue-sfc',
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const id = createHash('sha256').update(args.path).digest('hex').slice(0, 8);
      const scopeId = `data-v-${id}`;
      const { descriptor, errors } = parse(source, { filename: args.path });
      if (errors.length > 0) {
        throw new Error(
          `Failed to parse ${args.path}: ${errors.map((error) => error.message).join('; ')}`,
        );
      }

      const scoped = descriptor.styles.some((style) => style.scoped);
      const parts: string[] = [];
      let bindings: Record<string, string> | undefined;
      if (descriptor.script !== null || descriptor.scriptSetup !== null) {
        const script = compileScript(descriptor, {
          id,
          inlineTemplate: false,
          genDefaultAs: '__sfc__',
          fs: {
            fileExists: (file) => existsSync(file),
            readFile: (file) => {
              try {
                return readFileSync(file, 'utf-8');
              } catch {
                return undefined;
              }
            },
          },
        });
        bindings = script.bindings;
        parts.push(script.content);
      } else {
        parts.push('const __sfc__ = {};');
      }
      if (descriptor.template !== null) {
        const template = compileTemplate({
          source: descriptor.template.content,
          filename: args.path,
          id,
          scoped,
          slotted: descriptor.slotted,
          compilerOptions: { bindingMetadata: bindings, scopeId: scoped ? scopeId : undefined },
        });
        if (template.errors.length > 0) {
          throw new Error(
            `Failed to compile the template of ${args.path}: ${template.errors
              .map((error) => (error instanceof Error ? error.message : String(error)))
              .join('; ')}`,
          );
        }
        parts.push(template.code);
        parts.push('__sfc__.render = render;');
      }
      if (scoped) parts.push(`__sfc__.__scopeId = ${JSON.stringify(scopeId)};`);
      parts.push('export default __sfc__;');
      return { contents: parts.join('\n'), loader: 'ts' };
    });
  },
});

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
    await mock.module(specifier, () => ({ default: rawIconSvg(specifier) }));
  } else {
    await mock.module(specifier, async () => {
      const { defineComponent } = await import('vue');
      return { default: defineComponent({ name: 'TestkitIconStub', render: () => null }) };
    });
  }
}
for (const specifier of [
  'markstream-vue/workers/katexRenderer.worker?worker&type=module',
  'markstream-vue/workers/mermaidParser.worker?worker&type=module',
]) {
  await mock.module(specifier, () => ({ default: class TestkitWorker {} }));
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

// Bun's spyOn rejects accessor properties; Vitest spies on getters and
// setters. A component's computed property is read through its accessor, so
// the suites need the Vitest shape.
function accessorDescriptor(target: object, property: string): PropertyDescriptor | undefined {
  let current: object | null = target;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function spyOnAccessor(target: object, property: string): unknown {
  const descriptor = accessorDescriptor(target, property);
  if (descriptor === undefined) {
    throw new Error(`Cannot spy on property "${property}" because it is not defined`);
  }
  const originalGet = descriptor.get;
  const originalSet = descriptor.set;
  const calls: unknown[][] = [];
  const spy = {
    mock: { calls, results: [] as unknown[] },
    mockClear: () => {
      calls.length = 0;
    },
    mockReset: () => {
      calls.length = 0;
    },
    mockRestore: () => {
      Object.defineProperty(target, property, descriptor);
    },
  };
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get(this: unknown) {
      const value = originalGet?.call(this);
      calls.push([]);
      return value;
    },
    set(this: unknown, value: unknown) {
      calls.push([value]);
      originalSet?.call(this, value);
    },
  });
  return spy;
}

const bunSpyOn = bunVi['spyOn'];
bunVi['spyOn'] = (target: unknown, property: unknown, ...rest: unknown[]): unknown => {
  if (typeof target === 'object' && target !== null && typeof property === 'string') {
    const descriptor = accessorDescriptor(target, property);
    if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
      return spyOnAccessor(target, property);
    }
  }
  return (bunSpyOn as (...args: unknown[]) => unknown)(target, property, ...rest);
};

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
  jest.advanceTimersByTime(milliseconds);
  await settleMicrotasks();
  return vi;
}

async function runAllTimersAsync(): Promise<typeof vi> {
  jest.runAllTimers();
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

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { plugin } from 'bun';
import ts from 'typescript';
import { compileScript, compileTemplate, parse, registerTS } from 'vue/compiler-sfc';
import { expect, vi } from '@moonshot-ai/testkit/vitest';

import '../../../build/register-raw-text-loader.mjs';
import { kimiIconPlugins } from '../src/iconPlugins';

type CompatVi = typeof vi & {
  hoisted?: <T>(factory: () => T) => T;
  waitFor?: <T>(check: () => T | Promise<T>, options?: { timeout?: number; interval?: number }) => Promise<T>;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
  setSystemTime?: (time: number | Date) => void;
  stubGlobal?: (name: string, value: unknown) => void;
  unstubAllGlobals?: () => void;
  resetModules?: () => void;
  mocked?: <T>(value: T) => T;
};

const compatVi = vi as CompatVi;

if (typeof compatVi.hoisted !== 'function') {
  compatVi.hoisted = <T>(factory: () => T): T => factory();
}

if (typeof compatVi.waitFor !== 'function') {
  compatVi.waitFor = async <T>(
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

if (typeof compatVi.advanceTimersByTimeAsync !== 'function') {
  compatVi.advanceTimersByTimeAsync = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  };
}

if (typeof compatVi.setSystemTime !== 'function') {
  compatVi.setSystemTime = (time: number | Date) => {
    vi.useFakeTimers({ now: time });
  };
}

const globalOriginals = new Map<string, PropertyDescriptor | undefined>();

if (typeof compatVi.stubGlobal !== 'function') {
  compatVi.stubGlobal = (name: string, value: unknown) => {
    if (!globalOriginals.has(name)) {
      globalOriginals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
}

if (typeof compatVi.unstubAllGlobals !== 'function') {
  compatVi.unstubAllGlobals = () => {
    for (const [name, descriptor] of globalOriginals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
    globalOriginals.clear();
  };
}

if (typeof compatVi.resetModules !== 'function') {
  compatVi.resetModules = () => {};
}

if (typeof compatVi.mocked !== 'function') {
  compatVi.mocked = <T>(value: T): T => value;
}

const originalSpyOn = vi.spyOn.bind(vi);
const viRecord = vi as unknown as Record<string, unknown>;

function restoreProperty(object: object, key: PropertyKey, own: PropertyDescriptor | undefined): void {
  if (own !== undefined) Object.defineProperty(object, key, own);
  else Reflect.deleteProperty(object, key);
}

function callerTestFile(): string | undefined {
  const stack = new Error().stack ?? '';
  for (const line of stack.split('\n').slice(1)) {
    const match = /(?:\(|\s)([A-Za-z]:\\[^():]+|\/[^():]+\.(?:ts|tsx|js|mjs|cjs)):(\d+):(\d+)\)?$/.exec(
      line.trim(),
    );
    if (match === null) continue;
    const file = match[1]!;
    if (file.endsWith('preload-assets.ts')) continue;
    return file;
  }
  return undefined;
}

const importOriginalRequire = createRequire(import.meta.url);
const originalMock = vi.mock.bind(vi);
viRecord['mock'] = (path: string, factory?: unknown) => {
  if (typeof factory !== 'function') return originalMock(path, factory as never);
  return originalMock(path, () =>
    (factory as (importOriginal: () => Promise<unknown>) => unknown)(async () => {
      if (path.startsWith('node:')) return importOriginalRequire(path);
      const caller = callerTestFile();
      const base = caller === undefined ? process.cwd() : dirname(caller);
      return import(`${Bun.resolveSync(path, base)}?importOriginal`);
    }),
  );
};

viRecord['spyOn'] = (object: object, key: PropertyKey, accessType?: 'get' | 'set') => {
  const own = Object.getOwnPropertyDescriptor(object, key);
  const inherited =
    own ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object) as object, key);
  if (inherited === undefined) {
    return originalSpyOn(object as never, key as never, accessType as never);
  }
  if (accessType === 'get' || accessType === 'set') {
    const original = accessType === 'get' ? inherited.get : inherited.set;
    if (original === undefined) {
      return originalSpyOn(object as never, key as never, accessType as never);
    }
    const mock = vi.fn(original) as unknown as {
      apply(thisArg: unknown, args: unknown[]): unknown;
      mockRestore(): void;
    };
    Object.defineProperty(mock, 'mockRestore', {
      value: () => restoreProperty(object, key, own),
      configurable: true,
    });
    try {
      Object.defineProperty(object, key, {
        ...inherited,
        [accessType]: (...args: unknown[]) => mock.apply(object, args),
      });
    } catch {
      return originalSpyOn(object as never, key as never, accessType as never);
    }
    return mock;
  }
  const original = (object as Record<PropertyKey, unknown>)[key];
  if (typeof original !== 'function') {
    return originalSpyOn(object as never, key as never, accessType as never);
  }
  const mock = vi.fn(original as (...args: unknown[]) => unknown) as unknown as {
    mockRestore(): void;
  };
  Object.defineProperty(mock, 'mockRestore', {
    value: () => restoreProperty(object, key, own),
    configurable: true,
  });
  try {
    Object.defineProperty(object, key, {
      ...(own ?? { configurable: true, writable: true, enumerable: true }),
      value: mock,
    });
  } catch {
    return originalSpyOn(object as never, key as never, accessType as never);
  }
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

registerTS(() => ts as unknown as ReturnType<Parameters<typeof registerTS>[0]>);

const iconsDir = fileURLToPath(new URL('../../app-client/src/icons/kimi/', import.meta.url));
const loadIconHook = kimiIconPlugins(iconsDir).find((plugin) => plugin.name === 'unplugin-icons')?.load;
if (typeof loadIconHook !== 'function') throw new Error('Missing unplugin-icons load hook');
const loadIcon: OmitThisParameter<typeof loadIconHook> = loadIconHook;

function rewriteIconImports(source: string, filename: string): string {
  if (!source.includes('~icons/')) return source;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offsets: number[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('~icons/')) {
      offsets.push(specifier.getStart(file) + 1);
    }
  }
  for (const offset of offsets.reverse()) {
    source = `${source.slice(0, offset)}kimi-icon:${source.slice(offset)}`;
  }
  return source;
}

plugin({
  name: 'kimi-test-icons',
  setup({ onLoad }) {
    onLoad({ filter: /[\\/]packages[\\/]app-[^\\/]+[\\/]src[\\/].+\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      return { contents: rewriteIconImports(source, path), loader: 'ts' };
    });
    onLoad({ filter: /.*/, namespace: 'kimi-icon' }, async ({ path }) => {
      const result = await loadIcon(path);
      const contents = typeof result === 'string' ? result : result?.code;
      if (!contents) throw new Error(`Failed to load icon ${path}`);
      return { contents, loader: 'js' };
    });
  },
});

plugin({
  name: 'kimi-test-inline',
  setup({ onResolve, onLoad }) {
    onResolve({ filter: /\.(?:riv|wasm)\?inline$/ }, ({ path, importer }) => ({
      path: Bun.resolveSync(path.slice(0, -'?inline'.length), dirname(importer)).replaceAll('\\', '/'),
      namespace: 'kimi-test-inline',
    }));
    onLoad({ filter: /\.(?:riv|wasm)$/, namespace: 'kimi-test-inline' }, async ({ path }) => {
      const mime = path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
      const url = `data:${mime};base64,${bytes.toString('base64')}`;
      return { contents: `export default ${JSON.stringify(url)};`, loader: 'js' };
    });
  },
});

plugin({
  name: 'kimi-test-vue',
  setup({ onLoad }) {
    onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const source = await Bun.file(filename).text();
      const { descriptor, errors } = parse(source, { filename });
      if (errors.length > 0) throw new Error(`${filename}: ${errors.join('\n')}`);

      const id = new Bun.CryptoHasher('sha256').update(filename).digest('hex').slice(0, 8);
      const scoped = descriptor.styles.some((style) => style.scoped);
      const script = descriptor.script || descriptor.scriptSetup
        ? compileScript(descriptor, { id, genDefaultAs: '__component', fs: ts.sys })
        : undefined;
      const contents = [script?.content ?? 'const __component = {};'];

      if (descriptor.template) {
        const result = compileTemplate({
          source: descriptor.template.content,
          filename,
          id,
          scoped,
          compilerOptions: { bindingMetadata: script?.bindings },
        });
        if (result.errors.length > 0) throw new Error(`${filename}: ${result.errors.join('\n')}`);
        contents.push(result.code, '__component.render = render;');
      }
      if (scoped) contents.push(`__component.__scopeId = ${JSON.stringify(`data-v-${id}`)};`);
      contents.push('export default __component;');
      return { contents: rewriteIconImports(contents.join('\n'), filename), loader: 'ts' };
    });
  },
});

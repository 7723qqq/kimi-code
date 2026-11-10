import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGE = join(ROOT, 'packages', 'agent-core-v2');
const SRC = join(PACKAGE, 'src');
const LEDGER = join(import.meta.dirname, 'unreachable-modules.txt');

interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: {
    readonly name: string;
    readonly exports?: Record<string, unknown>;
    readonly imports?: Record<string, unknown>;
  };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('dist')) sourceFiles(path, out);
    } else if (/\.tsx?$/.test(path) && !path.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function readManifest(dir: string): WorkspacePackage | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  return { dir, manifest: JSON.parse(readFileSync(file, 'utf8')) as WorkspacePackage['manifest'] };
}

const workspacePackages = new Map<string, WorkspacePackage>();
for (const parent of [join(ROOT, 'packages'), join(ROOT, 'apps')]) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const info = readManifest(join(parent, entry.name));
    if (info !== undefined) workspacePackages.set(info.manifest.name, info);
  }
}
for (const dir of [join(ROOT, 'apps', 'vis', 'server'), join(ROOT, 'apps', 'vis', 'web')]) {
  const info = readManifest(dir);
  if (info !== undefined) workspacePackages.set(info.manifest.name, info);
}

const CORE_PACKAGE = workspacePackages.get('@moonshot-ai/agent-core-v2')!;
const PRODUCT_PACKAGE_NAMES = [
  '@moonshot-ai/agent-core-v2',
  '@moonshot-ai/kimi-code-sdk',
  '@moonshot-ai/kap-server',
  '@moonshot-ai/klient',
  '@moonshot-ai/remote-control',
  '@moonshot-ai/acp-server',
  '@moonshot-ai/kimi-code-product',
  '@moonshot-ai/migration-legacy',
  '@moonshot-ai/vis-server',
];

function targetString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = targetString(item);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return targetString(record['default'] ?? record['import'] ?? record['types']);
}

function resolveFile(base: string): string | undefined {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function exportTarget(info: WorkspacePackage, subpath: string): string | undefined {
  const exports = info.manifest.exports ?? {};
  const direct = targetString(exports[subpath]);
  if (direct !== undefined) return resolveFile(join(info.dir, direct));
  for (const [key, value] of Object.entries(exports)) {
    if (!key.includes('*')) continue;
    const prefix = key.slice(0, key.indexOf('*'));
    if (!subpath.startsWith(prefix)) continue;
    const target = targetString(value);
    if (target === undefined) continue;
    return resolveFile(join(info.dir, target.replaceAll('*', subpath.slice(prefix.length))));
  }
  return undefined;
}

const packageNames = [...workspacePackages.keys()].toSorted((a, b) => b.length - a.length);
const texts = new Map<string, string>();
function text(file: string): string {
  let value = texts.get(file);
  if (value === undefined) {
    value = readFileSync(file, 'utf8');
    texts.set(file, value);
  }
  return value;
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return resolveFile(join(dirname(from), specifier));
  if (specifier.startsWith('#')) {
    const owner = [...workspacePackages.values()].find((info) =>
      from.replaceAll('\\', '/').startsWith(`${info.dir.replaceAll('\\', '/')}/`),
    );
    if (owner === undefined) return undefined;
    const imports = owner.manifest.imports ?? {};
    const direct = targetString(imports[specifier]);
    if (direct !== undefined) return resolveFile(join(owner.dir, direct));
    for (const [key, value] of Object.entries(imports)) {
      if (!key.includes('*')) continue;
      const prefix = key.slice(0, key.indexOf('*'));
      if (!specifier.startsWith(prefix)) continue;
      const target = targetString(value);
      if (target === undefined) continue;
      const resolved = resolveFile(
        join(owner.dir, target.replaceAll('*', specifier.slice(prefix.length))),
      );
      if (resolved !== undefined) return resolved;
    }
    if (owner === CORE_PACKAGE && specifier.startsWith('#/')) {
      return resolveFile(join(SRC, 'human', specifier.slice(2)));
    }
    return undefined;
  }
  const name = packageNames.find(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
  if (name === undefined) return undefined;
  const info = workspacePackages.get(name)!;
  const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;
  return exportTarget(info, subpath) ?? exportTarget(info, './*');
}

function exportRoots(info: WorkspacePackage): string[] {
  const roots: string[] = [];
  for (const [key, value] of Object.entries(info.manifest.exports ?? {})) {
    if (key.includes('*') || key === './package.json') continue;
    const target = targetString(value);
    if (target === undefined) continue;
    const resolved = resolveFile(join(info.dir, target));
    if (resolved !== undefined) roots.push(resolved);
  }
  return roots;
}

function edges(file: string): string[] {
  const targets = new Set<string>();
  for (const match of text(file).matchAll(
    /(?:^|\n)\s*(?:import|export)[^;]*?(?:from\s*)?(['"])([^'"]+)\1/g,
  )) {
    const target = resolveImport(file, match[2]!);
    if (target !== undefined) targets.add(target);
  }
  return [...targets];
}

function reachableFrom(roots: readonly string[]): Set<string> {
  const reachable = new Set<string>();
  const queue = roots.filter((root) => existsSync(root));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const target of edges(file)) if (!reachable.has(target)) queue.push(target);
  }
  return reachable;
}

const productRoots = PRODUCT_PACKAGE_NAMES.flatMap((name) => {
  const info = workspacePackages.get(name);
  return info === undefined ? [] : exportRoots(info);
});
for (const root of [
  join(ROOT, 'apps', 'kimi-code', 'src', 'main.ts'),
  join(ROOT, 'apps', 'vis', 'server', 'src', 'index.ts'),
  join(ROOT, 'apps', 'vis', 'server', 'src', 'start.ts'),
  join(ROOT, 'apps', 'vis', 'web', 'src', 'main.tsx'),
  join(ROOT, 'apps', 'vscode', 'src', 'extension.ts'),
]) {
  if (existsSync(root)) productRoots.push(root);
}
const testRoots = [...workspacePackages.values()].flatMap((info) =>
  sourceFiles(join(info.dir, 'test')),
);
testRoots.push(...sourceFiles(join(SRC, 'human', 'test')));

const product = reachableFrom(productRoots);
const tests = reachableFrom(testRoots);
const files = sourceFiles(SRC);
const relativeName = (file: string) => relative(SRC, file).replaceAll('\\', '/');
const productUnreachable = files
  .filter((file) => !product.has(file))
  .map(relativeName)
  .filter((file) => !file.startsWith('human/test/'))
  .map((file) => `src/${file}`)
  .toSorted();
const ledger = readFileSync(LEDGER, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((line) => line.split(/\s+/u)[0]!)
  .toSorted();

describe('module reachability', () => {
  it('roots the product graph at concrete package exports and app entry points', () => {
    for (const root of productRoots) expect(product.has(root)).toBe(true);
    expect(productRoots).toContain(join(SRC, 'index.ts'));
    expect(productRoots).toContain(join(SRC, 'remote', 'index.ts'));
    expect(productRoots).toContain(join(SRC, 'remote', 'server', 'index.ts'));
    expect(productRoots).toContain(join(ROOT, 'apps', 'kimi-code', 'src', 'main.ts'));
  });

  it('accounts for every source module the product entry points cannot reach', () => {
    const missing = productUnreachable.filter((file) => !ledger.includes(file));
    expect(missing).toEqual([]);
  });

  it('keeps the ledger free of stale entries', () => {
    const stale = ledger.filter((file) => !productUnreachable.includes(file));
    expect(stale).toEqual([]);
  });

  it('lists only files that exist', () => {
    const absent = ledger.filter((file) => !existsSync(join(PACKAGE, file)));
    expect(absent).toEqual([]);
  });

  it('keeps test-only reachability out of the product graph', () => {
    const helper = join(SRC, '_base', 'di', 'test.ts');
    expect(product.has(helper)).toBe(false);
    expect(tests.has(helper)).toBe(true);
  });
});

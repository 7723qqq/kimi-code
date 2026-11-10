import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'src');

const REGISTRARS = [
  'registerAgentProfile',
  'registerAgentToolService',
  'registerBuiltinSkill',
  'registerConfigOverlay',
  'registerConfigSection',
  'registerErrorDomain',
  'registerEvent2Class',
  'registerFeature',
  'registerFlagDefinition',
  'registerProviderDefinition',
  'registerProviderDefinitionIfAbsent',
  'registerUndoableProtocol',
] as const;

const ROOTS = ['index.ts', join('remote', 'index.ts'), join('remote', 'server', 'index.ts')];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const files = sourceFiles(SRC);
const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

function resolveSpecifier(from: string, specifier: string): string | undefined {
  const bases = specifier.startsWith('#human/')
    ? [join(SRC, 'human', specifier.slice(7))]
    : specifier.startsWith('#/')
      ? [join(SRC, specifier.slice(2)), join(SRC, 'human', specifier.slice(2))]
      : specifier.startsWith('.')
        ? [join(dirname(from), specifier)]
        : [];
  for (const base of bases) {
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (texts.has(candidate)) return candidate;
    }
  }
  return undefined;
}

const edges = new Map<string, string[]>();
for (const [file, text] of texts) {
  const targets = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:import|export)[^;]*?(?:from\s*)?'([^']+)'/g,
  )) {
    const target = resolveSpecifier(file, match[1]!);
    if (target !== undefined) targets.add(target);
  }
  edges.set(file, [...targets]);
}

const reachable = new Set<string>();
const queue = ROOTS.map((root) => join(SRC, root)).filter((root) => texts.has(root));
while (queue.length > 0) {
  const file = queue.pop()!;
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const target of edges.get(file) ?? []) if (!reachable.has(target)) queue.push(target);
}

function registrants(name: string): string[] {
  const pattern = new RegExp(`\\b${name}\\s*\\(`);
  return [...texts]
    .filter(([, text]) => pattern.test(text))
    .map(([file]) => file.slice(SRC.length + 1).replaceAll('\\', '/'))
    .toSorted();
}

describe('module registration wiring', () => {
  it('reaches the whole engine from its public entry points', () => {
    expect(reachable.size).toBeGreaterThan(300);
    expect(reachable.size).toBeLessThanOrEqual(texts.size);
  });

  for (const name of REGISTRARS) {
    it(`loads every ${name} call site from a public entry point`, () => {
      const files = registrants(name);
      expect(files.length).toBeGreaterThan(0);
      const orphaned = files.filter((file) => !reachable.has(join(SRC, file)));

      expect(orphaned).toEqual([]);
    });
  }
});

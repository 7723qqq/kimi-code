import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, out);
    } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function blockOf(text: string, open: number, openChar: string, closeChar: string): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return text.slice(open);
}

const files = sourceFiles(SRC);
const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

const arrayBodies = new Map<string, string>();
for (const [file, text] of texts) {
  for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=\n]+)?=\s*\[/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    arrayBodies.set(`${file}\u0000${match[1]!}`, blockOf(text, open, '[', ']'));
  }
}

function literalsOf(name: string, file: string, seen = new Set<string>()): string[] {
  const key = `${file}\u0000${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const body = arrayBodies.get(key);
  if (body === undefined) return [];
  const names = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  for (const spread of body.matchAll(/\.\.\.\s*([A-Za-z0-9_]+)/g)) {
    const target = [...arrayBodies.keys()].find((candidate) => candidate.endsWith(`\u0000${spread[1]!}`));
    if (target === undefined) continue;
    const [owner, identifier] = target.split('\u0000') as [string, string];
    names.push(...literalsOf(identifier, owner, seen));
  }
  return names;
}

interface Registration {
  readonly file: string;
  readonly raw: string;
  readonly name?: string;
  readonly hasWhen: boolean;
}

const constants = new Map<string, string>();
for (const text of texts.values()) {
  for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g)) {
    constants.set(match[1]!, match[2]!);
  }
}

function registrations(): Registration[] {
  const found: Registration[] = [];
  const call = /(?:registerAgentToolService|contributeTool)\s*\(\s*[A-Za-z0-9_$.]+\s*,\s*[A-Za-z0-9_$.]+\s*,\s*\{/g;
  for (const [file, text] of texts) {
    for (const match of text.matchAll(call)) {
      const block = blockOf(text, (match.index ?? 0) + match[0].length - 1, '{', '}');
      const raw = /name:\s*([A-Za-z0-9_$.']+)/.exec(block)?.[1] ?? '';
      const name = raw.startsWith("'") ? raw.slice(1, -1) : constants.get(raw);
      found.push({
        file: file.slice(SRC.length + 1).replaceAll('\\', '/'),
        raw,
        ...(name === undefined ? {} : { name }),
        hasWhen: /\bwhen:\s*/.test(block),
      });
    }
  }
  return found;
}

function profileToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of [
    join(SRC, 'session', 'agentLifecycle', 'profile', 'profiles.ts'),
    join(SRC, 'features', 'tower', 'workerProfile.ts'),
  ]) {
    for (const key of arrayBodies.keys()) {
      if (!key.startsWith(`${file}\u0000`)) continue;
      const identifier = key.split('\u0000')[1]!;
      for (const name of literalsOf(identifier, file)) names.add(name);
    }
    const text = texts.get(file) ?? '';
    for (const inline of text.matchAll(/tools:\s*\[([^\]]*)\]/g)) {
      for (const literal of (inline[1] ?? '').matchAll(/'([^']+)'/g)) names.add(literal[1]!);
    }
  }
  return names;
}

const ACTIVATION_EXCEPTIONS = new Set(['select_tools']);
const DYNAMIC_NAME_SITES = new Set(['features/tower/towerFeature.ts']);
const TOOL_ARRAYS = ['AGENT_TOOLS', 'CODER_TOOLS', 'EXPLORE_TOOLS', 'TOWER_WORKER_TOOLS'];
const DYNAMIC_TOOL_FAMILIES = [/^Tower[A-Z]/u, /^mcp__\*/u];

function allowlistNames(): Set<string> {
  const names = new Set<string>();
  for (const key of arrayBodies.keys()) {
    const [owner, identifier] = key.split('\u0000') as [string, string];
    if (!TOOL_ARRAYS.includes(identifier)) continue;
    for (const literal of literalsOf(identifier, owner)) names.add(literal);
  }
  for (const file of [
    join(SRC, 'session', 'agentLifecycle', 'profile', 'profiles.ts'),
    join(SRC, 'features', 'tower', 'workerProfile.ts'),
  ]) {
    for (const inline of (texts.get(file) ?? '').matchAll(/tools:\s*\[([^\]]*)\]/g)) {
      for (const literal of (inline[1] ?? '').matchAll(/'([^']+)'/g)) names.add(literal[1]!);
    }
  }
  return names;
}

describe('builtin tool wiring', () => {
  const found = registrations();
  const allowed = profileToolNames();

  it('resolves every registration name, or accounts for the dynamic ones explicitly', () => {
    expect(found.length).toBeGreaterThan(20);
    const unresolved = new Set(
      found.filter((entry) => entry.name === undefined).map((entry) => entry.file),
    );
    expect([...unresolved].toSorted()).toEqual([...DYNAMIC_NAME_SITES].toSorted());
    expect(allowed.size).toBeGreaterThan(20);
  });

  it('exposes every registered tool, either through a profile allowlist or a when predicate', () => {
    const unwired = found
      .filter(
        (entry) =>
          entry.name !== undefined &&
          !entry.hasWhen &&
          !allowed.has(entry.name) &&
          !ACTIVATION_EXCEPTIONS.has(entry.name),
      )
      .map(
        (entry) =>
          `${entry.file}: '${entry.name}' is registered with no when predicate and is absent from every profile allowlist, so no agent ever receives it`,
      );

    expect(unwired).toEqual([]);
  });

  it('names no tool in a profile allowlist that nothing registers', () => {
    const known = new Set(
      found.flatMap((entry) => (entry.name === undefined ? [] : [entry.name])),
    );
    const unexplained = [...allowlistNames()]
      .filter(
        (name) =>
          !known.has(name) && !DYNAMIC_TOOL_FAMILIES.some((pattern) => pattern.test(name)),
      )
      .toSorted();

    expect(unexplained).toEqual([]);
  });
});

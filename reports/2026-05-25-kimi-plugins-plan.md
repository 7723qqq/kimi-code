# Kimi Code `/plugins` v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/plugins` so local-path plugins contribute skills (and a narrow `<system-reminder>` bootstrap) to new sessions, with Superpowers passing an end-to-end "brainstorming auto-triggers on a fresh prompt" acceptance test.

**Architecture:** Plugin parsing/manifest/store live in a new `packages/agent-core/src/plugin/` module. A core-owned `PluginManager` snapshots enabled-plugin state at session creation time, feeding skill directories into `SessionSkillConfig.extraDirs` and bootstrap declarations into a new `PluginsBootstrapInjector` that mounts beside `PlanModeInjector` in `InjectionManager`. RPC and TUI surfaces sit on top, mirroring the existing `/mcp` shape.

**Tech Stack:** TypeScript, Node.js ≥24.15, pnpm 10, vitest. Test files mirror `src/` under `packages/agent-core/test/`, suffix `*.test.ts`.

**Spec:** `reports/2026-05-25-kimi-plugins-design.md`

---

## File Map

### New (`packages/agent-core/src/plugin/`)
- `types.ts` — `PluginManifest`, `PluginRecord`, `PluginSummary`, `PluginInfo`, `PluginDiagnostic`, `EnabledBootstrap`, `ReloadSummary`
- `manifest.ts` — `parseManifest(root)` → record + diagnostics; handles `.kimi-plugin/` vs `.codex-plugin/` precedence and path safety
- `store.ts` — `readInstalled() / writeInstalled()` against `~/.kimi-code/plugins/installed.json` with atomic write
- `manager.ts` — `PluginManager` class (load, install, list, get, setEnabled, remove, reload, enabledSkillDirs, enabledBootstraps)
- `superpowers.ts` — `applyCompatShims(record)` synthesizing Superpowers' bootstrap until upstream ships it
- `index.ts` — barrel re-exports

### New (other)
- `packages/agent-core/src/agent/injection/plugins-bootstrap.ts` — `PluginsBootstrapInjector`
- `apps/kimi-code/src/tui/components/messages/plugins-status-panel.ts` — list + info renderers

### New tests (`packages/agent-core/test/plugin/`)
- `manifest.test.ts`, `store.test.ts`, `manager.test.ts`, `superpowers.test.ts`
- `packages/agent-core/test/agent/injection/plugins-bootstrap.test.ts`

### Modified
- `packages/agent-core/src/rpc/core-impl.ts` — instantiate `PluginManager`, extend `resolveSessionSkillConfig`, plumb `pluginBootstraps` into `Session`, implement RPCs
- `packages/agent-core/src/rpc/core-api.ts` — six new method types + payloads
- `packages/agent-core/src/session/index.ts` — accept `pluginBootstraps` in `SessionConfig`
- `packages/agent-core/src/agent/injection/manager.ts` — register `PluginsBootstrapInjector`
- `packages/node-sdk/src/rpc.ts` — re-export six RPCs
- `apps/kimi-code/src/tui/commands/registry.ts` — add `plugins` slash command
- `apps/kimi-code/src/tui/kimi-tui.ts` — dispatch `case 'plugins'`

---

## Phasing

| PR | Tasks | Outcome |
|----|-------|---------|
| PR1 | 1–3 | Pure parser + store, no runtime integration |
| PR2 | 4–7 | Manager wired into sessions; bootstrap fires; Superpowers compat shim |
| PR3 | 8–10 | RPC + SDK exports |
| PR4 | 11–14 | TUI slash command + end-to-end acceptance |

Each PR ends with a `gen-changesets`-produced changeset (default `minor`, per `AGENTS.md`).

---

## Task 1: Plugin module skeleton + diagnostics types

**Files:**
- Create: `packages/agent-core/src/plugin/types.ts`
- Create: `packages/agent-core/src/plugin/index.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
// packages/agent-core/src/plugin/types.ts

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
}

export interface PluginAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface PluginBootstrap {
  readonly skill: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly capabilities?: readonly string[];
  readonly websiteURL?: string;
  readonly defaultPrompt?: readonly string[] | string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[]; // resolved absolute paths
  readonly bootstrap?: PluginBootstrap;
  readonly interface?: PluginInterface;
}

/** Fields recognized in `.codex-plugin/plugin.json` but not executed by Kimi. */
export interface PluginRecognizedFields {
  readonly hooks?: boolean;
  readonly mcpServers?: boolean;
  readonly apps?: boolean;
}

export type PluginManifestKind = 'native' | 'codex';
export type PluginSource = 'local-path';
export type PluginState = 'ok' | 'error';

export interface PluginRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly installedAt: string;
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly recognizedFields: PluginRecognizedFields;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly skillCount: number;
  readonly hasErrors: boolean;
}

export interface PluginInfo extends PluginSummary {
  readonly source: PluginSource;
  readonly root: string;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly recognizedFields: PluginRecognizedFields;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface EnabledBootstrap {
  readonly pluginId: string;
  readonly skillName: string;
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

export const PLUGIN_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizePluginId(name: string): string {
  return name.toLowerCase();
}
```

- [ ] **Step 2: Write `index.ts`**

```ts
// packages/agent-core/src/plugin/index.ts
export * from './types';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @moonshot-ai/agent-core typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add packages/agent-core/src/plugin/types.ts packages/agent-core/src/plugin/index.ts
git commit -m "feat(agent-core): add plugin types skeleton"
```

---

## Task 2: Manifest parser (`parseManifest`)

**Files:**
- Create: `packages/agent-core/src/plugin/manifest.ts`
- Test: `packages/agent-core/test/plugin/manifest.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-core/test/plugin/manifest.test.ts
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseManifest } from '../../src/plugin/manifest';

async function makePlugin(
  files: Record<string, string>,
  options: { dirs?: readonly string[] } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-test-'));
  for (const dir of options.dirs ?? []) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, 'utf8');
  }
  return root;
}

describe('parseManifest', () => {
  it('reads a minimal .kimi-plugin/plugin.json', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifestKind).toBe('native');
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to .codex-plugin/plugin.json when native is absent', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('codex');
    expect(result.manifest?.name).toBe('demo');
  });

  it('does NOT fall back to .codex-plugin/ when .kimi-plugin/ is invalid JSON', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': '{ not json',
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'codex-version' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.manifestKind).toBe('native');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_json' }),
    );
    expect(result.shadowedManifestPath).toBe(path.join(root, '.codex-plugin/plugin.json'));
  });

  it('reports shadowed codex manifest when native is valid', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
    });
    const result = await parseManifest(root);
    expect(result.shadowedManifestPath).toBe(path.join(root, '.codex-plugin/plugin.json'));
  });

  it('rejects names that violate the regex', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'Bad Name!' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_name' }),
    );
  });

  it('returns manifest.missing when neither file exists', async () => {
    const root = await makePlugin({});
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.missing' }),
    );
  });

  it('resolves a single skills path', async () => {
    const root = await makePlugin(
      { '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }) },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
  });

  it('resolves an array of skills paths', async () => {
    const root = await makePlugin(
      {
        '.kimi-plugin/plugin.json': JSON.stringify({
          name: 'demo',
          skills: ['./a/', './b/'],
        }),
      },
      { dirs: ['a', 'b'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'a'), path.join(root, 'b')]);
  });

  it('rejects a skills path not prefixed with ./', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: 'skills/' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_required_dot_slash' }),
    );
    expect(result.manifest?.skills).toEqual([]);
  });

  it('rejects a skills path that escapes plugin_root', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './../escape' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_escape' }),
    );
  });

  it('rejects a skills path that escapes via a symlink', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './sym' }),
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-outside-'));
    await symlink(outside, path.join(root, 'sym'));
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_escape' }),
    );
  });

  it('warns when skills resolves to a non-directory', async () => {
    const root = await makePlugin({
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './notes.md' }),
      'notes.md': 'hi',
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'manifest.skills.not_a_directory',
        severity: 'warn',
      }),
    );
  });

  it('records recognized-but-ignored fields from .codex-plugin/', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        hooks: { 'session-start': './hooks/session-start' },
        mcpServers: './mcp.json',
        apps: './apps',
      }),
    });
    const result = await parseManifest(root);
    expect(result.recognizedFields).toEqual({ hooks: true, mcpServers: true, apps: true });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.unknown_field.hooks', severity: 'info' }),
    );
  });

  it('captures interface.displayName and shortDescription', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        interface: { displayName: 'Demo', shortDescription: 'A demo.' },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.interface?.displayName).toBe('Demo');
    expect(result.manifest?.interface?.shortDescription).toBe('A demo.');
  });
});
```

- [ ] **Step 2: Run the tests; verify they fail**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/manifest.test.ts
```
Expected: FAIL with "Cannot find module '../../src/plugin/manifest'".

- [ ] **Step 3: Implement `manifest.ts`**

```ts
// packages/agent-core/src/plugin/manifest.ts
import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  PLUGIN_NAME_REGEX,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
  type PluginRecognizedFields,
} from './types';

const NATIVE_PATH = '.kimi-plugin/plugin.json';
const CODEX_PATH = '.codex-plugin/plugin.json';

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly recognizedFields: PluginRecognizedFields;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const nativePath = path.join(pluginRoot, NATIVE_PATH);
  const codexPath = path.join(pluginRoot, CODEX_PATH);
  const nativeExists = await isFile(nativePath);
  const codexExists = await isFile(codexPath);

  if (!nativeExists && !codexExists) {
    return {
      recognizedFields: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.missing',
          message: `No manifest at ${NATIVE_PATH} or ${CODEX_PATH}`,
        },
      ],
    };
  }

  // .kimi-plugin/ is authoritative — never silently falls back when invalid.
  const useNative = nativeExists;
  const manifestPath = useNative ? nativePath : codexPath;
  const manifestKind: PluginManifestKind = useNative ? 'native' : 'codex';
  const shadowedManifestPath =
    useNative && codexExists ? codexPath : undefined;

  let raw: unknown;
  try {
    const text = await readFile(manifestPath, 'utf8');
    raw = JSON.parse(text);
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      recognizedFields: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.invalid_json',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      recognizedFields: {},
      diagnostics: [
        {
          severity: 'error',
          code: 'manifest.invalid_json',
          message: 'manifest must be a JSON object',
        },
      ],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.missing_name',
      message: '"name" is required',
    });
    return { manifestKind, manifestPath, shadowedManifestPath, recognizedFields: {}, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.invalid_name',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, recognizedFields: {}, diagnostics };
  }

  const skills = await resolveSkillsField(pluginRoot, raw['skills'], diagnostics);

  const recognizedFields: PluginRecognizedFields = {};
  for (const field of ['hooks', 'mcpServers', 'apps'] as const) {
    if (raw[field] !== undefined) {
      recognizedFields[field] = true;
      diagnostics.push({
        severity: 'info',
        code: `manifest.unknown_field.${field}`,
        message: `"${field}" is present but Kimi does not execute it in v1`,
      });
    }
  }

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    bootstrap: readBootstrap(raw['bootstrap']),
    interface: readInterface(raw['interface']),
  };

  return {
    manifest,
    manifestKind,
    manifestPath,
    shadowedManifestPath,
    recognizedFields,
    diagnostics,
  };
}

async function resolveSkillsField(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...(raw as string[]));
  } else {
    diagnostics.push({
      severity: 'error',
      code: 'manifest.skills.invalid_type',
      message: '"skills" must be a string or string[]',
    });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.skills.path_required_dot_slash',
        message: `"skills" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute; // missing path is allowed; we'll catch via not_a_directory below
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        code: 'manifest.skills.path_escape',
        message: `"skills" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
        code: 'manifest.skills.not_a_directory',
        message: `"skills" path is not a directory (${entry})`,
      });
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}

function readBootstrap(raw: unknown): PluginManifest['bootstrap'] {
  if (!isObject(raw)) return undefined;
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) return undefined;
  return { skill };
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, 'displayName'),
    shortDescription: stringField(raw, 'shortDescription'),
    longDescription: stringField(raw, 'longDescription'),
    developerName: stringField(raw, 'developerName'),
    capabilities: stringArrayField(raw, 'capabilities'),
    websiteURL: stringField(raw, 'websiteURL'),
    defaultPrompt: defaultPromptField(raw['defaultPrompt']),
  };
  // Return undefined if literally everything is absent — keeps record clean.
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}

function defaultPromptField(raw: unknown): PluginInterface['defaultPrompt'] {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return raw as readonly string[];
  }
  return undefined;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringArrayField(raw: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value as readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests; verify they pass**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/manifest.test.ts
```
Expected: PASS — all 13 cases.

- [ ] **Step 5: Re-export from `index.ts`**

```ts
// packages/agent-core/src/plugin/index.ts
export * from './types';
export { parseManifest } from './manifest';
export type { ParsedManifestResult } from './manifest';
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/plugin/manifest.ts \
        packages/agent-core/src/plugin/index.ts \
        packages/agent-core/test/plugin/manifest.test.ts
git commit -m "feat(agent-core): parse plugin manifest with kimi+codex fallback"
```

---

## Task 3: `installed.json` store

**Files:**
- Create: `packages/agent-core/src/plugin/store.ts`
- Test: `packages/agent-core/test/plugin/store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-core/test/plugin/store.test.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type InstalledFile,
  readInstalled,
  writeInstalled,
} from '../../src/plugin/store';

async function makeKimiHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

describe('plugin store', () => {
  it('returns an empty list when the file does not exist', async () => {
    const home = await makeKimiHome();
    const result = await readInstalled(home);
    expect(result.plugins).toEqual([]);
    expect(result.version).toBe(1);
  });

  it('writes and reads installed.json round-trip', async () => {
    const home = await makeKimiHome();
    const data: InstalledFile = {
      version: 1,
      plugins: [
        {
          id: 'demo',
          root: '/tmp/demo',
          source: 'local-path',
          enabled: true,
          installedAt: '2026-05-25T09:00:00Z',
        },
      ],
    };
    await writeInstalled(home, data);
    const result = await readInstalled(home);
    expect(result).toEqual(data);
  });

  it('writes atomically (no .tmp left after success)', async () => {
    const home = await makeKimiHome();
    await writeInstalled(home, { version: 1, plugins: [] });
    const after = await readFile(path.join(home, 'plugins', 'installed.json'), 'utf8');
    expect(after).toContain('"version": 1');
  });

  it('throws on a corrupt installed.json instead of silently dropping it', async () => {
    const home = await makeKimiHome();
    await writeInstalled(home, { version: 1, plugins: [] });
    await writeFile(path.join(home, 'plugins', 'installed.json'), '{ not json', 'utf8');
    await expect(readInstalled(home)).rejects.toThrow(/parse/i);
  });
});
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/store.test.ts
```
Expected: FAIL ("Cannot find module '../../src/plugin/store'").

- [ ] **Step 3: Implement `store.ts`**

```ts
// packages/agent-core/src/plugin/store.ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PluginSource } from './types';

const INSTALLED_REL = path.join('plugins', 'installed.json');

export interface InstalledRecord {
  readonly id: string;
  readonly root: string;
  readonly source: PluginSource;
  readonly enabled: boolean;
  readonly installedAt: string;
}

export interface InstalledFile {
  readonly version: 1;
  readonly plugins: readonly InstalledRecord[];
}

const EMPTY: InstalledFile = { version: 1, plugins: [] };

export async function readInstalled(kimiHomeDir: string): Promise<InstalledFile> {
  const filePath = path.join(kimiHomeDir, INSTALLED_REL);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as InstalledFile;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.plugins)) {
      throw new Error('installed.json is not a valid InstalledFile object');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export async function writeInstalled(
  kimiHomeDir: string,
  data: InstalledFile,
): Promise<void> {
  const dir = path.join(kimiHomeDir, 'plugins');
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, 'installed.json');
  const tmp = `${final}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, final);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/store.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update `index.ts`**

```ts
// packages/agent-core/src/plugin/index.ts
export * from './types';
export { parseManifest } from './manifest';
export type { ParsedManifestResult } from './manifest';
export { readInstalled, writeInstalled } from './store';
export type { InstalledFile, InstalledRecord } from './store';
```

- [ ] **Step 6: Generate changeset and commit (PR 1)**

```bash
# Per AGENTS.md, run gen-changesets after each PR-sized chunk; minor bump.
# Add a changeset under .changeset/ with a one-line summary about the
# plugin parser/store module being introduced.
git add packages/agent-core/src/plugin/store.ts \
        packages/agent-core/src/plugin/index.ts \
        packages/agent-core/test/plugin/store.test.ts \
        .changeset/
git commit -m "feat(agent-core): add installed.json store for plugins"
```

---

## Task 4: `PluginManager` (no session wiring yet)

**Files:**
- Create: `packages/agent-core/src/plugin/manager.ts`
- Test: `packages/agent-core/test/plugin/manager.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-core/test/plugin/manager.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';

async function makeKimiHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

async function makePlugin(name: string, options: { skills?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  await mkdir(path.join(root, '.kimi-plugin'), { recursive: true });
  const manifest: Record<string, unknown> = { name };
  if (options.skills === true) {
    manifest['skills'] = './skills/';
    await mkdir(path.join(root, 'skills'), { recursive: true });
    await mkdir(path.join(root, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: A demo\n---\nbody',
      'utf8',
    );
  }
  await writeFile(
    path.join(root, '.kimi-plugin', 'plugin.json'),
    JSON.stringify(manifest),
    'utf8',
  );
  return root;
}

describe('PluginManager', () => {
  it('install() adds a plugin and load() rehydrates it from disk', async () => {
    const home = await makeKimiHome();
    const pluginRoot = await makePlugin('demo', { skills: true });

    let manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.list()).toEqual([]);

    const record = await manager.install(pluginRoot);
    expect(record.id).toBe('demo');
    expect(record.enabled).toBe(true);
    expect(manager.list()).toHaveLength(1);

    manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.list()).toHaveLength(1);
    expect(manager.get('demo')?.root).toBe(pluginRoot);
  });

  it('setEnabled() persists the new state', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.setEnabled('demo', false);
    expect(manager.get('demo')?.enabled).toBe(false);

    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('demo')?.enabled).toBe(false);
  });

  it('remove() clears the entry but does not delete the source directory', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.remove('demo');
    expect(manager.get('demo')).toBeUndefined();
    // Source directory survives.
    const { stat } = await import('node:fs/promises');
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('enabledSkillDirs() returns only enabled plugins skills paths', async () => {
    const home = await makeKimiHome();
    const a = await makePlugin('a', { skills: true });
    const b = await makePlugin('b', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    await manager.setEnabled('b', false);
    const dirs = manager.enabledSkillDirs();
    expect(dirs).toContain(path.join(a, 'skills'));
    expect(dirs).not.toContain(path.join(b, 'skills'));
  });

  it('reload() picks up an in-place manifest edit', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    await writeFile(
      path.join(root, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '2.0.0' }),
      'utf8',
    );
    const summary = await manager.reload();
    expect(summary.errors).toEqual([]);
    expect(manager.get('demo')?.manifest?.version).toBe('2.0.0');
  });

  it('install() refuses to add a directory without a manifest', async () => {
    const home = await makeKimiHome();
    const root = await mkdtemp(path.join(tmpdir(), 'no-manifest-'));
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await expect(manager.install(root)).rejects.toThrow(/manifest/i);
  });

  it('install() refuses to add the same plugin twice', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await expect(manager.install(root)).rejects.toThrow(/already installed/i);
  });

  it('keeps a plugin in error state instead of losing it on a broken manifest', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await writeFile(
      path.join(root, '.kimi-plugin', 'plugin.json'),
      '{ not json',
      'utf8',
    );
    await manager.reload();
    const record = manager.get('demo');
    expect(record?.state).toBe('error');
    expect(record?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_json' }),
    );
    expect(manager.enabledSkillDirs()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/manager.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `manager.ts`**

```ts
// packages/agent-core/src/plugin/manager.ts
import { parseManifest, type ParsedManifestResult } from './manifest';
import { readInstalled, writeInstalled, type InstalledRecord } from './store';
import {
  type EnabledBootstrap,
  type PluginInfo,
  type PluginRecord,
  type PluginSummary,
  type ReloadSummary,
  normalizePluginId,
} from './types';

export interface PluginManagerOptions {
  readonly kimiHomeDir: string;
}

export class PluginManager {
  private readonly kimiHomeDir: string;
  private records = new Map<string, PluginRecord>();

  constructor(options: PluginManagerOptions) {
    this.kimiHomeDir = options.kimiHomeDir;
  }

  async load(): Promise<void> {
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    for (const entry of file.plugins) {
      next.set(entry.id, await this.materialize(entry));
    }
    this.records = next;
  }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(normalizePluginId(id));
  }

  async install(root: string): Promise<PluginRecord> {
    const parsed = await parseManifest(root);
    if (parsed.manifest === undefined) {
      const msg = parsed.diagnostics.find((d) => d.severity === 'error')?.message
        ?? 'no manifest';
      throw new Error(`Cannot install plugin at ${root}: ${msg}`);
    }
    const id = normalizePluginId(parsed.manifest.name);
    if (this.records.has(id)) {
      throw new Error(`Plugin "${id}" is already installed`);
    }
    const record = recordFrom({
      id,
      root,
      enabled: true,
      installedAt: new Date().toISOString(),
      parsed,
    });
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const key = normalizePluginId(id);
    const current = this.records.get(key);
    if (current === undefined) throw new Error(`Plugin "${id}" is not installed`);
    if (current.enabled === enabled) return;
    this.records.set(key, { ...current, enabled });
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const key = normalizePluginId(id);
    if (!this.records.delete(key)) {
      throw new Error(`Plugin "${id}" is not installed`);
    }
    await this.persist();
  }

  async reload(): Promise<ReloadSummary> {
    const prevIds = new Set(this.records.keys());
    const file = await readInstalled(this.kimiHomeDir);
    const next = new Map<string, PluginRecord>();
    const errors: ReloadSummary['errors'] = [];
    for (const entry of file.plugins) {
      try {
        next.set(entry.id, await this.materialize(entry));
      } catch (error) {
        errors.push({ id: entry.id, message: (error as Error).message });
      }
    }
    const added: string[] = [];
    for (const id of next.keys()) if (!prevIds.has(id)) added.push(id);
    const removed: string[] = [];
    for (const id of prevIds) if (!next.has(id)) removed.push(id);
    this.records = next;
    return { added, removed, errors };
  }

  enabledSkillDirs(): readonly string[] {
    const dirs: string[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok' || record.manifest === undefined) continue;
      for (const dir of record.manifest.skills ?? []) dirs.push(dir);
    }
    return dirs;
  }

  enabledBootstraps(): readonly EnabledBootstrap[] {
    const out: EnabledBootstrap[] = [];
    for (const record of this.records.values()) {
      if (!record.enabled || record.state !== 'ok') continue;
      const skill = record.manifest?.bootstrap?.skill;
      if (skill === undefined) continue;
      out.push({ pluginId: record.id, skillName: skill });
    }
    return out;
  }

  summaries(): readonly PluginSummary[] {
    return this.list().map((record) => recordToSummary(record));
  }

  info(id: string): PluginInfo | undefined {
    const record = this.get(id);
    return record === undefined ? undefined : recordToInfo(record);
  }

  private async persist(): Promise<void> {
    const installed: InstalledRecord[] = [...this.records.values()].map((record) => ({
      id: record.id,
      root: record.root,
      source: record.source,
      enabled: record.enabled,
      installedAt: record.installedAt,
    }));
    await writeInstalled(this.kimiHomeDir, { version: 1, plugins: installed });
  }

  private async materialize(entry: InstalledRecord): Promise<PluginRecord> {
    const parsed = await parseManifest(entry.root);
    return recordFrom({
      id: entry.id,
      root: entry.root,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      parsed,
    });
  }
}

function recordFrom(input: {
  id: string;
  root: string;
  enabled: boolean;
  installedAt: string;
  parsed: ParsedManifestResult;
}): PluginRecord {
  const { parsed } = input;
  const hasError = parsed.diagnostics.some((d) => d.severity === 'error');
  return {
    id: input.id,
    root: input.root,
    source: 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    recognizedFields: parsed.recognizedFields,
    diagnostics: parsed.diagnostics,
  };
}

function recordToSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    displayName: record.manifest?.interface?.displayName ?? record.id,
    version: record.manifest?.version,
    enabled: record.enabled,
    state: record.state,
    skillCount: record.manifest?.skills?.length ?? 0,
    hasErrors: record.diagnostics.some((d) => d.severity === 'error'),
  };
}

function recordToInfo(record: PluginRecord): PluginInfo {
  return {
    ...recordToSummary(record),
    source: record.source,
    root: record.root,
    manifestPath: record.manifestPath,
    shadowedManifestPath: record.shadowedManifestPath,
    manifest: record.manifest,
    recognizedFields: record.recognizedFields,
    diagnostics: record.diagnostics,
  };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/manager.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update `index.ts`**

```ts
// packages/agent-core/src/plugin/index.ts
export * from './types';
export { parseManifest } from './manifest';
export type { ParsedManifestResult } from './manifest';
export { readInstalled, writeInstalled } from './store';
export type { InstalledFile, InstalledRecord } from './store';
export { PluginManager } from './manager';
export type { PluginManagerOptions } from './manager';
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/plugin/manager.ts \
        packages/agent-core/src/plugin/index.ts \
        packages/agent-core/test/plugin/manager.test.ts
git commit -m "feat(agent-core): add PluginManager for enable/disable/reload"
```

---

## Task 5: Superpowers compatibility shim

**Files:**
- Create: `packages/agent-core/src/plugin/superpowers.ts`
- Test: `packages/agent-core/test/plugin/superpowers.test.ts`
- Modify: `packages/agent-core/src/plugin/manager.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/agent-core/test/plugin/superpowers.test.ts
import { describe, expect, it } from 'vitest';

import { applyCompatShims } from '../../src/plugin/superpowers';
import type { PluginRecord } from '../../src/plugin/types';

function baseRecord(overrides: Partial<PluginRecord>): PluginRecord {
  return {
    id: 'superpowers',
    root: '/fake',
    source: 'local-path',
    enabled: true,
    state: 'ok',
    installedAt: '2026-05-25T09:00:00Z',
    recognizedFields: {},
    diagnostics: [],
    manifest: { name: 'superpowers', skills: ['/fake/skills'] },
    manifestKind: 'codex',
    manifestPath: '/fake/.codex-plugin/plugin.json',
    ...overrides,
  };
}

describe('applyCompatShims', () => {
  it('synthesizes a bootstrap for superpowers when manifest lacks one', () => {
    const result = applyCompatShims(baseRecord({}));
    expect(result.manifest?.bootstrap).toEqual({ skill: 'using-superpowers' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'compat.bootstrap.synthesized' }),
    );
  });

  it('leaves a record alone when bootstrap is already declared', () => {
    const record = baseRecord({
      manifest: { name: 'superpowers', bootstrap: { skill: 'something-else' } },
    });
    const result = applyCompatShims(record);
    expect(result.manifest?.bootstrap?.skill).toBe('something-else');
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'compat.bootstrap.synthesized' }),
    );
  });

  it('leaves non-superpowers plugins untouched', () => {
    const record = baseRecord({ id: 'other', manifest: { name: 'other' } });
    const result = applyCompatShims(record);
    expect(result.manifest?.bootstrap).toBeUndefined();
  });

  it('skips synthesis when the plugin is in error state', () => {
    const record = baseRecord({ state: 'error', manifest: undefined });
    const result = applyCompatShims(record);
    expect(result).toBe(record);
  });
});
```

- [ ] **Step 2: Run; verify failure**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/superpowers.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `superpowers.ts`**

```ts
// packages/agent-core/src/plugin/superpowers.ts
//
// Compatibility shims for plugins that predate Kimi's manifest fields.
// Each shim MUST be removable once the upstream plugin ships a Kimi-aware
// manifest. This file is intentionally a registry of named exceptions, not
// a pattern-matching system.

import type { PluginDiagnostic, PluginManifest, PluginRecord } from './types';

const SUPERPOWERS_BOOTSTRAP_SKILL = 'using-superpowers';

export function applyCompatShims(record: PluginRecord): PluginRecord {
  if (record.state !== 'ok' || record.manifest === undefined) return record;
  if (record.id !== 'superpowers') return record;
  if (record.manifest.bootstrap !== undefined) return record;
  const manifest: PluginManifest = {
    ...record.manifest,
    bootstrap: { skill: SUPERPOWERS_BOOTSTRAP_SKILL },
  };
  const diagnostic: PluginDiagnostic = {
    severity: 'info',
    code: 'compat.bootstrap.synthesized',
    message:
      `Synthesized bootstrap { skill: "${SUPERPOWERS_BOOTSTRAP_SKILL}" } for ` +
      'the superpowers plugin until upstream ships a Kimi-aware manifest.',
  };
  return {
    ...record,
    manifest,
    diagnostics: [...record.diagnostics, diagnostic],
  };
}
```

- [ ] **Step 4: Wire shim into `PluginManager.materialize` and `recordFrom`**

Open `packages/agent-core/src/plugin/manager.ts`. Add the import at the top:
```ts
import { applyCompatShims } from './superpowers';
```
Change the return of `recordFrom` to apply shims:
```ts
function recordFrom(input: { /* … */ }): PluginRecord {
  // … existing body …
  const base: PluginRecord = {
    id: input.id,
    root: input.root,
    source: 'local-path',
    enabled: input.enabled,
    state: hasError || parsed.manifest === undefined ? 'error' : 'ok',
    installedAt: input.installedAt,
    manifest: parsed.manifest,
    manifestKind: parsed.manifestKind,
    manifestPath: parsed.manifestPath,
    shadowedManifestPath: parsed.shadowedManifestPath,
    recognizedFields: parsed.recognizedFields,
    diagnostics: parsed.diagnostics,
  };
  return applyCompatShims(base);
}
```

- [ ] **Step 5: Verify all tests pass**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/
```
Expected: PASS — manager, manifest, store, superpowers all green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-core/src/plugin/superpowers.ts \
        packages/agent-core/src/plugin/manager.ts \
        packages/agent-core/test/plugin/superpowers.test.ts
git commit -m "feat(agent-core): synthesize Superpowers bootstrap via compat shim"
```

---

## Task 6: `PluginsBootstrapInjector`

**Files:**
- Create: `packages/agent-core/src/agent/injection/plugins-bootstrap.ts`
- Test: `packages/agent-core/test/agent/injection/plugins-bootstrap.test.ts`
- Modify: `packages/agent-core/src/agent/injection/manager.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agent-core/test/agent/injection/plugins-bootstrap.test.ts
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import { PluginsBootstrapInjector } from '../../../src/agent/injection/plugins-bootstrap';
import type { EnabledBootstrap } from '../../../src/plugin/types';
import type { SkillDefinition } from '../../../src/skill/types';

interface StubBootstrapAgent {
  pluginBootstraps: readonly EnabledBootstrap[];
  skills: { registry: { getSkill: (name: string) => SkillDefinition | undefined } };
  context: { history: unknown[]; appendSystemReminder: (content: string) => void };
}

function skill(name: string, body: string): SkillDefinition {
  return {
    name,
    description: '',
    path: `/fake/${name}/SKILL.md`,
    dir: `/fake/${name}`,
    content: body,
    metadata: {},
    source: 'extra',
  };
}

function bootstrapAgent(input: {
  bootstraps: readonly EnabledBootstrap[];
  skills: readonly SkillDefinition[];
}): Agent {
  const byName = new Map(input.skills.map((s) => [s.name.toLowerCase(), s]));
  const history: unknown[] = [];
  const agent: StubBootstrapAgent = {
    pluginBootstraps: input.bootstraps,
    skills: {
      registry: {
        getSkill: (name) => byName.get(name.toLowerCase()),
      },
    },
    context: {
      history,
      appendSystemReminder: (content: string) => {
        history.push({ role: 'user', content: [{ type: 'text', text: content }] });
      },
    },
  };
  return agent as unknown as Agent;
}

function lastReminder(agent: Agent): string {
  const history = (agent.context as unknown as { history: Array<{ role: string; content?: ReadonlyArray<{ text?: string }> }> }).history;
  const last = history.findLast((message) => message.role === 'user');
  return last?.content?.map((part) => part.text ?? '').join('') ?? '';
}

describe('PluginsBootstrapInjector', () => {
  it('injects one <plugin_bootstrap> block per declared bootstrap on first call', async () => {
    const agent = bootstrapAgent({
      bootstraps: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body of skill')],
    });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).toContain('<plugin_bootstrap plugin="superpowers" skill="using-superpowers">');
    expect(text).toContain('body of skill');
    expect(text).toContain('</plugin_bootstrap>');
  });

  it('does not re-inject on subsequent calls within the same session', async () => {
    const agent = bootstrapAgent({
      bootstraps: [{ pluginId: 'superpowers', skillName: 'using-superpowers' }],
      skills: [skill('using-superpowers', 'body')],
    });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toHaveLength(1);
  });

  it('skips a bootstrap whose skill is not registered (with diagnostic emitted)', async () => {
    const agent = bootstrapAgent({
      bootstraps: [
        { pluginId: 'demo', skillName: 'missing' },
        { pluginId: 'superpowers', skillName: 'using-superpowers' },
      ],
      skills: [skill('using-superpowers', 'body')],
    });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    const text = lastReminder(agent);
    expect(text).not.toContain('plugin="demo"');
    expect(text).toContain('plugin="superpowers"');
  });

  it('emits nothing when no bootstraps are declared', async () => {
    const agent = bootstrapAgent({ bootstraps: [], skills: [] });
    const injector = new PluginsBootstrapInjector(agent);
    await injector.inject();
    const history = (agent.context as unknown as { history: unknown[] }).history;
    expect(history).toEqual([]);
  });
});
```

- [ ] **Step 2: Run; verify failure**

```bash
pnpm --filter @moonshot-ai/agent-core test test/agent/injection/plugins-bootstrap.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement injector**

```ts
// packages/agent-core/src/agent/injection/plugins-bootstrap.ts
import { DynamicInjector } from './injector';

export class PluginsBootstrapInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'plugins_bootstrap';

  protected override async getInjection(): Promise<string | undefined> {
    if (this.injectedAt !== null) return undefined;
    const bootstraps = this.agent.pluginBootstraps ?? [];
    if (bootstraps.length === 0) return undefined;
    const blocks: string[] = [];
    for (const bootstrap of bootstraps) {
      const skill = this.agent.skills?.registry.getSkill(bootstrap.skillName);
      if (skill === undefined) continue;
      blocks.push(
        `<plugin_bootstrap plugin="${escapeAttr(bootstrap.pluginId)}" ` +
          `skill="${escapeAttr(bootstrap.skillName)}">\n${skill.content}\n</plugin_bootstrap>`,
      );
    }
    if (blocks.length === 0) return undefined;
    return blocks.join('\n');
  }
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}
```

- [ ] **Step 4: Register injector in `InjectionManager`**

```ts
// packages/agent-core/src/agent/injection/manager.ts
import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { PermissionModeInjector } from './permission-mode';
import { PlanModeInjector } from './plan-mode';
import { PluginsBootstrapInjector } from './plugins-bootstrap';

export class InjectionManager {
  private readonly injectors: DynamicInjector[];

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginsBootstrapInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
    ];
  }
  // … rest unchanged …
}
```

- [ ] **Step 5: Extend `Agent` type to expose `pluginBootstraps`**

In `packages/agent-core/src/agent/index.ts`, add a `pluginBootstraps` readonly field on `Agent` populated from session config. Search for where `Agent` is constructed and add:

```ts
// In Agent class fields:
readonly pluginBootstraps: readonly EnabledBootstrap[];

// In constructor, alongside skills/etc.:
this.pluginBootstraps = options.pluginBootstraps ?? [];
```

And export `EnabledBootstrap` from `#/plugin`.

(Exact line numbers will depend on the latest source; place the field next to `skills` and `mcp`.)

- [ ] **Step 6: Verify tests pass**

```bash
pnpm --filter @moonshot-ai/agent-core test test/agent/injection/plugins-bootstrap.test.ts
pnpm --filter @moonshot-ai/agent-core test test/agent/injection/plan-mode.test.ts
```
Expected: PASS (the second confirms existing injectors still work).

- [ ] **Step 7: Commit**

```bash
git add packages/agent-core/src/agent/injection/plugins-bootstrap.ts \
        packages/agent-core/src/agent/injection/manager.ts \
        packages/agent-core/src/agent/index.ts \
        packages/agent-core/test/agent/injection/plugins-bootstrap.test.ts
git commit -m "feat(agent-core): inject plugin bootstraps via system reminder"
```

---

## Task 7: Wire `PluginManager` into `KimiCore` and session creation

**Files:**
- Modify: `packages/agent-core/src/rpc/core-impl.ts`
- Modify: `packages/agent-core/src/session/index.ts`

- [ ] **Step 1: Add `pluginBootstraps` to `SessionConfig`**

In `packages/agent-core/src/session/index.ts`, extend `SessionConfig`:

```ts
import type { EnabledBootstrap } from '#/plugin';

export interface SessionConfig {
  // … existing fields …
  readonly pluginBootstraps?: readonly EnabledBootstrap[];
}
```

Pass it down to created agents (the same wire as `skills`) so `Agent` can populate `agent.pluginBootstraps`.

- [ ] **Step 2: Instantiate `PluginManager` in `KimiCore`**

In `packages/agent-core/src/rpc/core-impl.ts`, after `ensureKimiHome(this.homeDir)`:

```ts
this.plugins = new PluginManager({ kimiHomeDir: this.homeDir });
```

Add to the class fields and import:

```ts
import { PluginManager } from '#/plugin';
// …
readonly plugins: PluginManager;
```

Also `await this.plugins.load()` lazily on first use (or eagerly in `createSession`). Eager is simpler:

```ts
private pluginsReady: Promise<void> = this.plugins.load().catch((error) => {
  this.telemetry.log?.error?.('plugin load failed', { error });
});
```

- [ ] **Step 3: Extend `resolveSessionSkillConfig`**

```ts
private resolveSessionSkillConfig(config: KimiConfig): SessionSkillConfig {
  const explicitDirs = this.skillDirs.length > 0 ? this.skillDirs : undefined;
  return {
    userHomeDir: this.userHomeDir,
    explicitDirs,
    extraDirs: [
      ...(config.extraSkillDirs ?? []),
      ...this.plugins.enabledSkillDirs(),
    ],
    mergeAllAvailableSkills: config.mergeAllAvailableSkills,
  };
}
```

- [ ] **Step 4: Pass bootstraps to the session**

In `createSession`, before `new Session({…})`:

```ts
await this.pluginsReady;
const pluginBootstraps = this.plugins.enabledBootstraps();
```

And inside the `new Session({…})` literal:

```ts
pluginBootstraps,
```

- [ ] **Step 5: Add a session integration test**

Create `packages/agent-core/test/plugin/integration.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';

describe('PluginManager → SkillRegistry integration', () => {
  it('enabled plugin contributes to enabledSkillDirs()', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await mkdir(path.join(pluginRoot, '.kimi-plugin'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills/' }),
      'utf8',
    );
    await mkdir(path.join(pluginRoot, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);

    expect(manager.enabledSkillDirs()).toContain(path.join(pluginRoot, 'skills'));
  });
});
```

- [ ] **Step 6: Verify**

```bash
pnpm --filter @moonshot-ai/agent-core test test/plugin/
pnpm --filter @moonshot-ai/agent-core typecheck
```
Expected: PASS.

- [ ] **Step 7: Generate changeset + commit (PR 2)**

```bash
# changeset entry: feat — plugin manager + bootstrap injector wired into sessions.
git add packages/agent-core/src/rpc/core-impl.ts \
        packages/agent-core/src/session/index.ts \
        packages/agent-core/test/plugin/integration.test.ts \
        .changeset/
git commit -m "feat(agent-core): wire PluginManager into session creation"
```

---

## Task 8: `CoreAPI` type additions

**Files:**
- Modify: `packages/agent-core/src/rpc/core-api.ts`

- [ ] **Step 1: Add payload and response types**

At the appropriate location (near `McpServerInfo` and friends), add:

```ts
import type { PluginInfo, PluginSummary, ReloadSummary } from '#/plugin';

export interface InstallPluginPayload {
  readonly root: string;
}
export interface SetPluginEnabledPayload {
  readonly id: string;
  readonly enabled: boolean;
}
export interface RemovePluginPayload {
  readonly id: string;
}
export interface GetPluginInfoPayload {
  readonly id: string;
}
export type ReloadPluginsResult = ReloadSummary;
export type { PluginSummary, PluginInfo };
```

- [ ] **Step 2: Add methods to `CoreAPI`**

```ts
export interface CoreAPI extends SessionAPIWithId {
  // … existing methods …
  listPlugins:      (p: EmptyPayload) => readonly PluginSummary[];
  installPlugin:    (p: InstallPluginPayload) => PluginSummary;
  setPluginEnabled: (p: SetPluginEnabledPayload) => void;
  removePlugin:     (p: RemovePluginPayload) => void;
  reloadPlugins:    (p: EmptyPayload) => ReloadPluginsResult;
  getPluginInfo:    (p: GetPluginInfoPayload) => PluginInfo;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @moonshot-ai/agent-core typecheck
```
Expected: FAIL — `KimiCore` doesn't yet implement the new methods. We'll fix in Task 9.

- [ ] **Step 4: Commit (no test yet; types only)**

```bash
git add packages/agent-core/src/rpc/core-api.ts
git commit -m "feat(agent-core): add plugin RPC types to CoreAPI"
```

---

## Task 9: Implement plugin RPCs in `KimiCore`

**Files:**
- Modify: `packages/agent-core/src/rpc/core-impl.ts`
- Test: `packages/agent-core/test/rpc/plugins-rpc.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/agent-core/test/rpc/plugins-rpc.test.ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';

describe('KimiCore plugin RPCs', () => {
  it('install → list → setEnabled → remove round trip', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await mkdtemp(path.join(tmpdir(), 'plugin-'));
    await mkdir(path.join(pluginRoot, '.kimi-plugin'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'utf8',
    );
    process.env['KIMI_CODE_HOME'] = home;

    // KimiCore needs a fake rpcClient that returns an SDKRPC; pass an inert
    // proxy that satisfies the type. The real RPC wiring is tested elsewhere.
    const core = new KimiCore(async () => ({}) as never, { homeDir: home });
    // Wait for pluginsReady.
    await new Promise((r) => setImmediate(r));

    const installed = await core.installPlugin({ root: pluginRoot });
    expect(installed.id).toBe('demo');
    expect(installed.version).toBe('1.0.0');

    const list = core.listPlugins({});
    expect(list).toHaveLength(1);

    await core.setPluginEnabled({ id: 'demo', enabled: false });
    const after = core.listPlugins({});
    expect(after[0]?.enabled).toBe(false);

    await core.removePlugin({ id: 'demo' });
    expect(core.listPlugins({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run; verify failure**

```bash
pnpm --filter @moonshot-ai/agent-core test test/rpc/plugins-rpc.test.ts
```
Expected: FAIL (methods don't exist yet).

- [ ] **Step 3: Add the six methods to `KimiCore` in `core-impl.ts`**

Place near `listMcpServers` / `reconnectMcpServer`:

```ts
async installPlugin(payload: InstallPluginPayload): Promise<PluginSummary> {
  await this.pluginsReady;
  const record = await this.plugins.install(payload.root);
  return this.plugins.summaries().find((s) => s.id === record.id)!;
}

listPlugins(_: EmptyPayload): readonly PluginSummary[] {
  return this.plugins.summaries();
}

async setPluginEnabled({ id, enabled }: SetPluginEnabledPayload): Promise<void> {
  await this.pluginsReady;
  await this.plugins.setEnabled(id, enabled);
}

async removePlugin({ id }: RemovePluginPayload): Promise<void> {
  await this.pluginsReady;
  await this.plugins.remove(id);
}

async reloadPlugins(_: EmptyPayload): Promise<ReloadPluginsResult> {
  return this.plugins.reload();
}

getPluginInfo({ id }: GetPluginInfoPayload): PluginInfo {
  const info = this.plugins.info(id);
  if (info === undefined) {
    throw new KimiError(
      ErrorCodes.NOT_FOUND,
      `Plugin "${id}" is not installed`,
      { details: { id } },
    );
  }
  return info;
}
```

(Adjust `ErrorCodes.NOT_FOUND` to whatever the existing error code enum exposes for not-found cases — re-use the MCP equivalent.)

- [ ] **Step 4: Verify**

```bash
pnpm --filter @moonshot-ai/agent-core test test/rpc/plugins-rpc.test.ts
pnpm --filter @moonshot-ai/agent-core typecheck
```
Expected: PASS, PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-core/src/rpc/core-impl.ts \
        packages/agent-core/test/rpc/plugins-rpc.test.ts
git commit -m "feat(agent-core): implement plugin RPCs in KimiCore"
```

---

## Task 10: SDK RPC exports

**Files:**
- Modify: `packages/node-sdk/src/rpc.ts`

- [ ] **Step 1: Mirror the six methods through the SDK**

Find the section where SDK RPC mirrors existing `CoreAPI` methods (e.g. `listSkills`, `listMcpServers`). Add:

```ts
listPlugins:      (input: EmptyPayload) => proxy.callCore('listPlugins', input),
installPlugin:    (input: InstallPluginPayload) => proxy.callCore('installPlugin', input),
setPluginEnabled: (input: SetPluginEnabledPayload) => proxy.callCore('setPluginEnabled', input),
removePlugin:     (input: RemovePluginPayload) => proxy.callCore('removePlugin', input),
reloadPlugins:    (input: EmptyPayload) => proxy.callCore('reloadPlugins', input),
getPluginInfo:    (input: GetPluginInfoPayload) => proxy.callCore('getPluginInfo', input),
```

(Exact wrapping shape depends on existing SDK helpers — copy the pattern from `listMcpServers`.)

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @moonshot-ai/node-sdk typecheck
```
Expected: PASS.

- [ ] **Step 3: Generate changeset + commit (PR 3)**

```bash
git add packages/node-sdk/src/rpc.ts .changeset/
git commit -m "feat(node-sdk): export plugin RPCs"
```

---

## Task 11: Register `/plugins` slash command

**Files:**
- Modify: `apps/kimi-code/src/tui/commands/registry.ts`

- [ ] **Step 1: Add to `BUILTIN_SLASH_COMMANDS`**

Insert near `mcp`:

```ts
{
  name: 'plugins',
  aliases: [],
  description: 'Manage plugins',
  priority: 60,
  availability: 'always',
},
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter kimi-code typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/kimi-code/src/tui/commands/registry.ts
git commit -m "feat(kimi-code): add /plugins slash command"
```

---

## Task 12: `plugins-status-panel.ts` renderer

**Files:**
- Create: `apps/kimi-code/src/tui/components/messages/plugins-status-panel.ts`

- [ ] **Step 1: Implement renderers modeled on `mcp-status-panel.ts`**

```ts
// apps/kimi-code/src/tui/components/messages/plugins-status-panel.ts
import type { PluginInfo, PluginSummary } from '@moonshot-ai/agent-core';

import type { ThemeColors } from '../../theme/colors';

export interface PluginsListPanelInput {
  readonly colors: ThemeColors;
  readonly plugins: readonly PluginSummary[];
}

export function buildPluginsListLines(input: PluginsListPanelInput): readonly string[] {
  if (input.plugins.length === 0) {
    return ['No plugins installed.', '', 'Try: /plugins install <absolute-path>'];
  }
  const lines: string[] = [];
  for (const plugin of input.plugins) {
    const enabled = plugin.enabled ? 'enabled' : 'disabled';
    const state = plugin.state === 'ok' ? '' : ` [${plugin.state}]`;
    const version = plugin.version ?? '—';
    lines.push(`${plugin.displayName} (${plugin.id}) ${version} · ${enabled}${state}`);
    lines.push(`  skills: ${plugin.skillCount}${plugin.hasErrors ? ' · diagnostics: see /plugins info' : ''}`);
  }
  return lines;
}

export interface PluginsInfoPanelInput {
  readonly colors: ThemeColors;
  readonly info: PluginInfo;
}

export function buildPluginsInfoLines(input: PluginsInfoPanelInput): readonly string[] {
  const { info } = input;
  const lines: string[] = [
    `${info.displayName} (${info.id}) ${info.version ?? ''}`.trim(),
    `Status: ${info.enabled ? 'enabled' : 'disabled'} · state: ${info.state}`,
    `Source: ${info.source}`,
    `Root:   ${info.root}`,
  ];
  if (info.manifestPath !== undefined) lines.push(`Manifest: ${info.manifestPath}`);
  if (info.shadowedManifestPath !== undefined) {
    lines.push(`Shadowed: ${info.shadowedManifestPath} (suppressed by native manifest)`);
  }
  lines.push('');
  lines.push(`Skills (${info.manifest?.skills?.length ?? 0}):`);
  for (const dir of info.manifest?.skills ?? []) lines.push(`  · ${dir}`);

  const iface = info.manifest?.interface;
  if (iface !== undefined) {
    lines.push('');
    lines.push('Display:');
    if (iface.shortDescription !== undefined) lines.push(`  · ${iface.shortDescription}`);
    if (iface.developerName !== undefined) lines.push(`  · by ${iface.developerName}`);
    if (iface.websiteURL !== undefined) lines.push(`  · ${iface.websiteURL}`);
    if (iface.capabilities !== undefined && iface.capabilities.length > 0) {
      lines.push(`  · capabilities: ${iface.capabilities.join(', ')}`);
    }
  }

  const ignored: string[] = [];
  if (info.recognizedFields.hooks === true) ignored.push('hooks');
  if (info.recognizedFields.mcpServers === true) ignored.push('mcpServers');
  if (info.recognizedFields.apps === true) ignored.push('apps');
  if (ignored.length > 0) {
    lines.push('');
    lines.push('Recognized but not executed by Kimi:');
    for (const field of ignored) lines.push(`  · ${field}`);
  }

  if (info.diagnostics.length > 0) {
    lines.push('');
    lines.push('Diagnostics:');
    for (const d of info.diagnostics) {
      lines.push(`  [${d.severity}] ${d.code}: ${d.message}`);
    }
  }
  return lines;
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter kimi-code typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/kimi-code/src/tui/components/messages/plugins-status-panel.ts
git commit -m "feat(kimi-code): add plugins status panel renderer"
```

---

## Task 13: `kimi-tui.ts` `/plugins` dispatcher

**Files:**
- Modify: `apps/kimi-code/src/tui/kimi-tui.ts`

- [ ] **Step 1: Add switch case + handler**

In `kimi-tui.ts`, near the `case 'mcp':` block:

```ts
case 'plugins':
  void this.handlePluginsCommand(args);
  return;
```

Add method:

```ts
private async handlePluginsCommand(rawArgs: string): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  const sub = args[0];
  const rest = args.slice(1);
  const session = this.requireSession();

  try {
    if (sub === undefined || sub === 'list') {
      const plugins = await session.listPlugins();
      const lines = buildPluginsListLines({ colors: this.state.theme.colors, plugins });
      const title = ` Plugins (${plugins.length}) `;
      const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary, title);
      this.state.transcriptContainer.addChild(panel);
      this.state.ui.requestRender();
      return;
    }
    if (sub === 'install') {
      const root = rest[0];
      if (root === undefined) {
        this.showError('Usage: /plugins install <absolute-path>');
        return;
      }
      const summary = await session.installPlugin({ root });
      this.showStatus(
        `Installed ${summary.displayName} (${summary.id}). Run /new to pick up its skills.`,
      );
      return;
    }
    if (sub === 'info') {
      const id = rest[0];
      if (id === undefined) {
        this.showError('Usage: /plugins info <id>');
        return;
      }
      const info = await session.getPluginInfo({ id });
      const lines = buildPluginsInfoLines({ colors: this.state.theme.colors, info });
      const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary, ` ${info.id} `);
      this.state.transcriptContainer.addChild(panel);
      this.state.ui.requestRender();
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = rest[0];
      if (id === undefined) {
        this.showError(`Usage: /plugins ${sub} <id>`);
        return;
      }
      await session.setPluginEnabled({ id, enabled: sub === 'enable' });
      this.showStatus(
        `${sub === 'enable' ? 'Enabled' : 'Disabled'} ${id}. Run /new to apply.`,
      );
      return;
    }
    if (sub === 'remove') {
      const id = rest[0];
      if (id === undefined) {
        this.showError('Usage: /plugins remove <id>');
        return;
      }
      await session.removePlugin({ id });
      this.showStatus(`Removed ${id} (source directory left in place).`);
      return;
    }
    if (sub === 'reload') {
      const summary = await session.reloadPlugins();
      const line = `Reload: +${summary.added.length} -${summary.removed.length}` +
        (summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : '');
      this.showStatus(line);
      return;
    }
    this.showError(`Unknown /plugins subcommand: ${sub}`);
  } catch (error) {
    this.showError(`/plugins ${sub ?? ''} failed: ${formatErrorMessage(error)}`);
  }
}
```

(Reuse existing helpers: `this.requireSession()`, `this.showStatus`, `this.showError`, `UsagePanelComponent`, `formatErrorMessage`. Imports added at top of file as needed.)

- [ ] **Step 2: Typecheck + run any existing TUI tests**

```bash
pnpm --filter kimi-code typecheck
pnpm --filter kimi-code test
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/kimi-code/src/tui/kimi-tui.ts
git commit -m "feat(kimi-code): dispatch /plugins subcommands"
```

---

## Task 14: End-to-end acceptance against the Superpowers checkout

**Files:** None (this task documents and runs the verification).

- [ ] **Step 1: Start a fresh Kimi Code TUI**

```bash
pnpm --filter kimi-code dev
```

- [ ] **Step 2: Install Superpowers**

In the TUI prompt:
```
/plugins install /Users/moonshot/code/superpowers
```
Expected: status line shows *"Installed Superpowers (superpowers). Run /new …"*.

- [ ] **Step 3: Open a new session**

```
/new
```

- [ ] **Step 4: Verify the bootstrap reminder was injected**

Inspect the session's transcript dump (or the agent log). Expected: exactly one
`<plugin_bootstrap plugin="superpowers" skill="using-superpowers">` block in the
context.

- [ ] **Step 5: Verify brainstorming triggers on a fresh prompt**

In the TUI:
```
Let's make a react todo list
```
Expected: the model engages a brainstorming flow (asks clarifying questions /
points at the brainstorming skill) instead of jumping straight to writing code.

- [ ] **Step 6: Verify info / disable / re-enable**

```
/plugins info superpowers          → shows manifest path + compat.bootstrap.synthesized info diagnostic
/plugins disable superpowers
/new
Let's make a react todo list       → model now responds normally (no brainstorming flow)
/plugins enable superpowers
/new
Let's make a react todo list       → brainstorming flow returns
```

- [ ] **Step 7: Verify remove preserves source**

```bash
ls /Users/moonshot/code/superpowers
# tree untouched
```
In the TUI:
```
/plugins remove superpowers
```
```bash
cat ~/.kimi-code/plugins/installed.json
# { "version": 1, "plugins": [] }
ls /Users/moonshot/code/superpowers
# tree still intact
```

- [ ] **Step 8: Verify no-code-execution invariant**

```bash
grep -rE 'require\(|child_process|vm\.|worker_threads|import\([^)]*\$' packages/agent-core/src/plugin/
# No matches.
```

- [ ] **Step 9: Generate changeset + commit (PR 4)**

```bash
git add .changeset/
git commit -m "feat(kimi-code): /plugins acceptance against Superpowers"
```

---

## Self-Review (against the spec)

- **§1 manifest schema (kimi+codex precedence, fields, recognized-but-ignored, path safety)** → Task 2.
- **§2 module layout + `installed.json` + manager API + session wiring + reload semantics** → Tasks 3, 4, 7.
- **§3 bootstrap field + Superpowers compat shim + injection via `<system-reminder>`** → Tasks 5, 6, 7.
- **§4 RPC additions + `/plugins` slash command + status panel + `/new` hint** → Tasks 8, 9, 10, 11, 12, 13.
- **§5 security (no execution, path containment, atomic write, no source deletion, namespacing)** → Tasks 2 (path safety), 3 (atomic write), 4 (`remove` preserves source). Grep invariant exercised in Task 14.
- **§6 four-PR phasing** → PR1 = Tasks 1–3, PR2 = Tasks 4–7, PR3 = Tasks 8–10, PR4 = Tasks 11–14.
- **§7 acceptance checklist (including brainstorming trigger)** → Task 14.
- **§8 follow-ups** — out of scope as designed (no task needed).

Type consistency: `PluginManager`, `PluginSummary`, `PluginInfo`, `EnabledBootstrap`, `ReloadSummary` are used identically across tasks; method names match what the spec declared.

No placeholders found.

---

## Execution Handoff

Plan complete and saved to `reports/2026-05-25-kimi-plugins-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

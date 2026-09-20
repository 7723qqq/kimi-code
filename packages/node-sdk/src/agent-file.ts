import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';

export interface AgentFileDefinition {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly override?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly prompt: string;
  readonly path: string;
  readonly source: string;
}

export interface ParseAgentFileOptions {
  readonly path: string;
  readonly source: string;
  readonly text: string;
}

/**
 * The engine's built-in main-agent profiles (`kimi-agent/src/prompt/profiles.rs`
 * `ProfileCatalog::with_builtins`). Names are matched case-insensitively, as
 * the engine's own catalog lookup does.
 */
export const BUILTIN_AGENT_PROFILE_NAMES: readonly string[] = [
  'agent',
  'coder',
  'explore',
  'plan',
];

export interface DiscoverAgentFilesOptions {
  /** Session working directory; anchors the project-root walk and relative extra dirs. */
  readonly workDir: string;
  /** `$KIMI_CODE_HOME` (default `~/.kimi-code`): the Kimi-specific user scope. */
  readonly kimiHome: string;
  /** The real OS home: the generic `~/.agents/agents/` scope stays under it. */
  readonly osHomeDir: string;
  /** `extra_agent_dirs` from the resolved config. */
  readonly extraDirs?: readonly string[];
  /** `--agent-file` paths, resolved against `workDir`; loaded at the highest precedence. */
  readonly explicitFiles?: readonly string[];
  /** Enabled plugins' agent directories (resolved from their manifests by the caller). */
  readonly pluginAgentDirs?: readonly string[];
  readonly onWarning?: (message: string) => void;
}

export interface DiscoveredAgentFiles {
  /** Highest-precedence first; one entry per name. */
  readonly profiles: readonly AgentFileDefinition[];
  readonly warnings: readonly string[];
}

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Directory names never scanned for agent files. */
const SKIPPED_DIR_NAMES = new Set(['.git', 'node_modules']);

export function resolveAgentPath(path: string, baseDir: string, osHomeDir: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return osHomeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(osHomeDir, trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed);
}

export function parseAgentFileText(options: ParseAgentFileOptions): AgentFileDefinition {
  const trimmed = options.text.trim();
  if (!trimmed.startsWith('---')) {
    throw new Error(`Missing frontmatter in ${options.path}`);
  }

  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    throw new Error(`Invalid frontmatter in ${options.path}: unclosed frontmatter block`);
  }

  const rawYaml = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trim();

  let frontmatter: unknown;
  try {
    frontmatter = loadYaml(rawYaml);
  } catch (error) {
    throw new Error(`Invalid frontmatter in ${options.path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error(`Frontmatter in ${options.path} must be a mapping at the top level`);
  }

  const record = frontmatter as Record<string, unknown>;
  const nameField = record['name'];
  if (nameField !== undefined && typeof nameField !== 'string') {
    throw new Error(`Frontmatter field "name" in ${options.path} must be a non-empty string`);
  }

  const name = (typeof nameField === 'string' && nameField.trim().length > 0)
    ? nameField.trim()
    : deriveNameFromPath(options.path);

  if (!name || !AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid agent name "${name ?? ''}" in ${options.path}: expected kebab-case (e.g. "code-reviewer")`,
    );
  }

  const descField = record['description'];
  const description = typeof descField === 'string' ? descField.trim() : '';
  if (!description) {
    throw new Error(`Missing required frontmatter field "description" in ${options.path}`);
  }

  const override = typeof record['override'] === 'boolean' ? record['override'] : false;

  return {
    name,
    description,
    whenToUse: typeof record['whenToUse'] === 'string' ? record['whenToUse'].trim() : undefined,
    override,
    tools: parseStringList(record['tools']),
    disallowedTools: parseStringList(record['disallowedTools']),
    subagents: parseStringList(record['subagents']),
    prompt: body,
    path: options.path,
    source: options.source,
  };
}

function parseStringList(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(value)) {
    return value
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

function deriveNameFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');
  return name !== '' ? name : undefined;
}

/**
 * Discover agent files across every documented scope and return them in
 * precedence order (`docs/en/customization/agents.md:56`): Explicit
 * (`--agent-file`) > Project > Extra > User > Plugin. Built-in profiles are
 * not files, so they are not returned; a discovered file only replaces a
 * same-name built-in when its frontmatter sets `override: true`
 * (`docs/en/customization/agents.md:76`), which the caller enforces by
 * dropping non-overriding files whose name matches a built-in.
 *
 * Each directory is scanned recursively for `.md` files. A file that fails to
 * parse is skipped with a warning and does not affect the others
 * (`docs/en/customization/agents.md:128`); an explicit `--agent-file` is the
 * one exception and throws, because a bad explicit file must fail the launch.
 */
export function discoverAgentFiles(options: DiscoverAgentFilesOptions): DiscoveredAgentFiles {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  const explicit = loadExplicitAgentFiles(options);
  const scopes: readonly (readonly AgentFileDefinition[])[] = [
    explicit,
    scanAgentDirs(projectAgentDirs(options.workDir), 'project', warn),
    scanAgentDirs(extraAgentDirs(options), 'extra', warn),
    scanAgentDirs(userAgentDirs(options), 'user', warn),
    scanAgentDirs(options.pluginAgentDirs ?? [], 'plugin', warn),
  ];

  // First writer wins per name: scopes are already ordered highest-first, and
  // within a scope the scan order decides. A discovered file replaces a
  // same-name built-in only when its frontmatter sets `override: true`;
  // `--agent-file` is explicit launch intent and needs no such flag
  // (`docs/en/customization/agents.md:76`).
  const byName = new Map<string, AgentFileDefinition>();
  for (const scope of scopes) {
    for (const definition of scope) {
      const key = definition.name.toLowerCase();
      if (byName.has(key)) continue;
      if (
        definition.source !== 'explicit' &&
        BUILTIN_AGENT_PROFILE_NAMES.includes(key) &&
        definition.override !== true
      ) {
        warn(
          `Agent file ${definition.path} defines built-in name "${definition.name}" without "override: true"; the built-in profile wins`,
        );
        continue;
      }
      byName.set(key, definition);
    }
  }

  return { profiles: [...byName.values()], warnings };
}

function loadExplicitAgentFiles(
  options: DiscoverAgentFilesOptions,
): readonly AgentFileDefinition[] {
  const out: AgentFileDefinition[] = [];
  for (const file of options.explicitFiles ?? []) {
    const path = resolveAgentPath(file, options.workDir, options.osHomeDir);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(
        `Failed to read agent file "${path}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      out.push(parseAgentFileText({ path, source: 'explicit', text }));
    } catch (error) {
      throw new Error(
        `Invalid agent file "${path}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return out;
}

/** Project root is the nearest ancestor of `workDir` containing `.git`; else `workDir`. */
function findProjectRoot(workDir: string): string {
  let current = resolve(workDir);
  for (;;) {
    try {
      if (readdirSync(current).includes('.git')) return current;
    } catch {
      return resolve(workDir);
    }
    const parent = resolve(current, '..');
    if (parent === current) return resolve(workDir);
    current = parent;
  }
}

function projectAgentDirs(workDir: string): readonly string[] {
  const root = findProjectRoot(workDir);
  return [join(root, '.kimi-code', 'agents'), join(root, '.agents', 'agents')];
}

function userAgentDirs(options: DiscoverAgentFilesOptions): readonly string[] {
  // The Kimi-specific scope follows KIMI_CODE_HOME; the generic one stays
  // under the real OS home so it can be shared across tools
  // (`docs/en/customization/agents.md:62`).
  return [
    join(options.kimiHome, 'agents'),
    join(options.osHomeDir, '.agents', 'agents'),
  ];
}

function extraAgentDirs(options: DiscoverAgentFilesOptions): readonly string[] {
  return (options.extraDirs ?? []).map((dir) =>
    resolveAgentPath(dir, options.workDir, options.osHomeDir),
  );
}

/** Recursively collect `.md` files under `dirs`, in stable path order. */
function scanAgentDirs(
  dirs: readonly string[],
  source: string,
  warn: (message: string) => void,
): readonly AgentFileDefinition[] {
  const out: AgentFileDefinition[] = [];
  for (const dir of dirs) {
    for (const file of listMarkdownFiles(dir, warn)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        warn(
          `Skipping agent file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      try {
        out.push(parseAgentFileText({ path: file, source, text }));
      } catch (error) {
        warn(
          `Skipping invalid agent file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return out;
}

function listMarkdownFiles(dir: string, warn: (message: string) => void): readonly string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing scope directory is the normal case, not a problem to report.
    return [];
  }
  const files: string[] = [];
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      files.push(...listMarkdownFiles(path, warn));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

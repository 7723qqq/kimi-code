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

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

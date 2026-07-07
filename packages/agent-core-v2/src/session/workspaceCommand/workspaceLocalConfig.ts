/**
 * `workspaceCommand` domain (L6) — workspace local-config file helpers.
 *
 * Reads and writes the `<projectRoot>/.kimi-code/local.toml` file that records
 * additional workspace directories persisted across sessions. Pure IO
 * functions over `IHostFileSystem` plus the host home directory; no scoped
 * state. Ported from v1's `config/workspace-local.ts` with the Kaos primitive
 * swapped for v2's host filesystem.
 */

import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

const WorkspaceLocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
});

type WorkspaceLocalToml = z.infer<typeof WorkspaceLocalTomlSchema>;

export interface WorkspaceLocalDeps {
  readonly fs: IHostFileSystem;
  readonly homeDir: string;
}

export interface WorkspaceAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

interface WorkspaceLocalTomlFile {
  readonly raw: Record<string, unknown>;
  readonly parsed: WorkspaceLocalToml;
}

export async function readWorkspaceAdditionalDirs(
  deps: WorkspaceLocalDeps,
  workDir: string,
): Promise<WorkspaceAdditionalDirsLoadResult> {
  const projectRoot = await findProjectRoot(deps, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const file = await readWorkspaceLocalToml(deps, configPath);

  const additionalDirs = file?.parsed.workspace?.additional_dir;
  if (additionalDirs === undefined) {
    return { projectRoot, configPath, additionalDirs: [] };
  }

  return {
    projectRoot,
    configPath,
    additionalDirs: await resolveAdditionalDirs(deps, projectRoot, additionalDirs),
  };
}

export async function resolveWorkspaceAdditionalDirs(
  deps: WorkspaceLocalDeps,
  projectRoot: string,
  additionalDirs: readonly string[],
): Promise<string[]> {
  return resolveAdditionalDirs(deps, projectRoot, additionalDirs);
}

export async function appendWorkspaceAdditionalDir(
  deps: WorkspaceLocalDeps,
  workDir: string,
  inputPath: string,
): Promise<WorkspaceAdditionalDirsLoadResult> {
  const projectRoot = await findProjectRoot(deps, workDir);
  const configPath = getWorkspaceLocalConfigPath(projectRoot);
  const additionalDir = await resolveAdditionalDir(deps, workDir, inputPath);
  const file = (await readWorkspaceLocalToml(deps, configPath)) ?? { raw: {}, parsed: {} };
  const fileAdditionalDirs = file.parsed.workspace?.additional_dir ?? [];
  const fileExistingDirs = resolveExistingAdditionalDirs(deps, projectRoot, fileAdditionalDirs);

  if (hasSameAdditionalDir(fileExistingDirs, additionalDir)) {
    return { projectRoot, configPath, additionalDirs: fileExistingDirs };
  }

  const workspace = cloneRecord(file.raw['workspace']);
  workspace['additional_dir'] = [...fileExistingDirs, additionalDir];
  file.raw['workspace'] = workspace;

  await deps.fs.mkdir(dirname(configPath), { recursive: true });
  await deps.fs.writeText(configPath, `${stringifyToml(file.raw)}\n`);

  return { projectRoot, configPath, additionalDirs: [...fileExistingDirs, additionalDir] };
}

export function normalizeAdditionalDirs(additionalDirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalizedDirs: string[] = [];

  for (const additionalDir of additionalDirs) {
    const normalized = normalize(additionalDir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedDirs.push(normalized);
  }

  return normalizedDirs;
}

function getWorkspaceLocalConfigPath(projectRoot: string): string {
  return join(projectRoot, '.kimi-code', 'local.toml');
}

async function findProjectRoot(deps: WorkspaceLocalDeps, workDir: string): Promise<string> {
  const initial = normalize(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(deps, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

async function readWorkspaceLocalToml(
  deps: WorkspaceLocalDeps,
  configPath: string,
): Promise<WorkspaceLocalTomlFile | undefined> {
  let text: string;
  try {
    text = await deps.fs.readText(configPath);
  } catch (error: unknown) {
    if (isPathMissing(error)) return undefined;
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (text.trim().length === 0) return { raw: {}, parsed: {} };

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error: unknown) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${configPath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (!isPlainObject(raw)) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid workspace local config in ${configPath}`);
  }

  return { raw: cloneRecord(raw), parsed: parseWorkspaceLocalToml(raw) };
}

function parseWorkspaceLocalToml(raw: Record<string, unknown>): WorkspaceLocalToml {
  try {
    return WorkspaceLocalTomlSchema.parse(raw);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, describeWorkspaceLocalValidationError(error), {
        cause: error,
      });
    }
    throw error;
  }
}

function describeWorkspaceLocalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'workspace' && issue.path[1] === 'additional_dir') {
    return 'workspace.additional_dir must be an array of strings';
  }
  if (issue?.path[0] === 'workspace') return 'workspace must be a table';
  return `Invalid workspace local config: ${error.message}`;
}

async function resolveAdditionalDirs(
  deps: WorkspaceLocalDeps,
  projectRoot: string,
  additionalDirs: readonly string[],
): Promise<string[]> {
  const resolvedDirs: string[] = [];

  for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
    const resolvedDir = await resolveAdditionalDir(deps, projectRoot, additionalDir);
    if (hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
    resolvedDirs.push(resolvedDir);
  }

  return resolvedDirs;
}

function resolveExistingAdditionalDirs(
  deps: WorkspaceLocalDeps,
  projectRoot: string,
  additionalDirs: readonly string[],
): string[] {
  const resolvedDirs: string[] = [];

  for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
    const resolvedDir = resolvePath(deps, projectRoot, additionalDir);
    if (hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
    resolvedDirs.push(resolvedDir);
  }

  return resolvedDirs;
}

async function resolveAdditionalDir(
  deps: WorkspaceLocalDeps,
  projectRoot: string,
  additionalDir: string,
): Promise<string> {
  const normalizedInput = normalizeAdditionalDirInput(additionalDir);
  const resolvedDir = resolvePath(deps, projectRoot, normalizedInput);
  await assertDirectory(deps, resolvedDir);
  return resolvedDir;
}

function normalizeAdditionalDirInput(additionalDir: string): string {
  if (typeof additionalDir !== 'string') {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      'workspace.additional_dir must be an array of strings',
    );
  }
  const trimmed = additionalDir.trim();
  if (trimmed.length === 0) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      'workspace.additional_dir must exist and be a directory',
    );
  }
  return normalize(trimmed);
}

function resolvePath(deps: WorkspaceLocalDeps, projectRoot: string, additionalDir: string): string {
  const expanded = expandHome(deps, additionalDir);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(projectRoot, expanded);
}

function expandHome(deps: WorkspaceLocalDeps, value: string): string {
  if (value === '~') return deps.homeDir;
  if (value.startsWith('~/')) return join(deps.homeDir, value.slice(2));
  return value;
}

function hasSameAdditionalDir(dirs: readonly string[], target: string): boolean {
  const normalizedTarget = normalize(target);
  return dirs.some((dir) => normalize(dir) === normalizedTarget);
}

async function assertDirectory(deps: WorkspaceLocalDeps, filePath: string): Promise<void> {
  let stat: Awaited<ReturnType<IHostFileSystem['stat']>>;
  try {
    stat = await deps.fs.stat(filePath);
  } catch (error: unknown) {
    if (isPathMissing(error)) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        'workspace.additional_dir must exist and be a directory',
      );
    }
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to stat ${filePath}: ${describeError(error)}`,
      { cause: error },
    );
  }

  if (!stat.isDirectory) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      'workspace.additional_dir must exist and be a directory',
    );
  }
}

async function pathExists(deps: WorkspaceLocalDeps, filePath: string): Promise<boolean> {
  try {
    await deps.fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathMissing(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function getErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code: unknown }).code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

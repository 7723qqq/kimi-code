/**
 * Project-local configuration (`<project-root>/.kimi-code/local.toml`) read and
 * write surface — a localized port of v2's `FileProjectLocalConfigService`
 * (`agent-core-v2/src/persistence/backends/node-fs/projectLocalConfigService.ts`).
 *
 * The file is per-checkout state that the host writes on `/add-dir … remember`
 * and reads back for every session of the project; `workspace.additional_dir`
 * extends the roots a session may touch, so entries must exist and must be
 * directories. Reading it is not gated on workspace trust: upstream #4013
 * rolled back the `IWorkspaceTrust` gate #3964 added, along with the
 * home-directory / filesystem-root rejection — v2's `resolvePath` is a purely
 * lexical resolve plus an `isDirectory` check.
 *
 * Import adaptations, matching `config-local/toml.ts`: `pathe` → `node:path`,
 * `IHostFileSystem` → `node:fs/promises`, `Error2` → `KimiError`, and the write
 * goes through the SDK's fsync'd `atomicWrite` instead of a plain write.
 */
import { lstat, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';

import { atomicWrite } from '#/config-local/fs';
import { ErrorCodes, KimiError } from '#/error-protocol';

export interface ProjectAdditionalDirsLocation {
  readonly projectRoot: string;
  readonly configPath: string;
}

export interface ProjectAdditionalDirsLoadResult extends ProjectAdditionalDirsLocation {
  readonly additionalDirs: readonly string[];
}

const ProjectLocalTomlSchema = z.object({
  workspace: z
    .object({
      additional_dir: z.array(z.string()),
    })
    .optional(),
});

type ProjectLocalToml = z.infer<typeof ProjectLocalTomlSchema>;

interface ProjectLocalTomlFile {
  readonly raw: Record<string, unknown>;
  readonly parsed: ProjectLocalToml;
}

const NOT_A_DIRECTORY_ERROR = 'workspace.additional_dir must exist and be a directory';
const NOT_STRINGS_ERROR = 'workspace.additional_dir must be an array of strings';

/** Where the project's config would live, whether or not the file exists. */
export async function locateAdditionalDirsConfig(
  workDir: string,
): Promise<ProjectAdditionalDirsLocation> {
  const projectRoot = await findProjectRoot(workDir);
  return {
    projectRoot: posix(projectRoot),
    configPath: posix(join(projectRoot, '.kimi-code', 'local.toml')),
  };
}

/** The project's extra roots, resolved and validated. */
export async function readAdditionalDirs(
  workDir: string,
): Promise<ProjectAdditionalDirsLoadResult> {
  const projectRoot = await findProjectRoot(workDir);
  const configPath = join(projectRoot, '.kimi-code', 'local.toml');
  const file = await readProjectLocalToml(configPath);
  const additionalDir = file?.parsed.workspace?.additional_dir;
  return {
    projectRoot: posix(projectRoot),
    configPath: posix(configPath),
    additionalDirs:
      additionalDir === undefined ? [] : await resolveAdditionalDirs(projectRoot, additionalDir),
  };
}

/**
 * Resolve raw entries against `baseDir` into absolute, deduplicated roots.
 * Rejects the broad-scope roots and anything that is not an existing directory.
 */
export async function resolveAdditionalDirs(
  baseDir: string,
  additionalDirs: readonly string[],
): Promise<string[]> {
  const resolvedDirs: string[] = [];
  for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
    const resolvedDir = await resolveAdditionalDir(baseDir, additionalDir);
    if (hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
    resolvedDirs.push(resolvedDir);
  }
  return resolvedDirs.map(posix);
}

/**
 * Add `inputPath` to the project's `workspace.additional_dir`, creating the file
 * on first use. An entry that is already listed is a no-op — the file keeps its
 * existing contents (including sections this reader does not model).
 *
 * Appends to one file are serialized per resolved config path: two concurrent
 * callers both read the old document, then each writes its own version of it,
 * and the later write silently drops the earlier caller's directory.
 */
export function appendAdditionalDir(
  workDir: string,
  inputPath: string,
): Promise<ProjectAdditionalDirsLoadResult> {
  return serializeByPath(workDir, () => appendAdditionalDirUnserialized(workDir, inputPath));
}

const appendQueues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task queued for the same `key`. */
function serializeByPath<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(key) ?? Promise.resolve();
  // `then(task, task)` rather than `then(…, …)` plus a catch: one rejection
  // must not skip the next caller's turn, and the caller still sees its own
  // error.
  const next = previous.then(task, task);
  // The queue entry exists only to order the callers. It is kept settled, so a
  // failure cannot poison the queue, and the cleanup chain must not produce an
  // unhandled rejection of its own.
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  appendQueues.set(key, settled);
  void settled.then(() => {
    if (appendQueues.get(key) === settled) appendQueues.delete(key);
  });
  return next;
}

async function appendAdditionalDirUnserialized(
  workDir: string,
  inputPath: string,
): Promise<ProjectAdditionalDirsLoadResult> {
  const projectRoot = await findProjectRoot(workDir);
  const configPath = join(projectRoot, '.kimi-code', 'local.toml');
  const additionalDir = await resolveAdditionalDir(workDir, inputPath);
  const file = (await readProjectLocalToml(configPath)) ?? { raw: {}, parsed: {} };
  const fileAdditionalDirs = file.parsed.workspace?.additional_dir ?? [];
  // Existing entries are re-resolved but not re-asserted: a directory that has
  // since been deleted stays in the file, and the read path reports it.
  const fileExistingDirs = resolveExistingAdditionalDirs(projectRoot, fileAdditionalDirs);

  if (hasSameAdditionalDir(fileExistingDirs, additionalDir)) {
    return {
      projectRoot: posix(projectRoot),
      configPath: posix(configPath),
      additionalDirs: fileExistingDirs.map(posix),
    };
  }

  const workspace = cloneRecord(file.raw['workspace']);
  workspace['additional_dir'] = [...fileExistingDirs, additionalDir];
  file.raw['workspace'] = workspace;

  try {
    await mkdir(dirname(configPath), { recursive: true });
    await atomicWrite(configPath, `${stringifyToml(file.raw)}\n`);
  } catch (error) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Could not write the project local config at ${configPath}: ${String(error)}`,
      { cause: error, details: { path: configPath } },
    );
  }

  return {
    projectRoot: posix(projectRoot),
    configPath: posix(configPath),
    additionalDirs: [...fileExistingDirs, additionalDir].map(posix),
  };
}

/**
 * v2 resolves with `pathe`, so every path it reports is forward-slashed on every
 * platform; the SDK reports paths the same way. The path math below still runs
 * through `node:path`, whose platform-native rules are what actually open files.
 */
function posix(path: string): string {
  return path.replaceAll('\\', '/');
}

async function findProjectRoot(workDir: string): Promise<string> {
  const initial = normalize(workDir);
  let current = initial;
  for (;;) {
    // `.git` is a directory in a clone and a file in a worktree; either marks
    // the project root.
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

async function readProjectLocalToml(configPath: string): Promise<ProjectLocalTomlFile | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (isPathMissing(error)) return undefined;
    // A caller branching on `KimiError.code` must not have to tell a raw
    // `EACCES` from a config problem: every failure on this surface is one.
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Could not read the project local config at ${configPath}: ${String(error)}`,
      { cause: error, details: { path: configPath } },
    );
  }

  if (text.trim().length === 0) return { raw: {}, parsed: {} };

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid TOML in ${configPath}`, {
      cause: error,
      details: { path: configPath, format: 'toml' },
    });
  }

  if (!isPlainObject(raw)) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid project local config in ${configPath}`);
  }

  return { raw: cloneRecord(raw), parsed: parseProjectLocalToml(raw) };
}

function resolveExistingAdditionalDirs(
  projectRoot: string,
  additionalDirs: readonly string[],
): string[] {
  const resolvedDirs: string[] = [];
  for (const additionalDir of normalizeAdditionalDirs(additionalDirs)) {
    const resolvedDir = resolvePath(projectRoot, additionalDir);
    if (hasSameAdditionalDir(resolvedDirs, resolvedDir)) continue;
    resolvedDirs.push(resolvedDir);
  }
  return resolvedDirs;
}

async function resolveAdditionalDir(baseDir: string, additionalDir: string): Promise<string> {
  const normalizedInput = normalizeAdditionalDirInput(additionalDir);
  const resolvedDir = resolvePath(baseDir, normalizedInput);
  await assertDirectory(resolvedDir);
  return resolvedDir;
}

function resolvePath(baseDir: string, additionalDir: string): string {
  const expanded = expandHome(additionalDir);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(baseDir, expanded);
}

function comparable(path: string): string {
  const normalized = normalize(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function hasSameAdditionalDir(dirs: readonly string[], target: string): boolean {
  const comparableTarget = comparable(target);
  return dirs.some((dir) => comparable(dir) === comparableTarget);
}

async function assertDirectory(filePath: string): Promise<void> {
  try {
    const stats = await stat(filePath);
    if (!stats.isDirectory()) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, NOT_A_DIRECTORY_ERROR);
    }
  } catch (error) {
    if (isPathMissing(error)) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, NOT_A_DIRECTORY_ERROR);
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeAdditionalDirs(additionalDirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalizedDirs: string[] = [];
  for (const additionalDir of additionalDirs) {
    // The normalized spelling is what every later step works on (v2 pushes
    // `normalize(...)` here too), so an entry padded with whitespace or a
    // redundant segment cannot reach the resolver in a second shape. The trim
    // comes first: normalizing a padded absolute path can fold its drive
    // segment into a relative one, which no later step can recover.
    const normalized = normalize(additionalDir.trim());
    const key = comparable(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedDirs.push(normalized);
  }
  return normalizedDirs;
}

function normalizeAdditionalDirInput(additionalDir: string): string {
  if (typeof additionalDir !== 'string') {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, NOT_STRINGS_ERROR);
  }
  const trimmed = additionalDir.trim();
  if (trimmed.length === 0) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, NOT_A_DIRECTORY_ERROR);
  }
  return normalize(trimmed);
}

function parseProjectLocalToml(raw: Record<string, unknown>): ProjectLocalToml {
  const parsed = ProjectLocalTomlSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      describeProjectLocalValidationError(parsed.error),
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function describeProjectLocalValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === 'workspace' && issue.path[1] === 'additional_dir') {
    return NOT_STRINGS_ERROR;
  }
  if (issue?.path[0] === 'workspace') return 'workspace must be a table';
  return `Invalid project local config: ${error.message}`;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

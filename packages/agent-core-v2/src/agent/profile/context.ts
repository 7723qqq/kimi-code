/**
 * `profile` domain (L4) — system-prompt context assembly.
 *
 * Loads the AGENTS.md instruction hierarchy (user-level brand + generic files,
 * then project-level files from the project root down to the cwd) and assembles
 * the {@link SystemPromptContext} bag consumed by `IAgentProfileService.useProfile`.
 *
 * Port of v1 `packages/agent-core/src/profile/context.ts`. The combined
 * AGENTS.md content is injected in full; when it exceeds the soft
 * {@link AGENTS_MD_RECOMMENDED_MAX_BYTES} budget a visible `agentsMdWarning`
 * is produced (surfaced through `getSessionWarnings`) instead of silently
 * truncating.
 */

import { basename, dirname, join } from 'pathe';

import type { IKaos } from '#/app/kaos';

import type { SystemPromptContext } from './profile';

// Soft budget for the combined AGENTS.md content injected into the system
// prompt. ~32 KB is roughly 8K–20K tokens (≈1.5–3% of a 262144-token context),
// large enough to leave the bulk of the context window to the conversation
// while still catching accidental oversized instruction files. Exceeding it no
// longer truncates content; it only surfaces a user-visible warning so the user
// can trim oversized instruction files.
export const AGENTS_MD_RECOMMENDED_MAX_BYTES = 32 * 1024;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

export interface PreparedSystemPromptContext extends SystemPromptContext {
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  /** Present when the combined AGENTS.md content exceeds the recommended size. */
  readonly agentsMdWarning?: string;
}

export interface PrepareSystemPromptContextOptions {
  readonly additionalDirs?: readonly string[];
}

export async function prepareSystemPromptContext(
  kaos: IKaos,
  brandHome?: string,
  options?: PrepareSystemPromptContextOptions,
): Promise<PreparedSystemPromptContext> {
  const additionalDirs = dedupeDirs(options?.additionalDirs ?? []);
  const [cwdListing, agentsMdResult, additionalDirsInfo] = await Promise.all([
    listDirectory(kaos, undefined, { collapseHiddenDirs: true }),
    loadAgentsMdForRoots(kaos, brandHome, [kaos.getcwd()]),
    loadAdditionalDirsInfo(kaos, additionalDirs),
  ]);
  return {
    cwdListing,
    agentsMd: agentsMdResult.content,
    additionalDirsInfo,
    agentsMdWarning: agentsMdResult.warning,
  };
}

export async function loadAgentsMd(kaos: IKaos, brandHome?: string): Promise<string> {
  const result = await loadAgentsMdForRoots(kaos, brandHome, [kaos.getcwd()]);
  return result.content;
}

interface LoadedAgentsMd {
  readonly content: string;
  readonly warning: string | undefined;
}

async function loadAgentsMdForRoots(
  kaos: IKaos,
  brandHome: string | undefined,
  workDirs: readonly string[],
): Promise<LoadedAgentsMd> {
  const discovered: AgentFile[] = [];
  const seen = new Set<string>();

  const collect = async (path: string): Promise<boolean> => {
    const file = await readAgentFile(kaos, path);
    if (file === undefined) return false;
    const key = kaos.normpath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    discovered.push(file);
    return true;
  };

  // User-level files come first so any project-level AGENTS.md overrides them.
  // The brand dir follows KIMI_CODE_HOME (default ~/.kimi-code); the generic
  // .agents dir stays under the real OS home so it can be shared across tools.
  const realHome = kaos.gethome();
  const brandDir = brandHome ?? join(realHome, '.kimi-code');
  await collect(join(brandDir, 'AGENTS.md'));

  // Generic user-level dir (.agents) matches skill discovery.
  const genericDirs = [join(realHome, '.agents')];
  const genericFiles = genericDirs.flatMap((dir) =>
    ['AGENTS.md', 'agents.md'].map((name) => join(dir, name)),
  );
  for (const file of genericFiles) {
    if (await collect(file)) break;
  }

  for (const workDir of workDirs) {
    const rootKaos = kaos.withCwd(workDir);
    const rootWorkDir = rootKaos.getcwd();
    const projectRoot = await findProjectRoot(rootKaos, rootWorkDir);
    const dirs = dirsRootToLeaf(rootKaos, rootWorkDir, projectRoot);

    for (const dir of dirs) {
      await collect(join(dir, '.kimi-code', 'AGENTS.md'));
      for (const fileName of ['AGENTS.md', 'agents.md']) {
        if (await collect(join(dir, fileName))) break;
      }
    }
  }

  const content = renderAgentFiles(discovered);
  const totalBytes = byteLength(content);
  const warning =
    totalBytes > AGENTS_MD_RECOMMENDED_MAX_BYTES
      ? `AGENTS.md total ${formatKB(totalBytes)} KB exceeds the recommended ` +
        `${formatKB(AGENTS_MD_RECOMMENDED_MAX_BYTES)} KB. Large instruction files ` +
        `increase cost and may impact performance; consider trimming.`
      : undefined;
  return { content, warning };
}

async function loadAdditionalDirsInfo(kaos: IKaos, additionalDirs: readonly string[]): Promise<string> {
  const sections = await Promise.all(
    additionalDirs.map(async (dir) => {
      const listing = await listDirectory(kaos.withCwd(dir));
      return `### ${dir}\n${listing}`;
    }),
  );
  return sections.join('\n\n');
}

async function findProjectRoot(kaos: IKaos, workDir: string): Promise<string> {
  const initial = kaos.normpath(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(kaos, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dirsRootToLeaf(kaos: IKaos, workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = kaos.normpath(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

async function readAgentFile(kaos: IKaos, path: string): Promise<AgentFile | undefined> {
  if (!(await isFile(kaos, path))) return undefined;
  const content = (await kaos.backend.readText(path, { errors: 'ignore' })).trim();
  if (content.length === 0) return undefined;
  return { path, content };
}

async function pathExists(kaos: IKaos, path: string): Promise<boolean> {
  try {
    await kaos.backend.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(kaos: IKaos, path: string): Promise<boolean> {
  try {
    const stat = await kaos.backend.stat(path);
    return (stat.stMode & S_IFMT) === S_IFREG;
  } catch {
    return false;
  }
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';
  return files.map((file) => `${annotationFor(file.path)}${file.content}`).join('\n\n');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatKB(bytes: number): string {
  const kb = bytes / 1024;
  return Number.isInteger(kb) ? String(kb) : kb.toFixed(1);
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}

function dedupeDirs(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== 'string') continue;
    const trimmed = dir.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

// ---------------------------------------------------------------------------
// listDirectory — compact 2-level directory tree for LLM context.
// Port of v1 `packages/agent-core/src/tools/support/list-directory.ts`, driven
// through the v2 `IKaos` backend (`iterdir` + `stat`).
// ---------------------------------------------------------------------------

interface ListDirectoryOptions {
  readonly collapseHiddenDirs?: boolean;
}

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  kaos: IKaos,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    for await (const fullPath of kaos.backend.iterdir(dirPath)) {
      const name = basename(fullPath);
      let isDir = false;
      try {
        const st = await kaos.backend.stat(fullPath);
        isDir = (st.stMode & S_IFMT) === S_IFDIR;
      } catch {
        // Unreadable entries keep isDir=false; still list the name.
      }
      all.push({ name, isDir });
    }
  } catch {
    return { entries: [], total: 0, readable: false };
  }
  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: all.slice(0, maxWidth), total: all.length, readable: true };
}

function shouldCollapseDirectory(entry: Entry, options: ListDirectoryOptions): boolean {
  return options.collapseHiddenDirs === true && entry.isDir && entry.name.startsWith('.');
}

async function listDirectory(
  kaos: IKaos,
  workDir: string = kaos.getcwd(),
  options: ListDirectoryOptions = {},
): Promise<string> {
  const lines: string[] = [];
  const { entries, total, readable } = await collectEntries(kaos, workDir, LIST_DIR_ROOT_WIDTH);
  if (!readable) return '[not readable]';
  const remaining = total - entries.length;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const { name, isDir } = entry;
    const isLast = i === entries.length - 1 && remaining === 0;
    const connector = isLast ? '└── ' : '├── ';

    if (isDir) {
      lines.push(`${connector}${name}/`);
      if (shouldCollapseDirectory(entry, options)) continue;
      const childPrefix = isLast ? '    ' : '│   ';
      const childDir = join(workDir, name);
      const child = await collectEntries(kaos, childDir, LIST_DIR_CHILD_WIDTH);
      if (!child.readable) {
        lines.push(`${childPrefix}└── [not readable]`);
        continue;
      }
      const childRemaining = child.total - child.entries.length;
      for (let j = 0; j < child.entries.length; j++) {
        const ce = child.entries[j];
        if (ce === undefined) continue;
        const cIsLast = j === child.entries.length - 1 && childRemaining === 0;
        const cConnector = cIsLast ? '└── ' : '├── ';
        const suffix = ce.isDir ? '/' : '';
        lines.push(`${childPrefix}${cConnector}${ce.name}${suffix}`);
      }
      if (childRemaining > 0) {
        lines.push(`${childPrefix}└── ... and ${String(childRemaining)} more`);
      }
    } else {
      lines.push(`${connector}${name}`);
    }
  }

  if (remaining > 0) {
    lines.push(`└── ... and ${String(remaining)} more entries`);
  }

  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}

/**
 * `fileTools` domain — GrepTool, the model's content search tool.
 *
 * Searches file contents with ripgrep-style regular expressions. The actual
 * scan runs through the os domains: `executeGrepSearch` (`./grepSearch`)
 * spawns `rg --json` via the host `IHostProcessService` and parses its output,
 * falling back to a gitignore-aware pure-node walker (through
 * `IHostFileSystem`) when `rg` is unavailable. The tool maps the model-facing
 * input args onto an `FsGrepRequest`, then renders the `FsGrepResponse` in the
 * v1 Grep output shape (`files_with_matches` / `content` / `count_matches`)
 * with `offset` / `head_limit` pagination and a sensitive-file post-filter.
 *
 * Path safety goes through the shared path access resolver used by
 * Read/Write/Edit/Grep: an explicit absolute path outside the workspace is
 * allowed for the access declaration, while a relative path that escapes the
 * workspace is rejected. The search itself is confined to the workspace
 * directory (`cwd` pinned to the workspace root), mirroring the previous
 * `ISessionFsService.grep` behavior — the `path` argument scopes only the
 * access declaration, not the search root.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/grep.ts`). The
 * v1 behavior of searching a path outside the workspace is intentionally not
 * replicated because this tool keeps the scan confined to the workspace root.
 */

import { isAbsolute, join } from 'node:path';

import type { FsGrepMatch, FsGrepRequest, FsGrepResponse } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { ToolResultBuilder } from '#/agent/tool/result-builder';
import { ToolAccesses } from '#/agent/tool/tool-access';
import type { BuiltinTool, ExecutableToolResult, ToolExecution } from '#/agent/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { ErrorCodes, isKimiError } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { resolvePathAccessPath } from '#/_base/tools/policies/path-access';
import { isSensitiveFile } from '#/_base/tools/policies/sensitive';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { executeGrepSearch } from '#/os/backends/node-local/tools/grepSearch';
import grepDescriptionTemplate from './grep.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Regular expression to search for.'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.',
    ),
  glob: z.string().optional().describe('Optional glob filter passed to ripgrep.'),
  type: z
    .string()
    .optional()
    .describe(
      'Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count_matches'])
    .optional()
    .describe(
      'Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match, most-recently-modified first (honors `head_limit`); `count_matches` shows per-file match counts as `path:count` lines, preceded by an aggregate total line. Defaults to `files_with_matches`.',
    ),
  '-i': z.boolean().optional().describe('Perform a case-insensitive search. Defaults to false.'),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.',
    ),
  '-A': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show after each match. Applies only when `output_mode` is `content`.',
    ),
  '-B': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before each match. Applies only when `output_mode` is `content`.',
    ),
  '-C': z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.',
    ),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.',
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.',
    ),
  include_ignored: z
    .boolean()
    .optional()
    .describe(
      'Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. Defaults to false.',
    ),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

type GrepMode = 'content' | 'files_with_matches' | 'count_matches';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_HEAD_LIMIT = 250;
// The fs layer is told not to cap its scan so the tool's own `head_limit`
// pagination is the only bound on output. These are the protocol maximums.
const FS_MAX_FILES = 10_000;
const FS_MAX_MATCHES_PER_FILE = 10_000;
const FS_MAX_TOTAL_MATCHES = 100_000;
const FS_MAX_CONTEXT_LINES = 10;
const MTIME_STAT_CONCURRENCY = 32;

const GREP_DESCRIPTION = renderPrompt(grepDescriptionTemplate, {});

// ── Tool ─────────────────────────────────────────────────────────────

export class GrepTool implements BuiltinTool<GrepInput> {
  readonly name = 'Grep' as const;
  readonly description = GREP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(GrepInputSchema);
  constructor(
    @IHostProcessService private readonly processService: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {}

  private get workspaceConfig(): WorkspaceConfig {
    return {
      workspaceDir: this.workspaceCtx.workDir,
      additionalDirs: this.workspaceCtx.additionalDirs,
    };
  }

  resolveExecution(args: GrepInput): ToolExecution {
    let searchPath: string | undefined;
    if (args.path !== undefined) {
      searchPath = resolvePathAccessPath(args.path, {
        env: this.env,
        workspace: this.workspaceConfig,
        operation: 'search',
        policy: { guardMode: 'absolute-outside-allowed', checkSensitive: false },
      });
    }
    const accessPath = searchPath ?? this.workspaceConfig.workspaceDir;
    const displayPath = args.path ?? this.workspaceConfig.workspaceDir;
    return {
      accesses: ToolAccesses.searchTree(accessPath),
      description: `Searching for '${args.pattern}' in ${displayPath}`,
      display: { kind: 'file_io', operation: 'grep', path: accessPath },
      approvalRule: literalRulePattern(this.name, args.pattern),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.pattern),
      execute: ({ signal }) => this.execution(args, signal),
    };
  }

  private async execution(args: GrepInput, signal: AbortSignal): Promise<ExecutableToolResult> {
    if (signal.aborted) {
      return { isError: true, output: 'Aborted before search started' };
    }

    let response: FsGrepResponse;
    try {
      response = await executeGrepSearch(buildGrepRequest(args), {
        processService: this.processService,
        fs: this.fs,
        cwd: this.workspaceConfig.workspaceDir,
      });
    } catch (error) {
      return mapGrepError(error);
    }

    if (signal.aborted) {
      return { isError: true, output: 'Grep aborted' };
    }

    return renderGrepResponse(args, response, {
      fs: this.fs,
      workspaceDir: this.workspaceConfig.workspaceDir,
      signal,
    });
  }
}

registerTool(GrepTool);

// ── Request mapping ──────────────────────────────────────────────────

function buildGrepRequest(args: GrepInput): FsGrepRequest {
  const includeGlobs: string[] = [];
  if (args.glob !== undefined) includeGlobs.push(args.glob);
  if (args.type !== undefined) includeGlobs.push(`**/*.${args.type}`);
  const req: FsGrepRequest = {
    pattern: args.pattern,
    // The tool's `pattern` is documented as a regular expression, so always
    // ask the fs layer for regex matching.
    regex: true,
    case_sensitive: args['-i'] !== true,
    follow_gitignore: args.include_ignored !== true,
    max_files: FS_MAX_FILES,
    max_matches_per_file: FS_MAX_MATCHES_PER_FILE,
    max_total_matches: FS_MAX_TOTAL_MATCHES,
    context_lines: contextLines(args),
    include_globs: includeGlobs.length > 0 ? includeGlobs : undefined,
    exclude_globs: undefined,
  };
  return args.multiline === true
    ? ({ ...req, multiline: true } as FsGrepRequest)
    : req;
}

function contextLines(args: GrepInput): number {
  if (args['-C'] !== undefined) return clamp(args['-C'], 0, FS_MAX_CONTEXT_LINES);
  const before = args['-B'] ?? 0;
  const after = args['-A'] ?? 0;
  return clamp(Math.max(before, after), 0, FS_MAX_CONTEXT_LINES);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ── Error mapping ────────────────────────────────────────────────────

function mapGrepError(error: unknown): ExecutableToolResult {
  if (isKimiError(error) && error.code === ErrorCodes.FS_GREP_TIMEOUT) {
    return {
      isError: true,
      output: 'Grep timed out. Try a more specific path or pattern.',
    };
  }
  return {
    isError: true,
    output: `Failed to grep: ${error instanceof Error ? error.message : String(error)}`,
  };
}

// ── Response rendering ───────────────────────────────────────────────

interface Page<T> {
  readonly visible: readonly T[];
  readonly truncated: boolean;
  readonly total: number;
  readonly nextOffset: number;
}

interface RenderDeps {
  readonly fs: IHostFileSystem;
  readonly workspaceDir: string;
  readonly signal: AbortSignal;
}

class GrepAbortedError extends Error {
  constructor() {
    super('Grep aborted');
    this.name = 'GrepAbortedError';
  }
}

function paginate<T>(items: readonly T[], args: GrepInput): Page<T> {
  const offset = args.offset ?? 0;
  const headLimit = args.head_limit ?? DEFAULT_HEAD_LIMIT;
  const afterOffset = offset > 0 ? items.slice(offset) : items;
  const limitActive = headLimit > 0;
  const visible = limitActive ? afterOffset.slice(0, headLimit) : afterOffset;
  const truncated = limitActive && afterOffset.length > headLimit;
  return { visible, truncated, total: items.length, nextOffset: offset + headLimit };
}

async function renderGrepResponse(
  args: GrepInput,
  response: FsGrepResponse,
  deps: RenderDeps,
): Promise<ExecutableToolResult> {
  const mode: GrepMode = args.output_mode ?? 'files_with_matches';

  // Post-filter sensitive files, mirroring v1's post-rg sensitive filter.
  // `ISessionFsService.grep` searches the whole workspace and does not exclude
  // sensitive paths, so the tool drops them before rendering.
  const filteredSensitive: string[] = [];
  const keptFiles = response.files.filter((file) => {
    if (isSensitiveFile(file.path)) {
      filteredSensitive.push(file.path);
      return false;
    }
    return true;
  });

  const inlineMessages: string[] = [];
  if (filteredSensitive.length > 0) {
    inlineMessages.push(
      `Filtered ${String(filteredSensitive.length)} sensitive file(s): ${filteredSensitive.join(', ')}`,
    );
  }
  if (response.truncated) {
    inlineMessages.push(
      'Search stopped early after reaching the match limit; results may be incomplete. Try a more specific path or pattern.',
    );
  }

  if (mode === 'count_matches') {
    return renderCountMatches(args, keptFiles, filteredSensitive.length > 0, inlineMessages);
  }
  if (mode === 'content') {
    return renderContent(args, keptFiles, inlineMessages, filteredSensitive.length > 0);
  }
  try {
    const sortedFiles = await sortFilesWithMatchesByMtime(keptFiles, deps);
    return renderFilesWithMatches(args, sortedFiles, inlineMessages, filteredSensitive.length > 0);
  } catch (error) {
    if (error instanceof GrepAbortedError) {
      return { isError: true, output: 'Grep aborted' };
    }
    throw error;
  }
}

async function sortFilesWithMatchesByMtime<T extends { readonly path: string }>(
  files: readonly T[],
  deps: RenderDeps,
): Promise<T[]> {
  const entries = await mapWithConcurrency(
    files,
    MTIME_STAT_CONCURRENCY,
    deps.signal,
    async (file, index) => {
      let mtime = 0;
      try {
        const path = isAbsolute(file.path) ? file.path : join(deps.workspaceDir, file.path);
        mtime = (await deps.fs.stat(path)).mtimeMs ?? 0;
      } catch {
        // Keep stat failures visible; use mtime=0 so they sort after known files.
      }
      return { file, mtime, index };
    },
  );
  entries.sort((a, b) => b.mtime - a.mtime || a.index - b.index);
  return entries.map((entry) => entry.file);
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (signal.aborted) throw new GrepAbortedError();
  if (items.length === 0) return [];

  const results: U[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (signal.aborted) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );
  if (signal.aborted) throw new GrepAbortedError();
  return results;
}

function renderFilesWithMatches(
  args: GrepInput,
  files: readonly { path: string }[],
  inlineMessages: string[],
  redactedSensitive: boolean,
): ExecutableToolResult {
  return renderPagedLines(
    args,
    files.map((file) => file.path),
    inlineMessages,
    redactedSensitive,
  );
}

function renderContent(
  args: GrepInput,
  files: readonly { path: string; matches: readonly FsGrepMatch[] }[],
  inlineMessages: string[],
  redactedSensitive: boolean,
): ExecutableToolResult {
  const includeLineNumbers = args['-n'] !== false;
  const context = displayContext(args);
  const lines: string[] = [];
  for (const file of files) {
    for (const match of file.matches) {
      lines.push(...renderMatchLines(file.path, match, includeLineNumbers, context));
    }
  }
  return renderPagedLines(args, lines, inlineMessages, redactedSensitive);
}

interface DisplayContext {
  readonly before: number;
  readonly after: number;
}

function displayContext(args: GrepInput): DisplayContext {
  if (args['-C'] !== undefined) {
    const lines = clamp(args['-C'], 0, FS_MAX_CONTEXT_LINES);
    return { before: lines, after: lines };
  }
  return {
    before: clamp(args['-B'] ?? 0, 0, FS_MAX_CONTEXT_LINES),
    after: clamp(args['-A'] ?? 0, 0, FS_MAX_CONTEXT_LINES),
  };
}

function renderMatchLines(
  path: string,
  match: FsGrepMatch,
  includeLineNumbers: boolean,
  context: DisplayContext,
): string[] {
  const lines: string[] = [];
  const before = context.before > 0 ? match.before.slice(-context.before) : [];
  const after = context.after > 0 ? match.after.slice(0, context.after) : [];
  const matchLines = splitMatchText(match.text);
  if (includeLineNumbers) {
    const beforeStart = match.line - before.length;
    for (let i = 0; i < before.length; i += 1) {
      lines.push(`${path}-${String(beforeStart + i)}-${before[i]}`);
    }
    for (let i = 0; i < matchLines.length; i += 1) {
      lines.push(`${path}:${String(match.line + i)}:${matchLines[i]}`);
    }
    for (let i = 0; i < after.length; i += 1) {
      lines.push(`${path}-${String(match.line + matchLines.length + i)}-${after[i]}`);
    }
  } else {
    for (const text of before) lines.push(`${path}:${text}`);
    for (const text of matchLines) lines.push(`${path}:${text}`);
    for (const text of after) lines.push(`${path}:${text}`);
  }
  return lines;
}

function splitMatchText(text: string): readonly string[] {
  return text.split(/\r?\n/);
}

function renderCountMatches(
  args: GrepInput,
  files: readonly { path: string; matches: readonly unknown[] }[],
  redactedSensitive: boolean,
  inlineMessages: string[],
): ExecutableToolResult {
  const counts = files.map((file) => ({ path: file.path, count: file.matches.length }));
  const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
  const rows = counts.map((entry) => `${entry.path}:${String(entry.count)}`);
  const page = paginate(rows, args);

  const headerLines: string[] = [];
  if (counts.length > 0) {
    headerLines.push(formatCountSummary(totalMatches, counts.length, redactedSensitive));
  }
  if (page.truncated) {
    headerLines.push(formatPaginationNotice(page));
  }

  return renderBoundedOutput(headerLines, page.visible.join('\n'), inlineMessages, {
    empty: emptyMessage(redactedSensitive),
    forceEmptyBody: redactedSensitive && counts.length === 0,
  });
}

function appendPaginationNotice(messages: string[], page: Page<unknown>): void {
  if (!page.truncated) return;
  messages.push(formatPaginationNotice(page));
}

function emptyMessage(redactedSensitive: boolean): string {
  return redactedSensitive ? 'No non-sensitive matches found' : 'No matches found';
}

function renderPagedLines(
  args: GrepInput,
  lines: readonly string[],
  inlineMessages: string[],
  redactedSensitive: boolean,
): ExecutableToolResult {
  const page = paginate(lines, args);
  appendPaginationNotice(inlineMessages, page);
  return renderBoundedOutput([], page.visible.join('\n'), inlineMessages, {
    empty: emptyMessage(redactedSensitive),
    forceEmptyBody: redactedSensitive && lines.length === 0,
  });
}

function renderBoundedOutput(
  headerLines: readonly string[],
  body: string,
  messages: readonly string[],
  options: { readonly empty: string; readonly forceEmptyBody?: boolean },
): ExecutableToolResult {
  const base =
    body === '' &&
    (options.forceEmptyBody === true || (headerLines.length === 0 && messages.length === 0))
      ? options.empty
      : body;
  const output = [...headerLines, base, ...messages].filter((part) => part !== '').join('\n');
  const builder = new ToolResultBuilder();
  builder.write(output);
  return builder.ok();
}

function formatPaginationNotice(page: Page<unknown>): string {
  return `Results truncated to ${String(page.visible.length)} lines (total: ${String(page.total)}). Use offset=${String(page.nextOffset)} to see more.`;
}

function formatCountSummary(
  totalMatches: number,
  totalFiles: number,
  redactedSensitive: boolean,
): string {
  const occurrenceWord = totalMatches === 1 ? 'occurrence' : 'occurrences';
  const fileWord = totalFiles === 1 ? 'file' : 'files';
  const scope = redactedSensitive ? 'total non-sensitive' : 'total';
  return `Found ${String(totalMatches)} ${scope} ${occurrenceWord} across ${String(totalFiles)} ${fileWord}.`;
}

/**
 * The read-only tools a measurement turn may use.
 *
 * The prompt under measurement tells the model it may use Read, Glob and Grep,
 * which is exactly the production prompt optimizer's tool set
 * (`PROMPT_OPTIMIZER_TOOLS`). A harness that declared none left the model with
 * a permission it could not exercise, and it answered with tool-call syntax as
 * plain text instead of a rewrite.
 *
 * The schemas below are the subset this harness implements. Production's are
 * richer, so a call naming anything outside this subset comes back as an error
 * naming the supported parameters rather than as a silent no-op.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition } from '../benchmark/runner';

export const MEASURE_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'Read',
    description:
      'Read one file with line numbers. The path is absolute, or relative to the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files under a directory whose names match a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, matched against the file name.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents for a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the working directory.' },
        glob: { type: 'string', description: 'Optional file-name glob to narrow the search.' },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count_matches'],
          description:
            'Shape of the result. Defaults to files_with_matches, which lists only the paths of files that contain a match.',
        },
        head_limit: {
          type: 'number',
          description: 'Limit output to the first N lines or entries. Defaults to 250. Pass 0 for unlimited.',
        },
      },
      required: ['pattern'],
    },
  },
];

const READ_LIMIT_CHARS = 64_000;
const GLOB_LIMIT_ENTRIES = 200;
const GREP_DEFAULT_HEAD_LIMIT = 250;
const GREP_LIMIT_FILE_BYTES = 1_000_000;

const SKIPPED_DIRECTORY = 'node_modules';

function isSkippedSegment(segment: string): boolean {
  return segment === SKIPPED_DIRECTORY || segment.startsWith('.');
}

/** Bun.Glob separates entries with the platform separator, so split on both. */
function segmentsOf(entry: string): string[] {
  return entry.split(/[\\/]/);
}

function resolveInside(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path "${target}" escapes the working directory`);
  }
  return resolved;
}

async function readTextWithLimit(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`"${filePath}" is not a file`);
  const buffer = await readFile(filePath);
  const slice = buffer.subarray(0, Math.min(buffer.byteLength, GREP_LIMIT_FILE_BYTES));
  if (slice.includes(0)) throw new Error(`"${filePath}" looks binary, not text`);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

function numberLines(text: string): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join('\n');
}

async function executeRead(input: Record<string, unknown>, cwd: string): Promise<string> {
  const target = input['path'];
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Read requires a "path" string.');
  }
  const resolved = resolveInside(cwd, target);
  const text = await readTextWithLimit(resolved);
  if (text.length > READ_LIMIT_CHARS) {
    return `${numberLines(text.slice(0, READ_LIMIT_CHARS))}\n…(truncated at ${String(READ_LIMIT_CHARS)} characters)`;
  }
  return numberLines(text);
}

async function executeGlob(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = input['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('Glob requires a "pattern" string.');
  }
  const rootValue = input['path'];
  const root = resolveInside(cwd, typeof rootValue === 'string' && rootValue.length > 0 ? rootValue : '.');

  // Production's Glob shells out to `rg --files --glob <pattern> .`, which is
  // recursive; a bare `*.ts` therefore reaches nested directories here too.
  const matches: string[] = [];
  for await (const entry of new Bun.Glob(`**/${pattern}`).scan({ cwd: root })) {
    matches.push(segmentsOf(entry).join('/'));
    if (matches.length >= GLOB_LIMIT_ENTRIES) break;
  }
  matches.sort();
  const listed = matches.slice(0, GLOB_LIMIT_ENTRIES);
  const notice =
    matches.length > listed.length ? `\n…(${String(matches.length - listed.length)} more not shown)` : '';
  return listed.length === 0 ? 'No files matched.' : `${listed.join('\n')}${notice}`;
}

async function collectFiles(root: string, glob: string | undefined): Promise<string[]> {
  const pattern = glob === undefined ? '**/*' : `${glob}`;
  const files: string[] = [];
  for await (const entry of new Bun.Glob(pattern).scan({ cwd: root })) {
    if (segmentsOf(entry).some(isSkippedSegment)) continue;
    const absolute = path.join(root, entry);
    try {
      if ((await stat(absolute)).isFile()) files.push(absolute);
    } catch {
      continue;
    }
    if (files.length >= 5000) break;
  }
  return files;
}

interface FileHits {
  readonly relativePath: string;
  readonly lines: string[];
  readonly count: number;
}

const GREP_MODES = ['files_with_matches', 'content', 'count_matches'] as const;
type GrepMode = (typeof GREP_MODES)[number];

async function executeGrep(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = input['pattern'];
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('Grep requires a "pattern" string.');
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, 'gm');
  } catch (error) {
    throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }

  const modeValue = input['output_mode'];
  const mode: GrepMode =
    typeof modeValue === 'string' && (GREP_MODES as readonly string[]).includes(modeValue)
      ? (modeValue as GrepMode)
      : 'files_with_matches';
  const headLimitValue = input['head_limit'];
  const headLimit =
    typeof headLimitValue === 'number' && Number.isInteger(headLimitValue) && headLimitValue > 0
      ? headLimitValue
      : headLimitValue === 0
        ? Number.POSITIVE_INFINITY
        : GREP_DEFAULT_HEAD_LIMIT;

  const rootValue = input['path'];
  const root = resolveInside(cwd, typeof rootValue === 'string' && rootValue.length > 0 ? rootValue : '.');
  const globValue = input['glob'];
  const glob = typeof globValue === 'string' && globValue.length > 0 ? globValue : undefined;

  let files: string[];
  try {
    const info = await stat(root);
    files = info.isFile() ? [root] : await collectFiles(root, glob);
  } catch (error) {
    throw new Error(`cannot search "${root}": ${error instanceof Error ? error.message : String(error)}`);
  }

  const hits: FileHits[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readTextWithLimit(file);
    } catch {
      continue;
    }
    const lines: string[] = [];
    for (const [lineNumber, line] of text.split('\n').entries()) {
      expression.lastIndex = 0;
      if (!expression.test(line)) continue;
      lines.push(`${String(lineNumber + 1)}:${line.trim()}`);
      if (mode === 'content' && lines.length >= headLimit) break;
    }
    if (lines.length > 0) {
      hits.push({ relativePath: segmentsOf(path.relative(cwd, file)).join('/'), lines, count: lines.length });
    }
    if (mode === 'files_with_matches' && hits.length >= headLimit) break;
  }

  if (hits.length === 0) return 'No matches.';

  if (mode === 'count_matches') {
    const total = hits.reduce((sum, hit) => sum + hit.count, 0);
    return `${String(total)} matches in ${String(hits.length)} files\n${hits
      .map((hit) => `${hit.relativePath}:${String(hit.count)}`)
      .join('\n')}`;
  }

  if (mode === 'files_with_matches') {
    return hits.map((hit) => hit.relativePath).join('\n');
  }

  const lines = hits.flatMap((hit) => hit.lines.map((line) => `${hit.relativePath}:${line}`));
  const listed = lines.slice(0, headLimit);
  const notice = lines.length > listed.length ? `\n…(${String(lines.length - listed.length)} more not shown)` : '';
  return `${listed.join('\n')}${notice}`;
}

/**
 * Run one declared tool against the working directory the draft names.
 *
 * The result is a plain string because that is what both wire formats carry
 * back; an error is reported as the tool's output rather than thrown, so the
 * model sees why the call failed and can try again.
 */
export async function executeMeasureTool(
  name: string,
  input: string,
  cwd: string,
): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `Tool input must be a JSON object, got ${Array.isArray(value) ? 'an array' : typeof value}.`;
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    return `Tool input was not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    if (name === 'Read') return await executeRead(parsed, cwd);
    if (name === 'Glob') return await executeGlob(parsed, cwd);
    if (name === 'Grep') return await executeGrep(parsed, cwd);
    return `Unknown tool "${name}". Available: Read, Glob, Grep.`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * GrepTool tests for the v2 fileTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/grep.test.ts`) and adapted
 * to the v2 constructor `(processService, fs, env, workspace)`. The search
 * execution (`executeGrepSearch` — ripgrep via `IHostProcessService` plus the
 * node fallback) is mocked out so the tool's argument mapping and result
 * rendering can be exercised without the composition root or a real ripgrep.
 * The v1 tests that asserted on the exact `rg` argv are intentionally dropped
 * here (the tool maps args onto an `FsGrepRequest`; the argv lives in the
 * mocked search module).
 */

import type { FsGrepFileHit, FsGrepRequest, FsGrepResponse } from '@moonshot-ai/protocol';
import { describe, expect, it, vi } from 'vitest';

import { stubWorkspaceContext } from './stub-workspace-context';
import {
  type GrepInput,
  GrepInputSchema,
  GrepTool,
} from '#/os/backends/node-local/tools/grep';
import { executeGrepSearch } from '#/os/backends/node-local/tools/grepSearch';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/agent/tool/toolContract';

// The search execution (ripgrep + node fallback) is mocked out so these tests
// assert on argument mapping and result rendering without probing a real `rg`
// or walking the filesystem.
vi.mock('#/os/backends/node-local/tools/grepSearch', () => ({
  executeGrepSearch: vi.fn(),
}));

const DUMMY_PROCESS_SERVICE = {
  _serviceBrand: undefined,
  spawn: vi.fn(),
} as unknown as IHostProcessService;

const signal = new AbortController().signal;
const workspace = stubWorkspaceContext('/workspace', ['/extra']);

function fileHit(path: string, lines: number[] = [1], text = 'hit'): FsGrepFileHit {
  return {
    path,
    matches: lines.map((line) => ({ line, col: 1, text, before: [], after: [] })),
  };
}

function emptyResponse(overrides: Partial<FsGrepResponse> = {}): FsGrepResponse {
  return { files: [], files_scanned: 0, truncated: false, elapsed_ms: 1, ...overrides };
}

function createFakeFs(
  response: FsGrepResponse | ((req: FsGrepRequest) => FsGrepResponse | Promise<FsGrepResponse>),
  fsOverrides: Partial<IHostFileSystem> = {},
) {
  const grep = vi.mocked(executeGrepSearch);
  grep.mockReset();
  grep.mockImplementation(async (req: FsGrepRequest) =>
    typeof response === 'function' ? response(req) : response,
  );
  const fs = { _serviceBrand: undefined, ...fsOverrides } as unknown as IHostFileSystem;
  return { fs, grep };
}

function statResult(mtimeMs: number) {
  return { isFile: true, isDirectory: false, size: 1, mtimeMs };
}

function createTestEnv(home = '/home'): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: home,
    ready: Promise.resolve(),
  };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: GrepTool, args: GrepInput): Promise<ExecutableToolResult> {
  const resolved = tool.resolveExecution(args);
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = {
    turnId: 0,
    toolCallId: 'call_grep',
    signal,
  };
  return execution.execute(ctx);
}

function toolContentString(result: ExecutableToolResult): string {
  const c = result.output;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
}

type ToolParameter = { description?: string; enum?: string[] };

function toolParameters(tool: GrepTool): Record<string, ToolParameter> {
  return (tool.parameters as { properties: Record<string, ToolParameter> }).properties;
}

describe('GrepTool', () => {
  it('exposes current metadata and schema', () => {
    const { fs } = createFakeFs(emptyResponse());
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    expect(tool.name).toBe('Grep');
    expect(tool.description).toContain('unknown content or unknown file locations');
    expect(tool.description).toContain('Do not use shell `grep` or `rg` directly');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: expect.stringContaining('Regular expression'),
        },
        path: {
          description: expect.stringContaining('Use Read instead'),
        },
      },
    });
    expect(GrepInputSchema.safeParse({ pattern: 'needle' }).success).toBe(true);
    expect(GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'content' }).success).toBe(
      true,
    );
    expect(GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'bad' }).success).toBe(
      false,
    );
    expect(
      GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'count_matches' }).success,
    ).toBe(true);
  });

  it('exposes count_matches and rejects the legacy count output mode', () => {
    const { fs } = createFakeFs(emptyResponse());
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);
    const params = toolParameters(tool);

    expect(
      GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'count_matches' }).success,
    ).toBe(true);
    expect(GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'count' }).success).toBe(
      false,
    );
    expect(params['output_mode']?.enum).toContain('count_matches');
    expect(params['output_mode']?.enum).not.toContain('count');
  });

  it('keeps v1-compatible parameter descriptions for documented grep flags', () => {
    const { fs } = createFakeFs(emptyResponse());
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);
    const params = toolParameters(tool);
    const documented = [
      'output_mode',
      '-i',
      '-n',
      '-A',
      '-B',
      '-C',
      'offset',
      'multiline',
      'include_ignored',
    ];

    for (const name of documented) {
      const description = params[name]?.description;
      expect(description, `${name} should have a description`).toBeTruthy();
      expect(
        (description ?? '').trim().length,
        `${name} description should be non-empty`,
      ).toBeGreaterThan(0);
    }
    for (const name of ['-A', '-B', '-C', '-n']) {
      expect(params[name]?.description).toContain('content');
    }
    expect(params['output_mode']?.description).toContain('count_matches');
    expect(params['output_mode']?.description).toContain('per-file');
    expect(params['output_mode']?.description).toContain('most-recently-modified');
    expect(params['path']?.description ?? '').not.toMatch(/^Absolute path/);
    expect((params['path']?.description ?? '').toLowerCase()).toContain('relative');
    expect(params['type']?.description).toContain('glob');
    expect(params['type']?.description).toContain('efficient');
    expect(params['include_ignored']?.description).toContain('.gitignore');
    expect(params['include_ignored']?.description).toContain('.ignore');
    expect(params['include_ignored']?.description).toContain('.rgignore');
  });

  it('keeps prompt guidance for ripgrep syntax, hidden files, and sensitive files', () => {
    const { fs } = createFakeFs(emptyResponse());
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    expect(tool.description).toContain('ripgrep');
    expect(tool.description).toContain('\\{');
    expect(tool.description).toContain('include_ignored');
    expect(tool.description.toLowerCase()).toContain('hidden file');
    expect(tool.description).toContain('.env');
  });

  it('returns matching files in the default files_with_matches mode', async () => {
    const { fs, grep } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts'), fileHit('src/b.ts')] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });

    expect(toolContentString(result)).toBe('src/a.ts\nsrc/b.ts');
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('sorts files_with_matches by mtime before pagination after sensitive filtering', async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === '/workspace/src/new.ts') return statResult(10);
      if (path === '/workspace/src/old.ts') return statResult(1);
      throw new Error(`unexpected stat: ${path}`);
    });
    const { fs } = createFakeFs(
      emptyResponse({
        files: [fileHit('src/old.ts'), fileHit('.env'), fileHit('src/new.ts')],
      }),
      { stat },
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', head_limit: 1 });

    expect(toolContentString(result)).toBe(
      [
        'src/new.ts',
        'Filtered 1 sensitive file(s): .env',
        'Results truncated to 1 lines (total: 2). Use offset=1 to see more.',
      ].join('\n'),
    );
    expect(stat).toHaveBeenCalledTimes(2);
    expect(stat).toHaveBeenCalledWith('/workspace/src/old.ts');
    expect(stat).toHaveBeenCalledWith('/workspace/src/new.ts');
  });

  it('limits concurrent mtime stats while sorting files_with_matches', async () => {
    const files = Array.from({ length: 40 }, (_, index) =>
      fileHit(`src/file-${String(index).padStart(2, '0')}.ts`),
    );
    let activeStats = 0;
    let maxActiveStats = 0;
    const stat = vi.fn(async (path: string) => {
      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      activeStats -= 1;
      const mtime = Number(path.match(/file-(\d+)\.ts$/)?.[1] ?? 0);
      return statResult(mtime);
    });
    const { fs } = createFakeFs(emptyResponse({ files }), { stat });
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', head_limit: 0 });
    const lines = toolContentString(result).split('\n');

    expect(stat).toHaveBeenCalledTimes(files.length);
    expect(maxActiveStats).toBeLessThanOrEqual(32);
    expect(lines.at(0)).toBe('src/file-39.ts');
    expect(lines.at(-1)).toBe('src/file-00.ts');
  });

  it('stops scheduling mtime stats when aborted during files_with_matches sorting', async () => {
    const files = Array.from({ length: 40 }, (_, index) =>
      fileHit(`src/file-${String(index).padStart(2, '0')}.ts`),
    );
    const controller = new AbortController();
    const stat = vi.fn(async () => {
      controller.abort();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      return statResult(1);
    });
    const { fs } = createFakeFs(emptyResponse({ files }), { stat });
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const resolved = tool.resolveExecution({ pattern: 'hit', head_limit: 0 });
    const execution = isPromiseLike(resolved) ? await resolved : resolved;
    if (execution.isError === true) throw new TypeError('expected runnable execution');
    const result = await execution.execute({
      turnId: 0,
      toolCallId: 'call_grep',
      signal: controller.signal,
    });

    expect(result).toEqual({ isError: true, output: 'Grep aborted' });
    expect(stat.mock.calls.length).toBeLessThan(files.length);
  });

  it('keeps files_with_matches entries when mtime stat fails', async () => {
    const stat = vi.fn(async (path: string) => {
      if (path === '/workspace/src/new.ts') return statResult(10);
      if (path === '/workspace/src/old.ts') return statResult(1);
      throw new Error('stat failed');
    });
    const { fs } = createFakeFs(
      emptyResponse({
        files: [fileHit('src/old.ts'), fileHit('src/missing.ts'), fileHit('src/new.ts')],
      }),
      { stat },
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', head_limit: 0 });

    expect(toolContentString(result)).toBe(
      ['src/new.ts', 'src/old.ts', 'src/missing.ts'].join('\n'),
    );
  });

  it('renders content matches as path:line:text', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts', [10, 20])] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'content' });

    expect(toolContentString(result)).toBe('src/a.ts:10:hit\nsrc/a.ts:20:hit');
  });

  it('renders multiline content matches with per-line prefixes', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'multiline.py',
            matches: [
              {
                line: 2,
                col: 8,
                text: "    '''This is a\n    multiline docstring'''",
                before: [],
                after: [],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: String.raw`This is a\n    multiline`,
      output_mode: 'content',
      multiline: true,
    });

    expect(toolContentString(result)).toBe(
      "multiline.py:2:    '''This is a\nmultiline.py:3:    multiline docstring'''",
    );
  });

  it('matches a pattern spanning a newline in the node fallback when multiline is set', async () => {
    const actual = await vi.importActual<typeof import('#/os/backends/node-local/tools/grepSearch')>(
      '#/os/backends/node-local/tools/grepSearch',
    );
    const processService = {
      _serviceBrand: undefined,
      spawn: vi.fn(async () => {
        throw new Error('rg unavailable');
      }),
    } as unknown as IHostProcessService;
    const fs = {
      _serviceBrand: undefined,
      readdir: vi.fn(async () => [{ name: 'multiline.py', isFile: true, isDirectory: false }]),
      readText: vi.fn(async () => "def f():\n    '''This is a\n    multiline docstring'''\n"),
    } as unknown as IHostFileSystem;

    const result = await actual.executeGrepSearch(
      {
        pattern: String.raw`This is a\n    multiline`,
        regex: true,
        case_sensitive: true,
        follow_gitignore: false,
        max_files: 200,
        max_matches_per_file: 50,
        max_total_matches: 5_000,
        context_lines: 0,
        multiline: true,
      } as FsGrepRequest,
      { processService, fs, cwd: '/workspace' },
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches).toEqual([
      {
        line: 2,
        col: 8,
        text: "    '''This is a\n    multiline docstring'''",
        before: [],
        after: [],
      },
    ]);
  });

  it('drops the line-number column when "-n" is explicitly false', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'src/a.ts',
            matches: [
              {
                line: 2,
                col: 1,
                text: 'match',
                before: ['pre'],
                after: ['post'],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'match',
      output_mode: 'content',
      '-n': false,
      '-C': 1,
    });

    expect(toolContentString(result)).toBe('src/a.ts:pre\nsrc/a.ts:match\nsrc/a.ts:post');
  });

  it('caps long rendered content lines with the v1 tool-result limit', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts', [1], 'x'.repeat(3_000))] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'x', output_mode: 'content' });
    const output = toolContentString(result);
    const [firstLine] = output.split('\n');

    expect(firstLine).toHaveLength(2_000);
    expect(firstLine).toContain('[...truncated]');
    expect(output).toContain('Output is truncated to fit in the message.');
    expect(result.truncated).toBe(true);
  });

  it('caps total rendered content with the v1 tool-result limit', async () => {
    const files = Array.from({ length: 3_000 }, (_, i) =>
      fileHit(`src/very-long-file-name-${String(i).padStart(4, '0')}.ts`),
    );
    const { fs } = createFakeFs(emptyResponse({ files }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'hit',
      output_mode: 'content',
      head_limit: 0,
    });
    const output = toolContentString(result);

    expect(output).toContain('src/very-long-file-name-0000.ts:1:hit');
    expect(output).toContain('[...truncated]');
    expect(output).toContain('Output is truncated to fit in the message.');
    expect(result.truncated).toBe(true);
  });

  it('treats the pattern as a regex when calling the fs layer', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'foo|bar' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.pattern).toBe('foo|bar');
    expect(req.regex).toBe(true);
  });

  it('maps -i to a case-insensitive request', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'Hit', '-i': true });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.case_sensitive).toBe(false);
  });

  it('is case-sensitive by default', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'Hit' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.case_sensitive).toBe(true);
  });

  it('maps glob to include_globs and leaves exclude_globs empty', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', glob: '*.ts' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.include_globs).toEqual(['*.ts']);
    expect(req.exclude_globs).toBeUndefined();
  });

  it('passes an exclude-style glob through include_globs verbatim', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', glob: '!**/*.test.ts' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.include_globs).toEqual(['!**/*.test.ts']);
  });

  it('maps type to a recursive include glob', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', type: 'ts' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.include_globs).toEqual(['**/*.ts']);
  });

  it('maps include_ignored to follow_gitignore=false', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', include_ignored: true });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.follow_gitignore).toBe(false);
  });

  it('maps multiline to the internal fs request', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'first\\nsecond', output_mode: 'content', multiline: true });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest & { multiline?: boolean };
    expect(req.multiline).toBe(true);
  });

  it('maps -A and -B to the fs context request when -C is omitted', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', output_mode: 'content', '-A': 3, '-B': 2 });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.context_lines).toBe(3);
  });

  it('gives -C precedence over -A and -B in the fs context request', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', output_mode: 'content', '-A': 3, '-B': 2, '-C': 1 });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.context_lines).toBe(1);
  });

  it('surfaces fs-layer truncation as a warning', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts')], truncated: true }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });
    const output = toolContentString(result);

    expect(output).toContain('src/a.ts');
    expect(output).toContain('stopped early');
    expect(output).toContain('incomplete');
  });

  it('returns a clean no-match result', async () => {
    const { fs, grep } = createFakeFs(emptyResponse());
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'missing' });

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result)).toBe('No matches found');
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('applies offset and head_limit pagination in files_with_matches mode', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [fileHit('a.ts'), fileHit('b.ts'), fileHit('c.ts'), fileHit('d.ts')],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', offset: 1, head_limit: 2 });
    const output = toolContentString(result);

    expect(output).toContain('b.ts');
    expect(output).toContain('c.ts');
    expect(output).not.toContain('a.ts');
    expect(output).not.toContain('d.ts');
    expect(output).toContain('Results truncated to 2 lines (total: 4). Use offset=3 to see more.');
  });

  it('returns a clean no-match result when offset exceeds total entries', async () => {
    const { fs } = createFakeFs(emptyResponse({ files: [fileHit('only.txt')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'hit',
      output_mode: 'files_with_matches',
      offset: 100,
    });

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result)).toBe('No matches found');
  });

  it('treats head_limit zero as unlimited', async () => {
    const files = Array.from({ length: 260 }, (_, i) => fileHit(`src/${String(i)}.ts`));
    const { fs } = createFakeFs(emptyResponse({ files }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', head_limit: 0 });
    const output = toolContentString(result);

    expect(output.split('\n')).toHaveLength(260);
    expect(output).not.toContain('Results truncated');
  });

  it('limits files_with_matches output to 250 lines by default', async () => {
    const files = Array.from({ length: 251 }, (_, i) => fileHit(`src/${String(i)}.ts`));
    const { fs } = createFakeFs(emptyResponse({ files }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });
    const output = toolContentString(result);

    expect(output).toContain('src/0.ts');
    expect(output).toContain('src/249.ts');
    expect(output).not.toContain('src/250.ts');
    expect(output).toContain(
      'Results truncated to 250 lines (total: 251). Use offset=250 to see more.',
    );
  });

  it('summarizes count_matches in the model-visible output', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts', [1, 2, 3]), fileHit('src/b.ts', [1, 2])] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'count_matches' });

    expect(toolContentString(result)).toBe(
      'Found 5 total occurrences across 2 files.\nsrc/a.ts:3\nsrc/b.ts:2',
    );
  });

  it('renders count_matches pagination in the model-visible output header', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('a.ts', [1]), fileHit('b.ts', [1]), fileHit('c.ts', [1])] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'hit',
      output_mode: 'count_matches',
      head_limit: 2,
    });
    const output = toolContentString(result);

    expect(output).toBe(
      [
        'Found 3 total occurrences across 3 files.',
        'Results truncated to 2 lines (total: 3). Use offset=2 to see more.',
        'a.ts:1',
        'b.ts:1',
      ].join('\n'),
    );
  });

  it('summarizes count_matches before pagination and after sensitive filtering', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          fileHit('src/a.ts', [1, 2, 3]),
          fileHit('.env', [1, 2, 3, 4, 5, 6, 7]),
          fileHit('src/b.ts', [1, 2]),
          fileHit('src/c.ts', [1]),
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'hit',
      output_mode: 'count_matches',
      head_limit: 2,
    });

    expect(toolContentString(result)).toBe(
      [
        'Found 6 total non-sensitive occurrences across 3 files.',
        'Results truncated to 2 lines (total: 3). Use offset=2 to see more.',
        'src/a.ts:3',
        'src/b.ts:2',
        'Filtered 1 sensitive file(s): .env',
      ].join('\n'),
    );
  });

  it('does not add a zero count summary when every count result is sensitive', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('.env', [1, 2, 3]), fileHit('.aws/credentials', [1, 2])] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'count_matches' });

    expect(toolContentString(result)).toBe(
      [
        'No non-sensitive matches found',
        'Filtered 2 sensitive file(s): .env, .aws/credentials',
      ].join('\n'),
    );
  });

  it('keeps count_matches summary before total-output truncation', async () => {
    const files = Array.from({ length: 3_000 }, (_, i) =>
      fileHit(`src/very-long-file-name-${String(i).padStart(4, '0')}.ts`),
    );
    const { fs } = createFakeFs(emptyResponse({ files }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'hit',
      output_mode: 'count_matches',
      head_limit: 0,
    });
    const output = toolContentString(result);
    const summary = 'Found 3000 total occurrences across 3000 files.';

    expect(output.startsWith(summary)).toBe(true);
    expect(output).toContain('[...truncated]');
    expect(output.indexOf(summary)).toBeLessThan(output.indexOf('[...truncated]'));
    expect(output).toContain('Output is truncated to fit in the message.');
    expect(result.truncated).toBe(true);
  });

  it('filters sensitive files and appends a warning', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/main.ts'), fileHit('.env')] }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });
    const output = toolContentString(result);

    expect(output).toContain('src/main.ts');
    expect(output).not.toContain('.env:');
    expect(output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('does not flag .env.example as sensitive', async () => {
    const { fs } = createFakeFs(emptyResponse({ files: [fileHit('.env.example')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'API_KEY', output_mode: 'files_with_matches' });
    const output = toolContentString(result);

    expect(output).toContain('.env.example');
    expect(output).not.toContain('Filtered');
  });

  it('reports no non-sensitive matches when every result is sensitive', async () => {
    const { fs } = createFakeFs(emptyResponse({ files: [fileHit('.env')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'content' });
    const output = toolContentString(result);

    expect(output).toContain('No non-sensitive matches found');
    expect(output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('renders context lines with computed line numbers in content mode', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'src/a.ts',
            matches: [
              {
                line: 5,
                col: 1,
                text: 'match',
                before: ['pre'],
                after: ['post'],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'match', output_mode: 'content', '-C': 1 });

    expect(toolContentString(result)).toBe('src/a.ts-4-pre\nsrc/a.ts:5:match\nsrc/a.ts-6-post');
  });

  it('includes only lines before the match for -B without -C', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'src/a.ts',
            matches: [
              {
                line: 3,
                col: 1,
                text: 'match',
                before: ['pre1', 'pre2'],
                after: ['post1', 'post2'],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'match', output_mode: 'content', '-B': 2 });

    expect(toolContentString(result)).toBe('src/a.ts-1-pre1\nsrc/a.ts-2-pre2\nsrc/a.ts:3:match');
  });

  it('includes only lines after the match for -A without -C', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'src/a.ts',
            matches: [
              {
                line: 3,
                col: 1,
                text: 'match',
                before: ['pre1', 'pre2'],
                after: ['post1', 'post2'],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'match', output_mode: 'content', '-A': 2 });

    expect(toolContentString(result)).toBe('src/a.ts:3:match\nsrc/a.ts-4-post1\nsrc/a.ts-5-post2');
  });

  it('gives -C precedence over before and after context in rendered content', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'src/a.ts',
            matches: [
              {
                line: 3,
                col: 1,
                text: 'match',
                before: ['pre1', 'pre2'],
                after: ['post1', 'post2'],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'match',
      output_mode: 'content',
      '-A': 2,
      '-B': 2,
      '-C': 1,
    });

    expect(toolContentString(result)).toBe('src/a.ts-2-pre2\nsrc/a.ts:3:match\nsrc/a.ts-4-post1');
  });

  it('aborts before searching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const resolved = tool.resolveExecution({ pattern: 'hit' });
    const execution = isPromiseLike(resolved) ? await resolved : resolved;
    if (execution.isError === true) throw new TypeError('expected runnable execution');
    const result = await execution.execute({
      turnId: 0,
      toolCallId: 'call_grep',
      signal: controller.signal,
    });

    expect(result).toEqual({ isError: true, output: 'Aborted before search started' });
    expect(grep).not.toHaveBeenCalled();
  });

  it('maps an fs timeout error to a friendly message', async () => {
    const { KimiError, ErrorCodes } = await import('../../src/errors');
    const { fs } = createFakeFs(() => {
      throw new KimiError(ErrorCodes.FS_GREP_TIMEOUT, 'grep timed out after 30000ms');
    });
    const tool = new GrepTool(DUMMY_PROCESS_SERVICE, fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'slow' });

    expect(result).toEqual({
      isError: true,
      output: 'Grep timed out. Try a more specific path or pattern.',
    });
  });
});

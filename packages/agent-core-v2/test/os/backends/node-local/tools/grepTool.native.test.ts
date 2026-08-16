import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tryNativeGrep, type NativeGrepResult } from '#/_base/native-tools';
import { type GrepInput } from '#/agent/tools/os/grep/grep';
import { GrepTool } from '#/agent/tools/os/grep/grepTool';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';

vi.mock('#/_base/native-tools', async () => {
  const actual = await vi.importActual<typeof import('#/_base/native-tools')>(
    '#/_base/native-tools',
  );
  return { ...actual, tryNativeGrep: vi.fn() };
});

const mockedTryNativeGrep = vi.mocked(tryNativeGrep);
const signal = new AbortController().signal;

function nativeResult(overrides: Partial<NativeGrepResult> = {}): NativeGrepResult {
  return {
    content: '',
    error: undefined,
    matchCount: 0,
    fileCount: 0,
    filteredSensitive: [],
    timedOut: false,
    ...overrides,
  };
}

function createTool() {
  const processService = { spawn: vi.fn() } as unknown as IHostProcessService;
  const fs = { stat: vi.fn() } as unknown as IHostFileSystem;
  const env = { pathClass: 'posix' } as unknown as IHostEnvironment;
  const tool = new GrepTool(
    processService,
    fs,
    env,
    stubWorkspaceContext('/workspace', ['/extra']),
    noopTelemetryService,
  );
  return { tool, processService };
}

async function run(tool: GrepTool, args: GrepInput) {
  const execution = tool.resolveExecution(args);
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_grep',
    signal,
  } as unknown as Parameters<typeof execution.execute>[0]);
}

describe('GrepTool native path', () => {
  beforeEach(() => {
    mockedTryNativeGrep.mockReset();
  });

  it('renders content-mode results with workspace-relative paths and line numbers', async () => {
    const { tool, processService } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({
        content:
          '/workspace/src/a.ts:10:const answer = 42\n--\n/workspace/src/b.ts:3:hello world',
        matchCount: 2,
        fileCount: 2,
      }),
    );

    const result = await run(tool, { pattern: 'hello|answer', output_mode: 'content' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('src/a.ts:10:const answer = 42\n--\nsrc/b.ts:3:hello world');
    expect(processService.spawn).not.toHaveBeenCalled();
  });

  it('renders files_with_matches results relative to the workspace', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({ content: '/workspace/src/a.ts\n/workspace/src/b.ts', fileCount: 2 }),
    );

    const result = await run(tool, { pattern: 'hello' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('src/a.ts\nsrc/b.ts');
  });

  it('renders count_matches results with the aggregate summary', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({
        content: '/workspace/src/a.ts:3\n/workspace/src/b.ts:1',
        matchCount: 4,
        fileCount: 2,
      }),
    );

    const result = await run(tool, { pattern: 'hello', output_mode: 'count_matches' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('Found 4 total occurrences across 2 files.\nsrc/a.ts:3\nsrc/b.ts:1');
  });

  it('reports natively filtered sensitive files in the output', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({
        content: '/workspace/src/a.ts:1:hello',
        filteredSensitive: ['/workspace/.env'],
      }),
    );

    const result = await run(tool, { pattern: 'hello', output_mode: 'content' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('shows the no-non-sensitive placeholder when only sensitive files matched', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({ content: '', filteredSensitive: ['/workspace/.env'] }),
    );

    const result = await run(tool, { pattern: 'SECRET' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe(
      'No non-sensitive matches found\nFiltered 1 sensitive file(s): .env',
    );
  });

  it('appends the partial-result notice when the native search timed out with results', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({ content: '/workspace/src/a.ts:1:hello', timedOut: true }),
    );

    const result = await run(tool, { pattern: 'hello', output_mode: 'content' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('src/a.ts:1:hello');
    expect(result.output).toContain('partial results returned');
  });

  it('fails with a timeout error when the native search timed out with no results', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(nativeResult({ content: '', timedOut: true }));

    const result = await run(tool, { pattern: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Grep timed out after');
  });

  it('returns the native error verdict and never falls back to ripgrep', async () => {
    const { tool, processService } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({ error: 'Invalid regex pattern: unclosed group' }),
    );

    const result = await run(tool, { pattern: '(' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('Invalid regex pattern: unclosed group');
    expect(processService.spawn).not.toHaveBeenCalled();
  });

  it('applies head_limit pagination on top of native results', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(
      nativeResult({
        content: ['/workspace/a.ts', '/workspace/b.ts', '/workspace/c.ts'].join('\n'),
        fileCount: 3,
      }),
    );

    const result = await run(tool, { pattern: 'hello', head_limit: 2 });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('a.ts\nb.ts\nResults truncated to 2 lines (total: 3). Use offset=2 to see more.');
  });

  it('passes the resolved absolute search path and options to the native engine', async () => {
    const { tool } = createTool();
    mockedTryNativeGrep.mockResolvedValue(nativeResult({}));

    await run(tool, {
      pattern: 'foo',
      path: '/workspace/src',
      glob: '*.ts',
      type: 'ts',
      output_mode: 'content',
      '-i': true,
      '-n': false,
      '-C': 2,
      include_ignored: true,
    });

    expect(mockedTryNativeGrep).toHaveBeenCalledWith(
      'foo',
      '/workspace/src',
      expect.objectContaining({
        glob: '*.ts',
        fileType: 'ts',
        outputMode: 'content',
        caseInsensitive: true,
        lineNumbers: false,
        context: 2,
        includeIgnored: true,
      }),
    );
  });

  it('skips the native engine for multiline searches', async () => {
    const { tool, processService } = createTool();
    mockedTryNativeGrep.mockResolvedValue(nativeResult({}));

    const result = await run(tool, { pattern: 'foo', multiline: true });

    expect(mockedTryNativeGrep).not.toHaveBeenCalled();
    expect(processService.spawn).toHaveBeenCalled();
    expect(result.isError).toBe(true); // mock rg is absent — the ripgrep path reports failure
  });
});

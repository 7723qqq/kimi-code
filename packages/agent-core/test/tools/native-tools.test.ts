import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isNativeToolsEnabled,
  NativeBashTool,
  NativeEditTool,
  NativeGlobTool,
  NativeGrepTool,
  NativeReadTool,
  NativeWriteTool,
  tryLoadNative,
} from '../../src/tools/builtin/native-tools';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

describe('native-tools flag gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled by default', () => {
    expect(isNativeToolsEnabled()).toBe(false);
    expect(tryLoadNative()).toBeUndefined();
  });

  it('turns on via KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', '1');
    expect(isNativeToolsEnabled()).toBe(true);
  });

  it('remains off for lenient falsy values', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', '0');
    expect(isNativeToolsEnabled()).toBe(false);
  });
});

describe('native-tools integration', () => {
  let tmpDir: string;
  let workspace: { workspaceDir: string; additionalDirs: string[] };

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS', '1');
    tmpDir = mkdtempSync(join(tmpdir(), 'native-tools-test-'));
    workspace = { workspaceDir: tmpDir, additionalDirs: [] };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeKaos() {
    return createFakeKaos({
      normpath: (p: string) => p,
      getcwd: () => tmpDir,
    });
  }

  it('reads a file through the native module', async () => {
    writeFileSync(join(tmpDir, 'foo.txt'), 'hello\nworld');

    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read',
      args: { path: join(tmpDir, 'foo.txt') },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('hello');
    expect(result.output).toContain('world');
  });

  it('writes a file through the native module', async () => {
    const tool = new NativeWriteTool(makeKaos(), workspace, 'Write a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_write',
      args: { path: join(tmpDir, 'out.txt'), content: 'hello world' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Wrote');
    expect(result.output).toContain('out.txt');
  });

  it('edits a file through the native module', async () => {
    writeFileSync(join(tmpDir, 'edit.txt'), 'foo bar foo');

    const tool = new NativeEditTool(makeKaos(), workspace, 'Edit a file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_edit',
      args: {
        path: join(tmpDir, 'edit.txt'),
        old_string: 'foo',
        new_string: 'baz',
        replace_all: true,
      },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('Replaced 2 occurrences');
  });

  it('greps a file through the native module', async () => {
    writeFileSync(join(tmpDir, 'grep.txt'), 'first line\nneedle line\nlast line');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep',
      args: { pattern: 'needle', path: join(tmpDir, 'grep.txt'), output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('needle');
  });

  it('globs files through the native module', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), '');
    writeFileSync(join(tmpDir, 'b.ts'), '');

    const tool = new NativeGlobTool(makeKaos(), workspace, 'Find files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_glob',
      args: { pattern: join(tmpDir, '*.ts') },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('b.ts');
  });

  it('runs a bash command through the native module', async () => {
    const tool = new NativeBashTool(tmpDir, 'Run a command.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_bash',
      args: { command: 'echo hello' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('hello');
  });

  it('reports a missing read target as an error', async () => {
    const tool = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_read',
      args: { path: join(tmpDir, 'missing.txt') },
      signal,
    });

    expect(result.isError).toBe(true);
  });

  it('grep redacts sensitive files instead of returning their contents', async () => {
    writeFileSync(join(tmpDir, '.env'), 'SECRET_TOKEN=abcdef123\nDATABASE_URL=postgres://x');
    writeFileSync(join(tmpDir, 'safe.txt'), 'SECRET_TOKEN=public-marker');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep',
      args: { pattern: 'SECRET_TOKEN', path: tmpDir, output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    // The secret content from .env must not leak into the result.
    expect(result.output).not.toContain('abcdef123');
    // A redaction notice should call out the filtered file by name.
    expect(result.output).toContain('Filtered');
    expect(result.output).toContain('.env');
    // The non-sensitive match should still come through.
    expect(result.output).toContain('public-marker');
  });

  it('grep filters by file type', async () => {
    writeFileSync(join(tmpDir, 'match.ts'), 'needle in ts');
    writeFileSync(join(tmpDir, 'match.py'), 'needle in py');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_type',
      args: { pattern: 'needle', path: tmpDir, type: 'ts', output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('needle in ts');
    expect(result.output).not.toContain('needle in py');
  });

  it('grep skips VCS metadata directories', async () => {
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
    writeFileSync(join(tmpDir, '.git', 'HEAD'), 'needle inside git');
    writeFileSync(join(tmpDir, 'tracked.txt'), 'needle outside git');

    const tool = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'call_grep_vcs',
      args: { pattern: 'needle', path: tmpDir, output_mode: 'content' },
      signal,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('outside git');
    expect(result.output).not.toContain('inside git');
  });

  it('native tools advertise a non-trivial approvalRule', () => {
    // Regression: the previous version hard-coded `auto-approve` on every
    // native tool, silently bypassing the permission system whenever the
    // experimental flag was on.
    const read = new NativeReadTool(makeKaos(), workspace, 'Read a text file.');
    const readExec = read.resolveExecution({ path: join(tmpDir, 'x.txt') });
    expect(readExec.approvalRule).not.toBe('auto-approve');

    const bash = new NativeBashTool(tmpDir, 'Run a command.');
    const bashExec = bash.resolveExecution({ command: 'echo hi' });
    expect(bashExec.approvalRule).not.toBe('auto-approve');

    const grep = new NativeGrepTool(makeKaos(), workspace, 'Search files.');
    const grepExec = grep.resolveExecution({ pattern: 'x' });
    expect(grepExec.approvalRule).not.toBe('auto-approve');
  });
});

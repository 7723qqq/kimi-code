/**
 * `promptYesNo` and the EOF handling of `kimi export`/`kimi fork`.
 *
 * Regression pin for the hang where a bare `rl.question()` never settles when
 * stdin reaches EOF (cron/CI, `< /dev/null`, `ssh host kimi export`).
 */

import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'bun:test';

import { handleExport, type ExportDeps } from '#/cli/sub/export';
import { promptYesNo } from '#/cli/sub/confirm';

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

describe('promptYesNo', () => {
  it('resolves "eof" instead of hanging when stdin is already closed', async () => {
    const answer = await Promise.race([
      promptYesNo('continue? ', { input: Readable.from([]), output: sink() }),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, 1000);
      }),
    ]);

    expect(answer).toBe('eof');
  });

  it('resolves "yes" for y and for an empty answer', async () => {
    await expect(
      promptYesNo('continue? ', { input: Readable.from(['y\n']), output: sink() }),
    ).resolves.toBe('yes');
    await expect(
      promptYesNo('continue? ', { input: Readable.from(['\n']), output: sink() }),
    ).resolves.toBe('yes');
  });

  it('resolves "no" for any other answer', async () => {
    await expect(
      promptYesNo('continue? ', { input: Readable.from(['n\n']), output: sink() }),
    ).resolves.toBe('no');
  });
});

describe('kimi export stdin EOF', () => {
  it('exits 1 without exporting when the confirmation prompt hits EOF', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const exitCodes: number[] = [];
    let exportCalled = false;
    const deps: ExportDeps = {
      listSessions: async () => [
        {
          id: 'ses_eof',
          workDir: '/tmp',
          sessionDir: '/tmp/sessions/ses_eof',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      exportSession: async () => {
        exportCalled = true;
        throw new Error('exportSession must not be called after EOF');
      },
      confirmPreviousSession: async () =>
        promptYesNo('continue? ', { input: Readable.from([]), output: sink() }),
      getInstallSource: async () => 'npm-global',
      getShellEnv: () => ({}),
      version: '1.0.0-test',
      cwd: () => '/tmp',
      stdout: {
        write: (chunk: string) => {
          stdout.push(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
          return true;
        },
      },
      exit: ((code: number) => {
        exitCodes.push(code);
        throw new ExitCalled(code);
      }) as ExportDeps['exit'],
    };

    await expect(
      handleExport(deps, undefined, undefined, { yes: false, includeGlobalLog: true }),
    ).rejects.toBeInstanceOf(ExitCalled);

    expect(exitCodes).toEqual([1]);
    expect(exportCalled).toBe(false);
    expect(stdout.join('')).not.toContain('cancelled');
    expect(stderr.join('')).toContain('stdin closed');
  });
});

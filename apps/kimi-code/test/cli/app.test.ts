import { resolve } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, mock } from 'bun:test';

import { registerAppCommand } from '#/cli/sub/app';

type Write = Pick<NodeJS.WriteStream, 'write'>;

describe('kimi app', () => {
  it.each([undefined, '.', '../project', '/tmp/项目 & a#b%'])(
    'opens a new desktop chat for %s',
    async (path) => {
      const openUrl = mock();
      const program = new Command('kimi');
      registerAppCommand(program, { openUrl });

      await program.parseAsync(['node', 'kimi', 'app', ...(path === undefined ? [] : [path])]);

      const url = new URL(openUrl.mock.calls[0]![0]);
      expect(url.protocol).toBe('kimi-code:');
      expect(url.host).toBe('open');
      expect(url.searchParams.get('root')).toBe(resolve(path ?? process.cwd()));
      expect(url.searchParams.get('new')).toBe('1');
      expect(url.hash).toBe('');
    },
  );

  it('shows the installation command when the OS opener fails', async () => {
    const stderr = mock(() => true);
    const exitCodes: number[] = [];
    const openUrl = mock((_url: string, onError?: (error: Error) => void) => {
      onError?.(new Error('no handler'));
    });
    const program = new Command('kimi');
    registerAppCommand(program, {
      openUrl,
      stderr: { write: stderr } as unknown as Write,
      setExitCode: (code) => {
        exitCodes.push(code);
      },
    });

    await program.parseAsync(['node', 'kimi', 'app']);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('kimi install-desktop'));
    expect(exitCodes).toEqual([1]);
  });
});

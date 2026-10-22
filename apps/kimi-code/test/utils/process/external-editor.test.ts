import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';
import { setEnv, restoreEnvs } from '#test/helpers/stubs';

const { writeFile } = fsPromises;

// Spy on the real namespace instead of replacing it: `rm` still has to delete the
// temp directory, the test only needs to observe that cleanup happened.
const rmSpy = spyOn(fsPromises, 'rm');

afterEach(() => {
  restoreEnvs();
  rmSpy.mockClear();
});

describe('external-editor helpers', () => {
  it('prefers configured editor, then VISUAL, then EDITOR', () => {
    setEnv('VISUAL', 'nvim');
    setEnv('EDITOR', 'vim');

    expect(resolveEditorCommand('code --wait')).toBe('code --wait');
    expect(resolveEditorCommand(null)).toBe('nvim');
    setEnv('VISUAL', '');
    expect(resolveEditorCommand()).toBe('vim');
  });

  it('returns the edited contents on success and cleans up the temp directory', async () => {
    const spawnEditor = mock((cmd: string, _opts: Record<string, unknown>) => {
      const child = new EventEmitter();
      // Extract the file path from the shell command (last argument after quoting).
      const match = cmd.match(/'([^']+prompt\.md)'/) || cmd.match(/"([^"]+prompt\.md)"/);
      const tmpFile = match![1]!;
      void writeFile(tmpFile, 'edited text', 'utf8').then(() => {
        child.emit('exit', 0);
      });
      return child;
    });

    await expect(
      editInExternalEditor('seed', 'code --wait', {
        spawn: spawnEditor as unknown as typeof spawn,
      }),
    ).resolves.toBe('edited text');
    expect(spawnEditor).toHaveBeenCalledWith(expect.stringContaining('code --wait'), {
      stdio: 'inherit',
      shell: true,
    });
    expect(rmSpy).toHaveBeenCalled();
  });

  it('returns undefined when the editor exits non-zero', async () => {
    const spawnEditor: Mock<(cmd: string, opts: Record<string, unknown>) => EventEmitter> = mock(
      () => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 1));
        return child;
      },
    );

    await expect(
      editInExternalEditor('seed', 'false', { spawn: spawnEditor as unknown as typeof spawn }),
    ).resolves.toBeUndefined();
  });

  it('rejects when the editor cannot be spawned', async () => {
    const spawnEditor = mock(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('no such editor')));
      return child;
    });

    await expect(
      editInExternalEditor('seed', 'nope', { spawn: spawnEditor as unknown as typeof spawn }),
    ).rejects.toThrow('no such editor');
  });
});

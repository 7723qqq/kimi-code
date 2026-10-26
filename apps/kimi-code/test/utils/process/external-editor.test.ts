import * as fsPromises from 'node:fs/promises';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
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
    const spawnEditor = mock((argv: string[]) => {
      const cmd = argv.at(-1) ?? '';
      // Extract the file path from the shell command (last argument after quoting).
      const match = cmd.match(/'([^']+prompt\.md)'/) || cmd.match(/"([^"]+prompt\.md)"/);
      const tmpFile = match![1]!;
      return { exited: writeFile(tmpFile, 'edited text', 'utf8').then(() => 0) };
    });

    await expect(
      editInExternalEditor('seed', 'code --wait', { spawn: spawnEditor }),
    ).resolves.toBe('edited text');
    expect(spawnEditor).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('code --wait')]),
      { stdio: ['inherit', 'inherit', 'inherit'], windowsVerbatimArguments: true },
    );
    expect(rmSpy).toHaveBeenCalled();
  });

  it('returns undefined when the editor exits non-zero', async () => {
    const spawnEditor = mock(() => ({ exited: Promise.resolve(1) }));

    await expect(
      editInExternalEditor('seed', 'false', { spawn: spawnEditor }),
    ).resolves.toBeUndefined();
  });

  it('rejects when the editor cannot be spawned', async () => {
    const spawnEditor = mock(() => ({
      exited: Promise.reject(new Error('no such editor')),
    }));

    await expect(editInExternalEditor('seed', 'nope', { spawn: spawnEditor })).rejects.toThrow(
      'no such editor',
    );
  });
});

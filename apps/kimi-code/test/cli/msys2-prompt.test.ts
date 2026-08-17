import { mkdtempSync, rmSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createMsys2PromptDeps,
  detectMsys2Bash,
  hasPrompted,
  installMsys2,
  markPrompted,
  MSYS2_BASH_CANDIDATES,
  MSYS2_PROMPT_MARKER,
  promptMarkerPath,
  setUserShellPath,
  shouldPromptMsys2,
  type Msys2PromptDeps,
} from '#/cli/msys2-prompt';

function makeDeps(overrides: Partial<Msys2PromptDeps> = {}): Msys2PromptDeps {
  return {
    platform: 'win32',
    homeDir: join(tmpdir(), 'msys2-prompt-test'),
    env: {},
    isFile: async () => false,
    writeTextFile: async () => {},
    resolveCommand: (cmd) =>
      cmd === 'winget'
        ? 'C:\\winget\\winget.exe'
        : cmd === 'setx'
          ? 'C:\\Windows\\System32\\setx.exe'
          : undefined,
    runCommand: async () => 0,
    runCommandSync: () => 0,
    ...overrides,
  };
}

describe('detectMsys2Bash', () => {
  it('returns undefined when no MSYS2 bash is available', async () => {
    const deps = makeDeps();
    expect(await detectMsys2Bash(deps)).toBeUndefined();
  });

  it('finds the default install path', async () => {
    const deps = makeDeps({
      isFile: async (path) => path === MSYS2_BASH_CANDIDATES[0],
    });
    expect(await detectMsys2Bash(deps)).toBe(MSYS2_BASH_CANDIDATES[0]);
  });

  it('treats KIMI_SHELL_PATH into an msys64 tree as installed', async () => {
    const deps = makeDeps({
      env: { KIMI_SHELL_PATH: 'C:\\msys64\\usr\\bin\\bash.exe' },
      isFile: async (path) => path === 'C:\\msys64\\usr\\bin\\bash.exe',
    });
    expect(await detectMsys2Bash(deps)).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('ignores a stale KIMI_SHELL_PATH whose file no longer exists', async () => {
    const deps = makeDeps({
      env: { KIMI_SHELL_PATH: 'C:\\msys64\\usr\\bin\\bash.exe' },
    });
    expect(await detectMsys2Bash(deps)).toBeUndefined();
  });

  it('ignores KIMI_SHELL_PATH that does not point into msys64', async () => {
    const deps = makeDeps({
      env: { KIMI_SHELL_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    });
    expect(await detectMsys2Bash(deps)).toBeUndefined();
  });
});

describe('prompt marker', () => {
  it('builds the marker path under the home dir', () => {
    expect(promptMarkerPath('/home/user')).toBe(join('/home/user', MSYS2_PROMPT_MARKER));
  });

  it('reports prompted only when the marker file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msys2-marker-'));
    try {
      const deps = makeDeps({
        homeDir: dir,
        isFile: async (path: string): Promise<boolean> => {
          try {
            await access(path);
            return true;
          } catch {
            return false;
          }
        },
        writeTextFile: (path: string, content: string) => writeFile(path, content, 'utf8'),
      });
      expect(await hasPrompted(deps)).toBe(false);
      await markPrompted(deps);
      expect(await hasPrompted(deps)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shouldPromptMsys2', () => {
  it('never prompts off Windows', async () => {
    const deps = makeDeps({ platform: 'linux' });
    expect(await shouldPromptMsys2(deps)).toBe(false);
  });

  it('does not prompt when MSYS2 is already installed', async () => {
    const deps = makeDeps({
      isFile: async (path) => path === MSYS2_BASH_CANDIDATES[0],
    });
    expect(await shouldPromptMsys2(deps)).toBe(false);
  });

  it('does not prompt when the marker exists', async () => {
    const deps = makeDeps({
      isFile: async (path) => path === promptMarkerPath(deps.homeDir),
    });
    expect(await shouldPromptMsys2(deps)).toBe(false);
  });

  it('prompts on Windows with no MSYS2 and no marker', async () => {
    const deps = makeDeps();
    expect(await shouldPromptMsys2(deps)).toBe(true);
  });
});

describe('installMsys2', () => {
  it('fails fast when winget cannot be resolved', async () => {
    const deps = makeDeps({ resolveCommand: () => undefined });
    const result = await installMsys2(deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('winget');
  });

  it('installs via winget and verifies the bash path', async () => {
    const runCommand = vi.fn(async () => 0);
    const deps = makeDeps({
      resolveCommand: (cmd) => (cmd === 'winget' ? 'C:\\winget\\winget.exe' : undefined),
      runCommand,
      isFile: async (path) => path === MSYS2_BASH_CANDIDATES[0],
    });
    const result = await installMsys2(deps);
    expect(result).toEqual({ ok: true, bashPath: MSYS2_BASH_CANDIDATES[0] });
    expect(runCommand).toHaveBeenCalledWith('C:\\winget\\winget.exe', [
      'install',
      'MSYS2.MSYS2',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ]);
  });

  it('reports a non-zero winget exit code', async () => {
    const deps = makeDeps({ runCommand: async () => 1 });
    const result = await installMsys2(deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('1');
  });

  it('reports when bash is still missing after a successful install', async () => {
    const deps = makeDeps({ runCommand: async () => 0 });
    const result = await installMsys2(deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bash.exe');
  });
});

describe('setUserShellPath', () => {
  it('returns false when setx cannot be resolved', () => {
    const deps = makeDeps({ resolveCommand: () => undefined });
    expect(setUserShellPath('C:\\msys64\\usr\\bin\\bash.exe', deps)).toBe(false);
  });

  it('runs setx with the shell path and reports success', () => {
    const runCommandSync = vi.fn(() => 0);
    const deps = makeDeps({
      resolveCommand: (cmd) => (cmd === 'setx' ? 'C:\\Windows\\System32\\setx.exe' : undefined),
      runCommandSync,
    });
    expect(setUserShellPath('C:\\msys64\\usr\\bin\\bash.exe', deps)).toBe(true);
    expect(runCommandSync).toHaveBeenCalledWith('C:\\Windows\\System32\\setx.exe', [
      'KIMI_SHELL_PATH',
      'C:\\msys64\\usr\\bin\\bash.exe',
    ]);
  });

  it('reports failure on a non-zero setx status', () => {
    const deps = makeDeps({
      resolveCommand: (cmd) => (cmd === 'setx' ? 'C:\\Windows\\System32\\setx.exe' : undefined),
      runCommandSync: () => 1,
    });
    expect(setUserShellPath('C:\\msys64\\usr\\bin\\bash.exe', deps)).toBe(false);
  });
});

describe('createMsys2PromptDeps', () => {
  it('honours an explicit homeDir', () => {
    const deps = createMsys2PromptDeps('/custom/home');
    expect(deps.homeDir).toBe('/custom/home');
  });
});

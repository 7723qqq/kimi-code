import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { probeShellPath } from '#/native/native-llm-resolver';

// `probeShellPath` mirrors the engine's own resolution
// (`packages/kimi-agent/src/native/shell.rs`, `resolve_shell`) on Windows:
// pwsh -> powershell -> Git Bash -> cmd. The same order is written twice, in
// two languages, and nothing makes the two halves fail together — if the host
// answers with Git Bash while the engine runs pwsh, the prompt's shell note
// disagrees with the shell the tool actually runs. This file pins the host half.
//
// It is its own file because it stubs `process.platform` and
// `node:child_process.spawnSync` for the whole module graph; inside
// `config.test.ts` that would reach the other suites sharing the file.
vi.mock('node:child_process', { spy: true });

const spawnSyncSpy = vi.mocked(spawnSync);

/** A `SpawnSyncReturns` carrying only the fields `whichOnPath` reads. */
const spawnResult = (status: number, stdout: string): ReturnType<typeof spawnSync> =>
  ({ status, stdout, stderr: '', signal: null }) as unknown as ReturnType<typeof spawnSync>;

const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Answer `where <name>` for exactly the names in `found`, in PATH order. */
function answerWhere(found: Record<string, string>): void {
  spawnSyncSpy.mockImplementation((_command, args) => {
    const name = Array.isArray(args) ? String(args[0]) : '';
    const hit = found[name];
    return hit === undefined ? spawnResult(1, '') : spawnResult(0, hit);
  });
}

const queried = (): string[] =>
  spawnSyncSpy.mock.calls.map(([, args]) => String((args as string[])[0]));

describe('probeShellPath', () => {
  beforeEach(() => {
    spawnSyncSpy.mockReset();
    delete process.env['KIMI_SHELL_PATH'];
    delete process.env['SHELL'];
  });

  afterEach(() => {
    if (PLATFORM) Object.defineProperty(process, 'platform', PLATFORM);
    delete process.env['KIMI_SHELL_PATH'];
    delete process.env['SHELL'];
  });

  it('lets KIMI_SHELL_PATH win without probing the platform', () => {
    setPlatform('win32');
    process.env['KIMI_SHELL_PATH'] = 'C:\\tools\\my-shell.exe';

    expect(probeShellPath()).toBe('C:\\tools\\my-shell.exe');
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  it('prefers pwsh over powershell', () => {
    setPlatform('win32');
    answerWhere({
      'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n',
      'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n',
    });

    expect(probeShellPath()).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(queried()).toEqual(['pwsh.exe']);
  });

  it('falls back to powershell when pwsh is absent, probing in that order', () => {
    setPlatform('win32');
    answerWhere({
      'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n',
    });

    expect(probeShellPath()).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(queried()).toEqual(['pwsh.exe', 'powershell.exe']);
  });

  it('takes the first non-empty line when where reports several hits', () => {
    setPlatform('win32');
    answerWhere({ 'pwsh.exe': '  \r\nC:\\first\\pwsh.exe\r\nC:\\second\\pwsh.exe\r\n' });

    expect(probeShellPath()).toBe('C:\\first\\pwsh.exe');
  });

  it('keeps probing past a non-zero where', () => {
    setPlatform('win32');
    answerWhere({});

    // The return value here depends on whether this machine has a Git Bash
    // candidate, so only the probe order is asserted: a failed `where` must
    // not end the search.
    probeShellPath();

    expect(queried()).toEqual(['pwsh.exe', 'powershell.exe']);
  });

  it('uses SHELL, or /bin/bash, off Windows', () => {
    setPlatform('linux');

    expect(probeShellPath()).toBe('/bin/bash');

    process.env['SHELL'] = '/usr/bin/zsh';
    expect(probeShellPath()).toBe('/usr/bin/zsh');
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });
});

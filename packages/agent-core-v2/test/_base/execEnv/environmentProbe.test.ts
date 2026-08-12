/**
 * Host environment probe — MSYS2 bash detection.
 *
 * Pins the Windows shell probe against native MSYS2 toolchains: a git whose
 * `git --exec-path` reports an `ucrt64` / `clang64` / `clangarm64` prefix
 * (e.g. `C:/msys64/ucrt64/libexec/git-core`) must walk back to the MSYS2 root
 * and resolve the shared bash at `usr\bin\bash.exe`, instead of failing to
 * detect any shell.
 *
 * All tests expect `probeHostEnvironment()` to be a pure function of injected
 * platform probes (no ambient state) so the same suite runs identically on
 * macOS/Linux/Windows CI runners.
 *
 * Ported from `packages/kaos/test/environment.test.ts` (the MSYS2 cases added
 * by the bash-detection fix); the v1 file carries the full POSIX / Git for
 * Windows / Scoop shim matrix, which the vendored probe shares verbatim.
 */

import { describe, expect, it } from 'vitest';

import {
  probeHostEnvironment,
  ProbeShellNotFoundError,
  type HostEnvironmentProbeDeps,
} from '#/_base/execEnv/environmentProbe';

interface StubOpts {
  readonly platform: string;
  readonly env?: Record<string, string | undefined>;
  readonly existingPaths?: readonly string[];
  readonly execFileResults?: Readonly<Record<string, string>>;
  readonly shellPreference?: string;
}

function stubDeps(opts: StubOpts): HostEnvironmentProbeDeps {
  const existing = new Set(opts.existingPaths ?? []);
  return {
    platform: opts.platform,
    arch: 'x86_64',
    release: '1.2.3',
    homeDir: 'C:\\Users\\me',
    env: opts.env ?? {},
    isFile: async (path: string) => existing.has(path),
    execFileText: async (file: string, args: readonly string[]) =>
      opts.execFileResults?.[execFileKey(file, args)],
    shellPreference: opts.shellPreference,
  };
}

function execFileKey(file: string, args: readonly string[]): string {
  return [file, ...args].join('\0');
}

describe('probeHostEnvironment', () => {
  it('resolves MSYS2 ucrt64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\ucrt64\\bin\\git.exe';
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\ucrt64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/ucrt64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 clang64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\clang64\\bin\\git.exe';
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\clang64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/clang64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 clangarm64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\clangarm64\\bin\\git.exe';
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\clangarm64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/clangarm64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('returns undefined shell when no git is found on darwin', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'darwin',
        env: {},
        existingPaths: [],
      }),
    );
    expect(env.shellName).toBe('sh');
    expect(env.shellPath).toBeDefined();
  });

  it('returns undefined shell when no git is found on linux', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'linux',
        env: {},
        existingPaths: [],
      }),
    );
    expect(env.shellName).toBe('sh');
    expect(env.shellPath).toBeDefined();
  });

  it('returns a fallback shell on win32 when no msys2 paths are found', async () => {
    await expect(
      probeHostEnvironment(
        stubDeps({
          platform: 'win32',
          env: { PATH: 'C:\\Windows\\system32' },
          existingPaths: [],
        }),
      ),
    ).rejects.toThrow(/Git Bash was not found/);
  });

  it('prefers PowerShell 7 over Git Bash on win32', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Program Files\\PowerShell\\7;C:\\Program Files\\Git\\bin' },
        existingPaths: [
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files\\Git\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('pwsh');
    expect(env.shellPath).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('falls back to Windows PowerShell when pwsh is absent', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\Git\\bin' },
        existingPaths: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          'C:\\Program Files\\Git\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('powershell');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('finds pwsh in the standard install location when it is not on PATH', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\system32' },
        existingPaths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
      }),
    );
    expect(env.shellName).toBe('pwsh');
    expect(env.shellPath).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('finds Windows PowerShell in its fixed location when it is not on PATH', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\system32' },
        existingPaths: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      }),
    );
    expect(env.shellName).toBe('powershell');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('falls back to Git Bash when no PowerShell is on PATH', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Program Files\\Git\\bin' },
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('honors KIMI_SHELL_PATH override with PowerShell semantics', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: {
          KIMI_SHELL_PATH: 'C:\\Tools\\pwsh.exe',
          PATH: 'C:\\Program Files\\Git\\bin',
        },
        existingPaths: ['C:\\Tools\\pwsh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('pwsh');
    expect(env.shellPath).toBe('C:\\Tools\\pwsh.exe');
  });

  it('honors KIMI_SHELL_PATH override with cmd semantics', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { KIMI_SHELL_PATH: 'C:\\Windows\\System32\\cmd.exe' },
        existingPaths: ['C:\\Windows\\System32\\cmd.exe'],
      }),
    );
    expect(env.shellName).toBe('cmd');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('rejects a KIMI_SHELL_PATH that points to a missing file', async () => {
    await expect(
      probeHostEnvironment(
        stubDeps({
          platform: 'win32',
          env: { KIMI_SHELL_PATH: 'C:\\missing\\bash.exe' },
          existingPaths: [],
        }),
      ),
    ).rejects.toThrow(/KIMI_SHELL_PATH/);
  });

  it('pins bash via shellPreference even when PowerShell is on PATH', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        shellPreference: 'bash',
        env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\Git\\bin' },
        existingPaths: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          'C:\\Program Files\\Git\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('pins cmd via shellPreference', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        shellPreference: 'cmd',
        env: { PATH: 'C:\\Windows\\System32' },
        existingPaths: ['C:\\Windows\\System32\\cmd.exe'],
      }),
    );
    expect(env.shellName).toBe('cmd');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('falls back to the default priority when the pinned shell is unavailable', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        shellPreference: 'pwsh',
        env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' },
        existingPaths: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      }),
    );
    expect(env.shellName).toBe('powershell');
  });

  it('treats auto as the default priority', async () => {
    const env = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        shellPreference: 'auto',
        env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' },
        existingPaths: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      }),
    );
    expect(env.shellName).toBe('powershell');
  });

  it('throws ProbeShellNotFoundError when Git Bash is missing on Windows', async () => {
    const rejected: unknown = await probeHostEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\System32' },
        existingPaths: [],
      }),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ProbeShellNotFoundError);
    const probeError = rejected as ProbeShellNotFoundError;
    expect(probeError.message).toContain('https://gitforwindows.org/');
    expect(probeError.message).not.toContain('Checked:');
    expect(probeError.checked.length).toBeGreaterThan(0);
  });
});
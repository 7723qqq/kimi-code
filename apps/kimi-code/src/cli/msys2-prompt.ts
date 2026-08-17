/**
 * `msys2Prompt` — MSYS2 detection and one-time install helpers (Windows only).
 *
 * Detects whether an MSYS2 bash is available (default install path, or
 * `KIMI_SHELL_PATH` pointing into an msys64 tree), tracks a one-time prompt
 * marker under the kimi home directory, and drives the `winget` install of
 * MSYS2 plus the `setx` user-environment switch. Pure helpers with injected
 * deps so the same suite runs on any host OS.
 */

import { spawn, spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { resolveCommandPath } from '#/utils/process/resolve-command';

export const MSYS2_BASH_CANDIDATES: readonly string[] = [
  'C:\\msys64\\usr\\bin\\bash.exe',
];

export const MSYS2_PROMPT_MARKER = 'msys2-prompted';

export interface Msys2PromptDeps {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly writeTextFile: (path: string, content: string) => Promise<void>;
  readonly resolveCommand: (command: string) => string | undefined;
  readonly runCommand: (cmd: string, args: readonly string[]) => Promise<number | undefined>;
  readonly runCommandSync: (cmd: string, args: readonly string[]) => number | undefined;
}

export function createMsys2PromptDeps(homeDir: string = resolveKimiHome()): Msys2PromptDeps {
  return {
    platform: process.platform,
    homeDir,
    env: process.env,
    isFile: async (path: string): Promise<boolean> => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    writeTextFile: (path: string, content: string) => writeFile(path, content, 'utf8'),
    resolveCommand: (command: string) => resolveCommandPath(command),
    runCommand: (cmd: string, args: readonly string[]) => runCommand(cmd, args),
    runCommandSync: (cmd: string, args: readonly string[]) =>
      spawnSync(cmd, [...args], { windowsHide: true }).status ?? undefined,
  };
}

/**
 * Locate an MSYS2 bash. `KIMI_SHELL_PATH` pointing into an msys64 tree counts
 * as installed (the user already switched) — but only when the file actually
 * exists, so a stale environment variable (MSYS2 uninstalled, path typo)
 * still triggers the prompt. Otherwise the default install path is probed.
 * Returns undefined when no MSYS2 bash is available.
 */
export async function detectMsys2Bash(deps: Msys2PromptDeps): Promise<string | undefined> {
  const override = deps.env['KIMI_SHELL_PATH']?.trim();
  if (override !== undefined && override.length > 0 && /msys64/i.test(override)) {
    if (await deps.isFile(override)) {
      return override;
    }
  }
  for (const candidate of MSYS2_BASH_CANDIDATES) {
    if (await deps.isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function promptMarkerPath(homeDir: string): string {
  return join(homeDir, MSYS2_PROMPT_MARKER);
}

export async function hasPrompted(deps: Msys2PromptDeps): Promise<boolean> {
  return deps.isFile(promptMarkerPath(deps.homeDir));
}

export async function markPrompted(deps: Msys2PromptDeps): Promise<void> {
  await deps.writeTextFile(promptMarkerPath(deps.homeDir), new Date().toISOString());
}

/**
 * Whether the one-time MSYS2 install prompt should be shown: Windows host,
 * no MSYS2 bash detected, and the prompt has not been shown before. A
 * non-empty `KIMI_SHELL_PATH` skips the prompt entirely — the user has
 * explicitly pinned a shell and should not be nagged.
 */
export async function shouldPromptMsys2(deps: Msys2PromptDeps): Promise<boolean> {
  if (deps.platform !== 'win32') return false;
  if ((deps.env['KIMI_SHELL_PATH'] ?? '').trim().length > 0) return false;
  if (await hasPrompted(deps)) return false;
  return (await detectMsys2Bash(deps)) === undefined;
}

export interface InstallMsys2Result {
  readonly ok: boolean;
  readonly bashPath?: string;
  readonly error?: string;
}

/**
 * Install MSYS2 through winget (silent, non-interactive) and verify the
 * resulting bash. Returns the verified bash path on success.
 */
export async function installMsys2(deps: Msys2PromptDeps): Promise<InstallMsys2Result> {
  const winget = deps.resolveCommand('winget');
  if (winget === undefined) {
    return { ok: false, error: 'winget not found' };
  }
  const exitCode = await deps.runCommand(winget, [
    'install',
    'MSYS2.MSYS2',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ]);
  if (exitCode !== 0) {
    return { ok: false, error: `winget exited with code ${String(exitCode)}` };
  }
  for (const candidate of MSYS2_BASH_CANDIDATES) {
    if (await deps.isFile(candidate)) {
      return { ok: true, bashPath: candidate };
    }
  }
  return { ok: false, error: 'MSYS2 installed but bash.exe was not found' };
}

/**
 * Persist `KIMI_SHELL_PATH` as a user environment variable via `setx` so new
 * processes (including the next kimi-code launch) pick up the MSYS2 shell.
 * Returns false when setx cannot be resolved or fails.
 */
export function setUserShellPath(bashPath: string, deps: Msys2PromptDeps): boolean {
  const setx = deps.resolveCommand('setx');
  if (setx === undefined) return false;
  const status = deps.runCommandSync(setx, ['KIMI_SHELL_PATH', bashPath]);
  return status === 0;
}

function runCommand(cmd: string, args: readonly string[]): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code ?? undefined));
  });
}

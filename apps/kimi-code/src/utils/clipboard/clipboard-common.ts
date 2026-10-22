import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { ClipboardModule } from './clipboard-native';

export type RunCommandOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };
export type RunCommand = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => { stdout: Buffer; ok: boolean };

/** Timer handle shape shared with `RenderTimerHandle` (`#/tui/utils/render-clock`). */
export interface CommandTimerHandle {
  unref?(): void;
}

/** Timer seam of `runCommandAsync`; structurally satisfied by `RenderClock` and
 *  `createFakeClock()`, so a test can drive the timeout without wall-clock waits. */
export interface CommandTimers {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): CommandTimerHandle;
  clearTimeout(handle: CommandTimerHandle): void;
}

export const SYSTEM_COMMAND_TIMERS: CommandTimers = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** The slice of a spawned child `runCommandAsync` drives, so a test can supply
 *  one without a real subprocess. */
export interface CommandChild {
  onStdoutData(listener: (chunk: Buffer) => void): void;
  onError(listener: () => void): void;
  onClose(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface CommandSpawnOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export type CommandSpawn = (
  command: string,
  args: string[],
  options: CommandSpawnOptions,
) => CommandChild;

export const SYSTEM_COMMAND_SPAWN: CommandSpawn = (command, args, options) => {
  const child = spawn(command, args, {
    env: options.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    onStdoutData: (listener) => {
      child.stdout?.on('data', listener);
    },
    onError: (listener) => {
      child.on('error', listener);
    },
    onClose: (listener) => {
      child.on('close', listener);
    },
    kill: () => {
      child.kill();
    },
  };
};

export interface RunCommandAsyncOptions extends RunCommandOptions {
  readonly timers?: CommandTimers;
  readonly spawn?: CommandSpawn;
}

export type RunCommandAsync = (
  command: string,
  args: string[],
  options?: RunCommandAsyncOptions,
) => Promise<{ stdout: Buffer; ok: boolean }>;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const DEFAULT_LIST_TIMEOUT_MS = 1000;
export const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function baseMimeType(raw: string): string {
  return raw.split(';')[0]?.trim().toLowerCase() ?? raw.toLowerCase();
}

export function isSupportedImageMimeType(mime: string): boolean {
  const base = baseMimeType(mime);
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base);
}

export function parseTargetList(output: Buffer): string[] {
  return output
    .toString('utf-8')
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function runCommand(
  command: string,
  args: string[],
  options?: RunCommandOptions,
): { stdout: Buffer; ok: boolean } {
  const result = spawnSync(command, args, {
    timeout: options?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
    env: options?.env,
  });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  return { ok: true, stdout };
}

/**
 * Non-blocking counterpart of `runCommand`. Used by the clipboard image probe
 * on the startup path so a slow or wedged helper (notably `powershell.exe` on
 * WSL, or a stuck `wl-paste`/`xclip`) cannot freeze the event loop. The child
 * is killed and the promise resolves with `ok: false` once `timeoutMs` elapses
 * or the captured stdout exceeds `DEFAULT_MAX_BUFFER_BYTES`.
 */
export function runCommandAsync(
  command: string,
  args: string[],
  options?: RunCommandAsyncOptions,
): Promise<{ stdout: Buffer; ok: boolean }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const timers = options?.timers ?? SYSTEM_COMMAND_TIMERS;
  const spawnChild = options?.spawn ?? SYSTEM_COMMAND_SPAWN;
  return new Promise((resolve) => {
    let child: CommandChild;
    try {
      child = spawnChild(command, args, { env: options?.env });
    } catch {
      resolve({ ok: false, stdout: Buffer.alloc(0) });
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timer: CommandTimerHandle | undefined;

    // Marks the promise as settled and clears the timeout. Returns true only for
    // the first caller, so each event handler below resolves at most once.
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      return true;
    };

    timer = timers.setTimeout(() => {
      child.kill();
      if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
    }, timeoutMs);

    child.onStdoutData((chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > DEFAULT_MAX_BUFFER_BYTES) {
        child.kill();
        if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
        return;
      }
      chunks.push(chunk);
    });

    child.onError(() => {
      if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
    });

    child.onClose((code) => {
      if (code !== 0) {
        if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
        return;
      }
      if (claim()) resolve({ ok: true, stdout: Buffer.concat(chunks) });
    });
  });
}

export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WAYLAND_DISPLAY']) || env['XDG_SESSION_TYPE'] === 'wayland';
}

export function isWSL(env: NodeJS.ProcessEnv): boolean {
  if (env['WSL_DISTRO_NAME'] !== undefined || env['WSLENV'] !== undefined) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

export function isFileLikeNativeFormat(format: string): boolean {
  const f = format.toLowerCase();
  const base = baseMimeType(format);
  return (
    f.includes('file-url') ||
    f.includes('file url') ||
    f.includes('nsfilenames') ||
    f.includes('com.apple.finder') ||
    base === 'text/uri-list' ||
    base === 'public.url'
  );
}

export function safeAvailableFormats(clip: ClipboardModule | null): string[] {
  if (clip?.availableFormats === undefined) return [];
  try {
    return clip.availableFormats();
  } catch {
    return [];
  }
}

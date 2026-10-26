import { t } from '#/i18n';

import { clipboard, type ClipboardModule } from './clipboard-native';
import { writeClipboardOSC52 } from './clipboard-osc52';

/**
 * Hard upper bound for a one-shot clipboard write helper. The probe path uses
 * 1 s (`DEFAULT_LIST_TIMEOUT_MS`), which is too tight for a write carrying a
 * full payload, but 5 s still bounds it: without a timeout the parent waits for
 * the child's stdout to close, and `wl-copy`/`xclip` daemonize into a process
 * that inherits that pipe — the CLI then hangs with no output at all.
 */
const CLIPBOARD_WRITE_TIMEOUT_MS = 5000;

export interface ClipboardWriteOptions {
  readonly input: string;
  readonly timeoutMs: number;
}

export interface ClipboardWriteResult {
  readonly error?: Error | undefined;
  readonly status: number | null;
  readonly stderr: string;
}

export type ClipboardWriteRun = (
  command: string,
  args: readonly string[],
  options: ClipboardWriteOptions,
) => ClipboardWriteResult;

export interface CopyTextDeps {
  readonly clipboard: ClipboardModule | null;
  readonly platform: NodeJS.Platform;
  readonly run: ClipboardWriteRun;
  readonly osc52: (text: string) => boolean;
}

export function createCopyTextDeps(overrides: Partial<CopyTextDeps> = {}): CopyTextDeps {
  return {
    clipboard,
    platform: process.platform,
    run: (command, args, options) => {
      try {
        const result = Bun.spawnSync({
          cmd: [command, ...args],
          stdin:
            options.input === undefined ? 'ignore' : Buffer.from(options.input, 'utf8'),
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: options.timeoutMs,
        });
        return {
          error: result.exitedDueToTimeout
            ? new Error(`${command} timed out after ${String(options.timeoutMs)}ms`)
            : undefined,
          status: result.exitCode,
          stderr: result.stderr === undefined ? '' : new TextDecoder().decode(result.stderr),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(String(error)),
          status: null,
          stderr: '',
        };
      }
    },
    osc52: (text) => writeClipboardOSC52(text),
    ...overrides,
  };
}

function runClipboardCommand(
  deps: CopyTextDeps,
  command: string,
  args: readonly string[],
  input: string,
): void {
  const result = deps.run(command, args, {
    input,
    timeoutMs: CLIPBOARD_WRITE_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;

  const detail = result.stderr.trim();
  throw new Error(
    detail.length > 0
      ? `${command} exited with code ${String(result.status)}: ${detail}`
      : `${command} exited with code ${String(result.status)}`,
  );
}

async function copyWithPlatformCommand(deps: CopyTextDeps, text: string): Promise<void> {
  const commands =
    deps.platform === 'darwin'
      ? [{ command: 'pbcopy', args: [] as string[] }]
      : deps.platform === 'win32'
        ? [{ command: 'clip.exe', args: [] as string[] }]
        : [
            { command: 'wl-copy', args: [] as string[] },
            { command: 'xclip', args: ['-selection', 'clipboard'] },
          ];

  let lastError: unknown;
  for (const candidate of commands) {
    try {
      runClipboardCommand(deps, candidate.command, candidate.args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(t('tui.statusMessages.noClipboardCommandAvailable'));
}

/** How the text was delivered: a verified local clipboard tool, or an
 *  unverified OSC 52 escape emitted to the terminal as a last resort. */
export type ClipboardCopyMethod = 'native' | 'osc52';

export async function copyTextToClipboard(
  text: string,
  overrides: Partial<CopyTextDeps> = {},
): Promise<ClipboardCopyMethod> {
  const deps = createCopyTextDeps(overrides);

  // OSC 52 travels over stdout to the local terminal emulator, so it reaches
  // the clipboard even over SSH or in containers with no native clipboard
  // tool. Emit it up front; every failure path below can fall back on it.
  const osc52Emitted = deps.osc52(text);

  const clipboardModule = deps.clipboard;
  if (clipboardModule?.setText !== undefined) {
    try {
      await clipboardModule.setText(text);
      return 'native';
    } catch {
      // Fall back to platform clipboard commands below.
    }
  }

  try {
    await copyWithPlatformCommand(deps, text);
    return 'native';
  } catch (error) {
    // The native clipboard is unreachable (headless server, SSH session,
    // missing wl-copy/xclip …) but the terminal may still have delivered the
    // text via OSC 52; without a terminal there is nothing left to try.
    if (osc52Emitted) return 'osc52';
    throw error;
  }
}

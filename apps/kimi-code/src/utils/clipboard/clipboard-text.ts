import { t } from '#/i18n';
import { resolveCommandPath } from '#/utils/process/resolve-command';
import { SYSTEM_RENDER_CLOCK, type RenderClock } from '#/utils/render-clock';

import { isWaylandSession, isWSL } from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';
import { writeClipboardOSC52 } from './clipboard-osc52';

/**
 * Hard upper bound for a one-shot clipboard write helper. `wl-copy`/`xclip`
 * daemonize into a process that inherits their stdout, so without a bound the
 * parent can wait forever; the helper is killed when the bound elapses.
 */
export const CLIPBOARD_COMMAND_TIMEOUT_MS = 5000;

export type ClipboardCopyMethod = 'native' | 'osc52';

export interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ClipboardWritePlan {
  readonly nativeModule: boolean;
  readonly commands: readonly ClipboardCommand[];
  readonly osc52: 'always' | 'fallback' | 'never';
  readonly unavailableMessage: string;
}

interface UnixClipboardBackend {
  readonly present: (env: NodeJS.ProcessEnv) => boolean;
  readonly commands: readonly ClipboardCommand[];
  readonly unavailableMessage: () => string;
}

const UNIX_CLIPBOARD_BACKENDS: readonly UnixClipboardBackend[] = [
  {
    present: (env) => Boolean(env['TERMUX_VERSION']),
    commands: [{ command: 'termux-clipboard-set', args: [] }],
    unavailableMessage: () => t('tui.statusMessages.clipboardUnavailableTermux'),
  },
  {
    present: isWaylandSession,
    commands: [{ command: 'wl-copy', args: [] }],
    unavailableMessage: () => t('tui.statusMessages.clipboardUnavailableWayland'),
  },
  {
    present: (env) => Boolean(env['DISPLAY']),
    commands: [
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ],
    unavailableMessage: () => t('tui.statusMessages.clipboardUnavailableX11'),
  },
];

const REMOTE_SESSION_ENV = ['SSH_CONNECTION', 'SSH_CLIENT', 'MOSH_CONNECTION'];

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return REMOTE_SESSION_ENV.some((name) => Boolean(env[name]));
}

export function planClipboardWrite(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ClipboardWritePlan {
  const forceOSC52 = isRemoteSession(env) || env['KIMI_CODE_CLIPBOARD_OSC52'] === '1';
  if (platform === 'darwin' || platform === 'win32') {
    return {
      nativeModule: true,
      commands: [{ command: platform === 'darwin' ? 'pbcopy' : 'clip.exe', args: [] }],
      osc52: forceOSC52 ? 'always' : 'never',
      unavailableMessage: t('tui.statusMessages.clipboardUnavailable'),
    };
  }
  const backends = UNIX_CLIPBOARD_BACKENDS.filter((backend) => backend.present(env));
  // Linux desktop terminals such as GNOME Terminal ignore OSC 52, so it only
  // backs up a missing tool where no display exists or the terminal (Windows
  // Terminal under WSL, Termux) is known to honor it.
  const osc52Fallback =
    backends.length === 0 || Boolean(env['TERMUX_VERSION']) || (platform === 'linux' && isWSL(env));
  return {
    // The native module reports success on Linux without holding the X11
    // selection, which leaves the clipboard empty; the CLI tools keep it.
    nativeModule: platform !== 'linux',
    commands: backends.flatMap((backend) => backend.commands),
    osc52: forceOSC52 ? 'always' : osc52Fallback ? 'fallback' : 'never',
    unavailableMessage: backends[0]?.unavailableMessage() ?? t('tui.statusMessages.clipboardUnavailable'),
  };
}

export interface ClipboardChild {
  readonly exited: Promise<number>;
  readonly stdin:
    | { write(data: string): unknown; end(): unknown; destroy?(): void }
    | undefined;
  kill(signal?: string): void;
}

export type ClipboardSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly detached: boolean },
) => ClipboardChild;

const spawnClipboardProcess: ClipboardSpawn = (command, args, options) => {
  // Writers such as xclip fork a child that keeps owning the selection. Give
  // it no output pipes to hold open, and on POSIX a session of its own so
  // closing the terminal does not SIGHUP it and empty the clipboard.
  const child = Bun.spawn({
    cmd: [command, ...args],
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
    cwd: options.cwd,
    detached: options.detached,
    windowsHide: true,
  });
  return {
    exited: child.exited,
    stdin: child.stdin as ClipboardChild['stdin'],
    kill: (signal) => {
      try {
        child.kill(signal as Parameters<typeof child.kill>[0]);
      } catch {
        // already gone
      }
    },
  };
};

export interface CopyTextDeps {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly clipboard: ClipboardModule | null;
  readonly osc52: (text: string) => boolean;
  readonly resolveCommand: (command: string) => string | undefined;
  readonly spawn: ClipboardSpawn;
  readonly clock: Pick<RenderClock, 'setTimeout' | 'clearTimeout'>;
}

export function createCopyTextDeps(overrides: Partial<CopyTextDeps> = {}): CopyTextDeps {
  return {
    platform: process.platform,
    env: process.env,
    clipboard,
    osc52: (text) => writeClipboardOSC52(text),
    resolveCommand: (command) => resolveCommandPath(command),
    spawn: spawnClipboardProcess,
    clock: SYSTEM_RENDER_CLOCK,
    ...overrides,
  };
}

function runClipboardCommand(
  deps: CopyTextDeps,
  command: string,
  args: readonly string[],
  input: string,
): Promise<boolean> {
  // A fullscreen selection can be copied before the workspace trust prompt is
  // answered, so a writer planted in the workspace must never run.
  const executable = deps.resolveCommand(command);
  if (executable === undefined) return Promise.resolve(false);

  return new Promise((resolve) => {
    let child: ClipboardChild;
    try {
      child = deps.spawn(executable, args, {
        cwd: '/',
        detached: deps.platform !== 'win32',
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      deps.clock.clearTimeout(timer);
      return true;
    };
    const timer = deps.clock.setTimeout(() => {
      child.stdin?.destroy?.();
      child.kill('SIGKILL');
      if (claim()) resolve(false);
    }, CLIPBOARD_COMMAND_TIMEOUT_MS);
    child.exited.then(
      (code) => {
        if (claim()) resolve(code === 0);
      },
      () => {
        if (claim()) resolve(false);
      },
    );
    // A writer may exit before consuming all of its input.
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** How the text was delivered: a verified local clipboard tool, or an
 *  unverified OSC 52 escape emitted to the terminal as a last resort. */
export async function copyTextToClipboard(
  text: string,
  overrides: Partial<CopyTextDeps> = {},
): Promise<ClipboardCopyMethod> {
  const deps = createCopyTextDeps(overrides);
  const plan = planClipboardWrite(deps.platform, deps.env);
  // Sent before the system clipboard is tried, so a stuck writer cannot hold it up.
  const osc52Sent = plan.osc52 === 'always' && deps.osc52(text);

  let copied = false;
  if (plan.nativeModule && deps.clipboard?.setText !== undefined) {
    try {
      await deps.clipboard.setText(text);
      copied = true;
    } catch {
      // Fall back to the platform clipboard commands below.
    }
  }
  for (const { command, args } of plan.commands) {
    if (copied) break;
    copied = await runClipboardCommand(deps, command, args, text);
  }

  if (copied) return 'native';
  if (osc52Sent || (plan.osc52 === 'fallback' && deps.osc52(text))) return 'osc52';
  throw new Error(plan.unavailableMessage);
}

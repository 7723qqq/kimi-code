import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
}

export function openFileCommandFor(
  absolutePath: string,
  line?: number,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): LaunchCommand {
  const editor = resolveEditorCommand(env);
  if (editor !== undefined) {
    const target = supportsLineTarget(editor) && line !== undefined
      ? `${absolutePath}:${line}`
      : absolutePath;
    // Parse the editor into binary + args to avoid shell injection from
    // uncontrolled environment variable values (KIMI_CODE_EDITOR / VISUAL / EDITOR).
    // If the editor is a simple single binary, pass it directly to spawn with
    // the target as an argument. For editors with embedded spaces or flags
    // (e.g. 'code --goto'), split into argv. Escaped paths are rare for
    // editor env vars; fall back to platform default if parsing is ambiguous.
    const editorBin = editor.trim().split(/\s+/)[0];
    const editorArgs = editor.trim().split(/\s+/).slice(1);
    if (editorBin !== undefined && editorBin.length > 0) {
      return { command: editorBin, args: [...editorArgs, target] };
    }
    // Empty editor string — fall through to platform default.
  }

  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [absolutePath] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '""', absolutePath] };
    default:
      return { command: 'xdg-open', args: [absolutePath] };
  }
}

export function revealFileCommandFor(
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): LaunchCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', absolutePath] };
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${absolutePath}`] };
    default:
      return { command: 'xdg-open', args: [path.dirname(absolutePath)] };
  }
}

export type OpenInAppId =
  | 'finder'
  | 'cursor'
  | 'vscode'
  | 'iterm'
  | 'terminal';

export const OPEN_IN_APP_IDS: readonly OpenInAppId[] = [
  'finder',
  'cursor',
  'vscode',
  'iterm',
  'terminal',
];

export interface OpenInAppOptions {
  readonly line?: number;
  readonly isDirectory?: boolean;
}

export function openInAppCommandFor(
  appId: OpenInAppId,
  absolutePath: string,
  options: OpenInAppOptions = {},
  platform: NodeJS.Platform = process.platform,
): LaunchCommand {
  switch (appId) {
    case 'vscode':
      return openInVsCodeLike('code', absolutePath, options.line, platform);
    case 'cursor':
      return openInVsCodeLike('cursor', absolutePath, options.line, platform);
    case 'finder':
      return openInFinder(absolutePath, options.isDirectory, platform);
    case 'iterm':
      return openInMacApp('iTerm', absolutePath, platform);
    case 'terminal':
      return openInMacApp('Terminal', absolutePath, platform);
  }
}

export function getAvailableOpenInApps(
  platform: NodeJS.Platform = process.platform,
): readonly OpenInAppId[] {
  return OPEN_IN_APP_IDS.filter((appId) => isOpenInAppAvailable(appId, platform));
}

function isOpenInAppAvailable(
  appId: OpenInAppId,
  platform: NodeJS.Platform,
): boolean {
  switch (appId) {
    case 'finder':
    case 'terminal':
      return platform === 'darwin';
    case 'iterm':
      if (platform !== 'darwin') return false;
      return (
        existsSync('/Applications/iTerm.app') ||
        existsSync(`${process.env['HOME'] ?? ''}/Applications/iTerm.app`)
      );
    case 'vscode':
      return commandExists('code', platform);
    case 'cursor':
      return commandExists('cursor', platform);
  }
}

function commandExists(command: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'win32') {
      const result = spawnSync('cmd', ['/c', 'where', command], {
        stdio: 'ignore',
      });
      return result.status === 0;
    }
    const result = spawnSync('command', ['-v', command], {
      stdio: 'ignore',
      shell: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function openInVsCodeLike(
  binary: string,
  absolutePath: string,
  line: number | undefined,
  _platform: NodeJS.Platform,
): LaunchCommand {
  const target = line !== undefined ? `${absolutePath}:${line}` : absolutePath;
  const args = line !== undefined ? ['-g', target] : [target];
  return { command: binary, args };
}

function openInFinder(
  absolutePath: string,
  isDirectory: boolean | undefined,
  platform: NodeJS.Platform,
): LaunchCommand {
  switch (platform) {
    case 'darwin':
      return isDirectory
        ? { command: 'open', args: [absolutePath] }
        : { command: 'open', args: ['-R', absolutePath] };
    case 'win32':
      return isDirectory
        ? { command: 'explorer.exe', args: [absolutePath] }
        : { command: 'explorer.exe', args: [`/select,${absolutePath}`] };
    default:
      return {
        command: 'xdg-open',
        args: [isDirectory ? absolutePath : path.dirname(absolutePath)],
      };
  }
}

function openInMacApp(
  appName: string,
  absolutePath: string,
  platform: NodeJS.Platform,
): LaunchCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', appName, absolutePath] };
  }
  // These apps are macOS-only in the UI; fall back to the platform default.
  return openFileCommandFor(absolutePath, undefined, process.env, platform);
}

export async function launchDetached(cmd: LaunchCommand): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd.command, cmd.args, {
      detached: true,
      stdio: 'ignore',
      shell: cmd.shell,
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

function resolveEditorCommand(env: Record<string, string | undefined>): string | undefined {
  for (const key of ['KIMI_CODE_EDITOR', 'VISUAL', 'EDITOR']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function supportsLineTarget(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return /(?:^|\/)(code|cursor|windsurf)(?:\.cmd|\.exe)?$/i.test(first);
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

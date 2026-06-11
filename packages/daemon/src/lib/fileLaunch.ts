import { spawn } from 'node:child_process';
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
    return {
      command: `${editor} ${quoteShellArg(target, platform)}`,
      args: [],
      shell: true,
    };
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

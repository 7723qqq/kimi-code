import { execFile } from 'node:child_process';

import { resolveCommandPath } from '#/utils/process/resolve-command';

export interface OpenUrlDeps {
  readonly platform?: NodeJS.Platform;
  readonly resolveCommandPath?: (command: string) => string | undefined;
  readonly execFile?: (
    file: string,
    args: string[],
    options: { windowsHide: boolean },
    callback: (error: Error | null) => void,
  ) => unknown;
}

export function openUrl(
  url: string,
  onError?: (error: Error) => void,
  deps: OpenUrlDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const resolve = deps.resolveCommandPath ?? resolveCommandPath;
  const run = deps.execFile ?? execFile;
  const command: [string, string[]] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
          `try { Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop } catch { exit 1 }`,
          'utf16le',
        ).toString('base64')]]
        : ['xdg-open', [url]];
  const executable = resolve(command[0]);
  if (executable === undefined) {
    onError?.(new Error(`Cannot find ${command[0]}`));
    return;
  }
  run(executable, command[1], { windowsHide: true }, (error) => {
    if (error) onError?.(error);
  });
}

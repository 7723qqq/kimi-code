import { resolveCommandPath } from '#/utils/process/resolve-command';

export interface OpenUrlDeps {
  readonly platform?: NodeJS.Platform;
  readonly resolveCommandPath?: (command: string) => string | undefined;
  readonly spawn?: (
    argv: string[],
    options: { windowsHide: boolean; stdio: ['ignore', 'ignore', 'ignore'] },
  ) => { readonly exited: Promise<number> };
}

export function openUrl(
  url: string,
  onError?: (error: Error) => void,
  deps: OpenUrlDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  const resolve = deps.resolveCommandPath ?? resolveCommandPath;
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn({ cmd: argv, ...options }));
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
  try {
    const child = spawn([executable, ...command[1]], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.exited.then(
      (code) => {
        if (code !== 0) onError?.(new Error(`${command[0]} exited with code ${String(code)}`));
      },
      (error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      },
    );
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

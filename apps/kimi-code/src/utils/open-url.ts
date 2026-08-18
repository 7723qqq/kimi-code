import { execFile } from 'node:child_process';

function openWithSystem(target: string): void {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
  execFile(command[0], command[1], () => {});
}

/** Open an http(s) or file:// URL with the system default handler. */
export function openUrl(url: string): void {
  if (!/^(https?|file):\/\//i.test(url)) return;
  const target = url.startsWith('file://') ? decodeURIComponent(url.slice('file://'.length)) : url;
  openWithSystem(target);
}

/** Open a local file path with the system default handler. */
export function openFile(path: string): void {
  openWithSystem(path);
}

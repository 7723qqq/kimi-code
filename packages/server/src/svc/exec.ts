/**
 * Promisified `child_process.execFile` for the OS service backends.
 *
 * Each backend (launchd / systemd / schtasks) shells out to a platform binary
 * to install or query its service definition. They all want the same thing:
 * stdout, stderr, and an exit code — with no thrown exception on non-zero —
 * so the caller can branch on `result.code` and surface a clean error.
 *
 * Mirrors openclaw's pattern from
 * `../openclaw/src/daemon/exec-file.ts` but trimmed to one helper.
 */

import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  /** Suppress the Windows shell window when spawning. Forwarded verbatim. */
  windowsHide?: boolean;
  /** Optional timeout, in ms. Forwarded to Node's execFile. */
  timeoutMs?: number;
  /** Override the spawn env (mostly used by tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `file argv…` and resolve with stdout / stderr / exit code.
 *
 * Never rejects on a non-zero exit — callers branch on `code`. Spawn errors
 * (ENOENT for the binary, EACCES, etc.) are surfaced as `code: -1` with the
 * message in `stderr` so callers can render a single uniform diagnostic.
 */
export function execFileUtf8(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        windowsHide: options.windowsHide === true,
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        env: options.env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        // Node sets `code` on the error for non-zero exits; for spawn failures
        // (ENOENT, EACCES) the code property is a string like "ENOENT".
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1;
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : message,
          code,
        });
      },
    );
  });
}
